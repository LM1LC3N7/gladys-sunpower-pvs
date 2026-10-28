// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTPS GET to the PVS on
// node:https. A deadline for the whole exchange, a size cap on the body
// (checked chunk by chunk, before the answer is complete), no redirect
// followed (the password and the session never go anywhere else), no
// connection reused (`agent: false`, and never a custom `createConnection`:
// Node would then ignore it and open a second socket). Taken from
// gladys-airos (approved), GET only.
//
// The PVS ships a self-signed certificate: no authority can vouch for it. It
// is checked by its SHA-256 fingerprint instead, right after the TLS
// handshake and BEFORE a single byte of the request (password, session
// cookie) is written: `checkPeer(fingerprint)` (async) decides, and may take
// its time (the app writes a first pin to /data there). What it throws is
// rethrown marked `notSent`. An answer that comes before the request was
// written is never read.
//
// Resolves { status, headers, body } for any status; rejects a PvsError for
// the transport failures, whose message never holds the address (Node's
// messages do).
// -----------------------------------------------------------------------------

import https from 'node:https';
import { isIP } from 'node:net';
import { USER_AGENT } from '../constants.js';
import { CODES, PvsError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  const text = String(err?.message ?? '').toLowerCase();
  if (code === 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' || text.includes('handshake failure')) {
    return new PvsError(CODES.TLS, 'TLS handshake refused', { notSent: !sent });
  }
  // Something answered, but not in HTTP or TLS (a wrong port, the wrong protocol).
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL')) {
    return new PvsError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`, {
      notSent: !sent,
    });
  }
  return new PvsError(
    CODES.UNREACHABLE,
    /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'Connection failed',
    { notSent: !sent },
  );
}

/**
 * @param {{ host: string, port: number, path: string }} target
 * @param {object} options
 * @param {Record<string, string>} [options.headers]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {(fingerprint: string) => Promise<void>|void} options.checkPeer
 */
export function httpsGet({ host, port, path }, { headers = {}, timeout, maxBytes, checkPeer }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let early = false;
    let req = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new PvsError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`, {
            notSent: !sent,
          }),
        ),
      timeout,
    );

    /** TLS is up: the certificate first, then the request. */
    const ready = async (socket) => {
      if (settled) return;
      const fingerprint = socket.getPeerCertificate?.()?.fingerprint256 ?? null;
      try {
        if (!fingerprint) {
          throw new PvsError(CODES.BAD_ANSWER, 'No certificate');
        }
        await checkPeer(fingerprint);
        if (settled) return;
        if (early) throw new PvsError(CODES.BAD_ANSWER, 'Answer before the request');
      } catch (err) {
        finish(Object.assign(err, { notSent: true }));
        return;
      }
      sent = true;
      req.end();
    };

    try {
      const bare = host.replace(/^\[(.*)\]$/, '$1');
      const options = {
        method: 'GET',
        host: bare,
        port,
        path,
        agent: false,
        // Self-signed: checked by its fingerprint above, not by an authority.
        rejectUnauthorized: false,
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
      };
      if (!isIP(bare)) options.servername = bare;
      req = https.request(options, (res) => {
        // An answer before the request was written (the peer spoke first,
        // while its certificate was still being checked): never accepted.
        if (!sent) {
          early = true;
          res.resume();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new PvsError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err, sent)));
      });
      req.on('socket', (socket) => socket.once('secureConnect', () => ready(socket)));
      req.on('error', (err) => finish(transportError(err, sent)));
    } catch (err) {
      // https.request throws synchronously on a value it refuses: a failure,
      // never a crash.
      finish(transportError(err, false));
    }
  });
}
