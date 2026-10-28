// -----------------------------------------------------------------------------
// The varserver API of one PVS, ported from pypvs (MIT, SunStrong Management;
// see THIRD_PARTY_NOTICES.md) and its "LocalAPI" document:
//
//   GET /auth?login           `Authorization: basic base64(ssm_owner:<password>)`
//                             -> a `session` cookie
//   GET /vars?name=a,b,c      the variables named, with the cookie
//   GET /vars?match=<prefix>  every variable under a prefix, with the cookie
//
// Read only: `/vars?set=` is never sent, nor any other path. The old
// installer API (`dl_cgi`) is never used.
//
// The password is the one typed, or, when none is, the last 5 characters of
// the serial number the PVS gives (`/sys/info/serialnum`, read once per
// client, before any session: SunStrong's rule, as pypvs does). The serial
// number and the password stay in private fields of this object: never in a
// log, an error, a status or /data.
//
// The session is kept and used again. Variables refused (401, 403) or a 500
// (pypvs: an expired session) with a session used before open a new session
// once in the same read. A login refused (401/403 on /auth?login) is a refusal
// of the password; variables refused right after a new login are not
// (CODES.ACCESS). Every request goes through `checkPeer` (src/pvs/http.js).
// -----------------------------------------------------------------------------

import {
  DERIVED_PASSWORD_LENGTH,
  MATCH_BYTES,
  MAX_VALUES,
  PATHS,
  REQUEST_TIMEOUT,
  SMALL_BYTES,
  USERNAME,
  VAR_SERIAL,
} from '../constants.js';
import { CODES, PvsError } from './errors.js';
import { httpsGet } from './http.js';

/** A cookie value we may send back: printable ASCII, no `;`, bounded. */
const TOKEN = /^[\x21-\x3a\x3c-\x7e]{1,512}$/;
/** A variable name of the varserver (pypvs, the CSV lists of the repository). */
const VAR_NAME = /^\/[A-Za-z0-9_./-]{1,200}$/;
/** A serial number we may take the password from. */
const SERIAL = /^[A-Za-z0-9]{5,64}$/;

/** The Retry-After of an answer, in ms (seconds only), or undefined. */
function retryAfterOf(headers) {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

/** The time of the PVS from the `Date` header of an answer (ms), or undefined. */
export function dateOf(headers) {
  const value = headers?.date;
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** The `session` cookie of a login answer (`session=<value>`), or null. */
export function sessionCookieOf(headers, body) {
  const list = headers?.['set-cookie'];
  for (const line of Array.isArray(list) ? list : typeof list === 'string' ? [list] : []) {
    const pair = String(line).split(';', 1)[0];
    const at = pair.indexOf('=');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (name === 'session' && TOKEN.test(value)) return `session=${value}`;
  }
  // The LocalAPI document shows the session in the body too: taken as the cookie.
  try {
    const json = JSON.parse(body.toString('utf8'));
    const value = typeof json?.session === 'string' ? json.session.trim() : '';
    if (TOKEN.test(value)) return `session=${value}`;
  } catch {
    // No JSON body: no session.
  }
  return null;
}

/**
 * The variables of a `/vars` answer (`{ values: [{ name, value }], count }`)
 * as a Map name -> value (a string, a number, a boolean or null). Bounded;
 * an entry of another shape is skipped (never a prototype key: a Map).
 */
export function parseVars(body) {
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new PvsError(CODES.BAD_ANSWER, 'The answer is not JSON');
  }
  const values = json?.values;
  if (!Array.isArray(values)) {
    throw new PvsError(CODES.BAD_ANSWER, 'Not a varserver answer');
  }
  if (values.length > MAX_VALUES) {
    throw new PvsError(CODES.TOO_LARGE, `More than ${MAX_VALUES} variables`);
  }
  const out = new Map();
  for (const item of values) {
    const name = item?.name;
    if (typeof name !== 'string' || !VAR_NAME.test(name)) continue;
    const value = item.value;
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= 512)
    ) {
      out.set(name, value);
    }
  }
  return out;
}

export class PvsClient {
  #password;
  #serial;
  /** `session=<value>` of the open session, or null. */
  #cookie = null;

  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} [options.password] typed by the user; '' -> made from the serial number
   * @param {(fingerprint: string) => Promise<void>|void} options.checkPeer
   * @param {Function} [options.request] the transport (tests inject a fake PVS)
   */
  constructor({ host, port, password = '', checkPeer, request = httpsGet }) {
    this.target = { host, port };
    this.#password = password;
    this.typed = password !== '';
    this.checkPeer = checkPeer;
    this.request = request;
  }

  /**
   * Whether `text` holds the password in use (any case): a text that does is
   * never published nor kept (an id made of a serial number, say).
   */
  holdsSecret(text) {
    const secret = this.#password || this.#derived();
    return Boolean(secret) && String(text).toLowerCase().includes(secret.toLowerCase());
  }

  #derived() {
    return this.#serial ? this.#serial.slice(-DERIVED_PASSWORD_LENGTH) : '';
  }

  close() {
    this.#cookie = null;
  }

  async send(path, { cookie, authorization, maxBytes, timeout }) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (authorization) headers.authorization = authorization;
    return this.request(
      { ...this.target, path },
      {
        headers,
        maxBytes,
        timeout: Math.max(1, Math.min(timeout ?? REQUEST_TIMEOUT, REQUEST_TIMEOUT)),
        checkPeer: this.checkPeer,
      },
    );
  }

  /** An answer that is not a success: the matching PvsError. */
  static failure(res, what) {
    const status = res.status;
    if (status >= 300 && status < 400) {
      return new PvsError(CODES.REDIRECT, `${what}: redirected (HTTP ${status})`, { status });
    }
    if (status === 429) {
      return new PvsError(CODES.RATE_LIMITED, `${what}: HTTP 429`, {
        status,
        retryAfter: retryAfterOf(res.headers),
      });
    }
    if (status >= 500 && status < 600) {
      return new PvsError(CODES.SERVER, `${what}: HTTP ${status}`, {
        status,
        retryAfter: retryAfterOf(res.headers),
      });
    }
    return new PvsError(CODES.HTTP, `${what}: HTTP ${status}`, { status });
  }

  /** The serial number, read without a session (only to make the password). */
  async #readSerial(timeout) {
    const res = await this.send(`${PATHS.VARS}?name=${VAR_SERIAL}`, {
      maxBytes: SMALL_BYTES,
      timeout,
    });
    // fcgi_vars answers 400 when the user may read none of the variables
    // asked (401 only for an invalid cookie): any 4xx but 429 means the PVS
    // does not give its serial number without a session (review r1, I2).
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new PvsError(CODES.NO_SERIAL, `Serial number refused without a session`, {
        status: res.status,
      });
    }
    if (res.status !== 200) throw PvsClient.failure(res, 'Serial number');
    let value;
    try {
      value = parseVars(res.body).get(VAR_SERIAL);
    } catch {
      value = undefined;
    }
    const serial = typeof value === 'string' ? value.trim() : '';
    if (!SERIAL.test(serial)) {
      throw new PvsError(CODES.NO_SERIAL, 'No serial number in the answer');
    }
    this.#serial = serial;
  }

  /** Opens a session. Throws CODES.CREDENTIALS on a refusal. */
  async login({ timeout } = {}) {
    this.#cookie = null;
    if (!this.typed && !this.#serial) {
      await this.#readSerial(timeout);
    }
    const password = this.typed ? this.#password : this.#derived();
    const basic = Buffer.from(`${USERNAME}:${password}`, 'utf8').toString('base64');
    const res = await this.send(PATHS.LOGIN, {
      authorization: `basic ${basic}`,
      maxBytes: SMALL_BYTES,
      timeout,
    });
    if (res.status === 401 || res.status === 403) {
      throw new PvsError(CODES.CREDENTIALS, `Login refused (HTTP ${res.status})`, {
        status: res.status,
        derived: !this.typed,
      });
    }
    if (res.status !== 200) throw PvsClient.failure(res, 'Login');
    const cookie = sessionCookieOf(res.headers, res.body);
    if (!cookie) throw new PvsError(CODES.BAD_ANSWER, 'No session cookie');
    this.#cookie = cookie;
  }

  /**
   * One `/vars` query on a session (opened when none is; opened again once
   * when the PVS refuses it). Resolves `{ vars: Map, date }`, `date` the
   * clock of the PVS (its Date header) when it gives one.
   */
  async vars(query, { maxBytes = SMALL_BYTES, timeLeft = () => REQUEST_TIMEOUT } = {}) {
    let fresh = false;
    if (!this.#cookie) {
      await this.login({ timeout: timeLeft() });
      fresh = true;
    }
    for (;;) {
      const res = await this.send(`${PATHS.VARS}?${query}`, {
        cookie: this.#cookie,
        maxBytes,
        timeout: timeLeft(),
      });
      const refused = res.status === 401 || res.status === 403 || res.status === 500;
      if (refused && !fresh) {
        // The session expired (or the PVS restarted): a new one, once.
        await this.login({ timeout: timeLeft() });
        fresh = true;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        this.#cookie = null;
        throw new PvsError(CODES.ACCESS, `Variables refused after login (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      if (res.status !== 200) throw PvsClient.failure(res, 'Variables');
      return { vars: parseVars(res.body), date: dateOf(res.headers) };
    }
  }

  /** The variables named (constants of src/constants.js only). */
  readNames(names, options) {
    return this.vars(`name=${names.join(',')}`, options);
  }

  /** Every variable under a prefix (constants of src/constants.js only). */
  readMatch(prefix, options) {
    return this.vars(`match=${prefix}`, { maxBytes: MATCH_BYTES, ...options });
  }
}
