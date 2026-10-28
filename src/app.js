// -----------------------------------------------------------------------------
// The integration itself: one SunPower PVS5/PVS6 read through its local
// varserver API (HTTPS, a self-signed certificate pinned at the first
// connection), one Gladys device for the site and one per device behind the
// PVS (micro-inverters, meters, SunVault batteries, transfer switches), every
// lifetime counter through its guard. index.js only wires the SDK handlers to
// it. Read-only: the PVS is never commanded (`/vars?set=` is never sent).
//
// One read = the live data and the PVS itself (`/vars?name=`, the principal
// query: a password refused there is final), then, every 5 minutes, one
// `/vars?match=` per kind of device: secondary, each with its own retries, a
// failure of one never holds back the live data nor the others.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the test
// button, the Discover tab, a device created, a restart of the container: the
// time of the last read is kept in /data before the request).
//
// A read belongs to its session (the client of one address, password and
// typed fingerprint): when they change, a late answer of the old one
// publishes nothing and sets no status (checked after every await).
//
// Identity: every read asks the LAN MAC of the PVS with the live data; /data
// keeps a salted hash of it (never the MAC). Another MAC at the address: no
// value published until the user accepts that PVS ("Accept the held values",
// two clicks); a MAC that cannot be read: no value published from that read.
//
// Freshness: a sample is published once (its time in /data), and never when
// it is more than 2 h older than the clock of the PVS (its Date header, or
// the time of its live data); with no readable clock it is never "expired".
//
// /data: a file that exists but cannot be read is not an empty state: it is
// never overwritten, no certificate is learned (nothing sent without a typed
// fingerprint), no counter is published until it reads. A save that fails
// holds the counters back too.
//
// Clocks: `monotonic` paces the reads, the pauses and the retries. The guards
// of the counters run on the SESSION clock: the wall clock read once at the
// start of the process plus the monotonic time since (`sessionNow`), so that
// NTP moving the wall clock never widens nor narrows their margin (as
// gladys-openems and gladys-p1-monitor, approved). The wall clock itself only
// dates what /data keeps for a restart. Each decision reads each clock once.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addressOf, isComplete, normalizeConfig, targetKey } from './config.js';
import {
  ACCEPT_CONFIRM_AFTER,
  ACCEPT_CONFIRM_WITHIN,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  DATED_AFTER,
  DEVICE_KINDS,
  DEVICES_INTERVAL,
  DEVICES_RETRY_MAX,
  DEVICES_RETRY_MIN,
  INDEX_INTERVAL,
  INFO_VARS,
  LIVE_VARS,
  MATCH,
  PAUSE_MAX,
  PAUSE_MIN,
  POLL_INTERVAL,
  RETRY_MAX,
  RETRY_MIN,
  STALE_AFTER,
  STATES_PER_MINUTE,
  STOP_WAIT,
  TEST_ANSWER_WITHIN,
} from './constants.js';
import {
  CATALOG,
  SITE,
  buildDevice,
  capabilitiesOf,
  counterState,
  ids,
  keysOfDevice,
  liveStates,
  union,
  validKeys,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { PvsClient } from './pvs/client.js';
import { CODES, PvsError, isCertificate } from './pvs/errors.js';
import { PARSERS, groupDevices, infoOf, liveOf } from './pvs/model.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hmac = (salt, value) => createHmac('sha256', salt).update(value, 'utf8').digest('hex');

/**
 * The tag of a refused password: 8 bits of a salted hash, never more (a
 * 5-character password must not be found back from /data by brute force).
 * Two passwords share it once in 256: the test button then tries anyway.
 */
export const tagOf = (salt, password) => createHmac('sha256', salt).update(password).digest()[0];

/** The live data and the PVS itself, the principal query. */
const PRINCIPAL_VARS = [...Object.values(LIVE_VARS), ...Object.values(INFO_VARS)];

/** A platform id of this integration (src/devices.js). */
const PLATFORM_ID =
  /^(site|inverter-[A-Za-z0-9_-]{1,40}|meter-[a-z0-9]{1,20}|ess-[A-Za-z0-9_-]{1,40}|switch-[A-Za-z0-9_-]{1,40})$/;
const KIND_OF_PREFIX = {
  inverter: 'inverter',
  meter: 'meter',
  ess: 'ess',
  switch: 'transfer_switch',
};
const kindOfPlatform = (platformId) =>
  platformId === SITE ? 'site' : KIND_OF_PREFIX[platformId.split('-', 1)[0]];

/** The order in which samples are published (the budget of states goes to the first). */
const PRIORITY = { site: 0, meter: 1, ess: 2, transfer_switch: 3, inverter: 4 };

/** The index Gladys already holds for a feature of a created device (wall date), when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** What ties a kept counter state to ONE Gladys device: its id (a device created again is another). */
const deviceKeyOf = (device) =>
  typeof device?.id === 'string' && device.id !== ''
    ? device.id
    : typeof device?.created_at === 'string'
      ? device.created_at
      : undefined;

/** /data read back, every field checked; anything odd is dropped, never trusted. */
export function readMemory(data) {
  const m = isPlain(data) ? data : {};
  const out = {
    salt: typeof m.salt === 'string' && /^[0-9a-f]{32}$/.test(m.salt) ? m.salt : undefined,
    pins: {},
    certChanged: undefined,
    identity:
      typeof m.identity === 'string' && /^[0-9a-f]{64}$/.test(m.identity) ? m.identity : undefined,
    pause: undefined,
    refused: undefined,
    lastAttemptAt: finite(m.lastAttemptAt) ? m.lastAttemptAt : undefined,
    seen: {},
    counters: {},
    samples: {},
  };
  const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
  for (const [key, fp] of Object.entries(isPlain(m.pins) ? m.pins : {})) {
    if (key.length <= 300 && typeof fp === 'string' && FP.test(fp)) out.pins[key] = fp;
  }
  if (
    isPlain(m.certChanged) &&
    typeof m.certChanged.key === 'string' &&
    typeof m.certChanged.seen === 'string' &&
    FP.test(m.certChanged.seen)
  ) {
    out.certChanged = { key: m.certChanged.key, seen: m.certChanged.seen };
  }
  const p = m.pause;
  if (
    isPlain(p) &&
    typeof p.key === 'string' &&
    finite(p.until) &&
    Number.isInteger(p.count) &&
    p.count >= 1 &&
    (p.code === CODES.RATE_LIMITED || p.code === CODES.SERVER)
  ) {
    out.pause = {
      key: p.key,
      until: p.until,
      count: Math.min(p.count, 32),
      code: p.code,
      status: Number.isInteger(p.status) ? p.status : null,
    };
  }
  const r = m.refused;
  if (
    isPlain(r) &&
    typeof r.key === 'string' &&
    typeof r.typed === 'boolean' &&
    Number.isInteger(r.tag) &&
    r.tag >= 0 &&
    r.tag < 256
  ) {
    out.refused = { key: r.key, typed: r.typed, tag: r.tag };
  }
  for (const [platformId, entry] of Object.entries(isPlain(m.seen) ? m.seen : {})) {
    if (!PLATFORM_ID.test(platformId) || !isPlain(entry)) continue;
    const kind = kindOfPlatform(platformId);
    if (!kind || entry.kind !== kind) continue;
    out.seen[platformId] = {
      kind,
      keys: [...validKeys(kind, entry.keys)],
      ...(typeof entry.sn === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(entry.sn)
        ? { sn: entry.sn }
        : {}),
      ...(entry.role === 'production' || entry.role === 'consumption' ? { role: entry.role } : {}),
      ...(Number.isInteger(entry.index) && entry.index >= 0 && entry.index < 10_000
        ? { index: entry.index }
        : {}),
    };
  }
  for (const [id, entry] of Object.entries(isPlain(m.counters) ? m.counters : {})) {
    const [platformId, key, ...rest] = id.split('|');
    if (rest.length > 0 || !PLATFORM_ID.test(platformId ?? '') || !isPlain(entry)) continue;
    const kind = kindOfPlatform(platformId);
    if (!CATALOG[kind]?.some((e) => e.key === key && e.counter)) continue;
    out.counters[id] = {
      ...(typeof entry.device === 'string' && entry.device.length <= 100
        ? { device: entry.device }
        : {}),
      last: isPlain(entry.last) ? entry.last : null,
      held: isPlain(entry.held) ? entry.held : null,
    };
  }
  for (const [platformId, at] of Object.entries(isPlain(m.samples) ? m.samples : {})) {
    if (PLATFORM_ID.test(platformId) && finite(at)) out.samples[platformId] = at;
  }
  return out;
}

export class SunPowerApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sunpower-pvs' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    request,
    store = createFileStore(),
    random = () => randomBytes(16).toString('hex'),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    /** The transport of the client (tests inject a fake PVS); undefined: node:https. */
    this.request = request;
    this.random = random;
    this.store = store;
    /** The session clock: wall at the start of the process + monotonic elapsed since. */
    this.wallStart = now();
    this.monoStart = monotonic();
    this.config = normalizeConfig();
    /** `{ client, key }` of the current address, password and fingerprint. */
    this.session = undefined;
    this.running = false;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    this.savedKey = undefined;
    this.saveFailed = false;
    /** The first click of "Accept the held values": `{ at, listedAt, list, session }`, in memory. */
    this.pendingAccept = undefined;
    /** The connection to Gladys: a new one (or a save) ends the getConfig retries of the old. */
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = Promise.resolve();
    /** By `<platform id>|<key>`: `{ guard, device }`. */
    this.guards = new Map();
    /** By `<platform id>|<key>`: the hold already logged (one line per hold). */
    this.heldLogged = new Map();
    /** The states sent in the last minute: `[{ at, count }]` on the monotonic clock. */
    this.sent = [];
    /** Platform ids whose counters are sent again from their current sample (an acceptance). */
    this.recount = new Set();
    /** /data could not be read: `{ code }`; nothing written, no counter published. */
    this.storeError = undefined;
    this.loadState();
    this.resetReads();
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.monotonic() - this.monoStart);
  }

  /** Reads /data; an unreadable file is kept as an error, never taken for an empty state. */
  loadState() {
    const result = this.store.load();
    if (!result?.ok) {
      if (!this.storeError) {
        this.logger.warn(
          `sunpower-pvs: /data cannot be read (${result?.code ?? 'error'}): counters held`,
        );
      }
      this.storeError = { code: result?.code ?? 'error' };
      this.memory ??= readMemory({});
      this.memory.salt ??= this.random();
      return false;
    }
    const kept = readMemory(result.data);
    kept.salt ??= this.random();
    const at = this.now();
    const mono = this.monotonic();
    this.storeError = undefined;
    this.memory = kept;
    this.guards.clear();
    // The last read before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    if (kept.lastAttemptAt !== undefined && this.lastAttemptAt === undefined) {
      this.lastAttemptAt = Math.min(kept.lastAttemptAt, at);
      this.savedAttemptAt = this.lastAttemptAt;
      this.lastReadAt = mono - (at - this.lastAttemptAt);
    }
    this.savedKey = undefined;
    return true;
  }

  /** What belongs to one session: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'reading' | 'error', ... }`. */
    this.outcome = undefined;
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    /** By kind: `{ devices, nextAt, failures, code, more, skipped }`. */
    this.kinds = Object.fromEntries(
      DEVICE_KINDS.map((kind) => [kind, { devices: undefined, nextAt: undefined, failures: 0 }]),
    );
    /** Monotonic time the counters of the site were last published. */
    this.lastIndexAt = undefined;
    /** The latest identity check: 'ok' | 'other' | 'unreadable' | undefined. */
    this.identityState = undefined;
    this.otherIdentity = undefined;
    this.info = undefined;
  }

  // --- Connection to Gladys -------------------------------------------------------

  /**
   * A (re)connection to Gladys: its configuration, then a start. A
   * `getConfig()` that fails is tried again without end (5 s doubled up to
   * 5 min), the status saying so, until it answers or the connection ends.
   */
  connected(getConfig) {
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /** The connection to Gladys is lost: the retries of getConfig end, the reads stop. */
  disconnected() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.stop();
  }

  /** The user saved the form: this configuration wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(CONFIG_RETRY_MIN * 2 ** this.configFailures, CONFIG_RETRY_MAX);
      this.configFailures = Math.min(this.configFailures + 1, 16);
      this.logger.warn(
        `sunpower-pvs: the configuration could not be read (${err?.name ?? 'Error'})`,
      );
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
        return this.configRun;
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  /**
   * Stops the reads, waits (bounded) for the one running, and writes /data:
   * the time of the last read and what was seen since the last save are
   * never lost by a clean stop.
   */
  stop() {
    return this.serialize(async () => {
      this.doStop();
      // Written first: Docker stops the container 10 s after asking.
      await this.saveState();
      if (this.busy) {
        let timer;
        await Promise.race([
          this.busy.catch(() => {}),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, STOP_WAIT);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
      await this.saveState();
    });
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.configRun;
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** The key of what a session is: the address, the password, the typed fingerprint. */
  static sessionKey(config) {
    return JSON.stringify([
      config.host,
      config.hostError,
      config.port,
      config.password,
      config.passwordInvalid,
      config.fingerprint,
    ]);
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed = first || SunPowerApp.sessionKey(config) !== SunPowerApp.sessionKey(this.config);
    this.config = config;
    if (changed) {
      this.session?.client?.close();
      const session = { key: targetKey(config) };
      session.client = isComplete(config)
        ? new PvsClient({
            host: config.host,
            port: config.port,
            password: config.password,
            checkPeer: (fingerprint) => this.checkPeer(session, fingerprint),
            ...(this.request ? { request: this.request } : {}),
          })
        : undefined;
      session.discovered = false;
      this.session = session;
      // A list of the first click belongs to its session.
      this.pendingAccept = undefined;
      if (!first) this.resetReads();
    }
    await this.applyMemory();
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values at the next sample, never a value of before).
    this.lastStatus = undefined;
    this.lastIndexAt = undefined;
    this.gladys.forgetPublishedStates?.();
    if (!this.session.client) {
      await this.updateStatus();
      return;
    }
    await this.discover();
    await this.updateStatus();
    this.schedule();
  }

  /** The refusal, the pause and the changed certificate kept in /data, against this configuration. */
  async applyMemory() {
    const m = this.memory;
    const key = this.session.key;
    let dirty = false;
    // A password refused stands only for the same address and password.
    if (m.refused && !this.refusedApplies()) {
      m.refused = undefined;
      dirty = true;
    }
    // A pause asked by another address ends; the pace does not.
    if (m.pause && m.pause.key !== key) {
      m.pause = undefined;
      dirty = true;
    }
    if (m.certChanged && (m.certChanged.key !== key || this.config.fingerprint)) {
      // Another address, or a fingerprint typed: it is the authority now
      // (checkPeer imposes it; another certificate is refused, showing the
      // one met, nothing sent).
      if (this.config.fingerprint && m.certChanged.key === key) {
        this.logger.info('sunpower-pvs: a certificate fingerprint was typed: it is trusted now');
      }
      m.certChanged = undefined;
      dirty = true;
    }
    if (dirty) await this.saveState();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Whether the password refused by the PVS is the one configured now. */
  refusedApplies() {
    const r = this.memory.refused;
    const config = this.config;
    return Boolean(
      r &&
      this.session &&
      r.key === this.session.key &&
      r.typed === (config.password !== '') &&
      r.tag === tagOf(this.memory.salt, config.password),
    );
  }

  // --- The certificate ---------------------------------------------------------

  /**
   * Right after the TLS handshake, before any byte is written: the
   * certificate of the PVS must be the fingerprint typed, else the pin kept
   * in /data; with neither, it is learned, written to /data BEFORE the
   * request goes. /data unreadable or not writable: nothing learned, nothing
   * sent.
   */
  async checkPeer(session, fingerprint) {
    if (session !== this.session || !this.running) {
      throw new PvsError(CODES.LATE, 'Configuration changed');
    }
    const m = this.memory;
    const key = session.key;
    const typed = this.config.fingerprint;
    if (typed) {
      if (fingerprint !== typed) {
        throw new PvsError(CODES.CERTIFICATE_TYPED, 'Not the certificate typed', { fingerprint });
      }
      if (m.pins[key] !== typed) {
        m.pins = { [key]: typed };
        m.certChanged = undefined;
        // Kept when /data allows it; the typed value is the reference anyway.
        await this.saveState();
      }
      return;
    }
    const pin = m.pins[key];
    if (pin) {
      if (fingerprint === pin) return;
      throw new PvsError(CODES.CERTIFICATE, 'Another certificate', { fingerprint });
    }
    if (this.storeError) {
      throw new PvsError(CODES.PIN_UNAVAILABLE, '/data unreadable', {
        reason: 'unreadable',
        fingerprint,
      });
    }
    m.pins = { [key]: fingerprint };
    if (!(await this.saveState())) {
      delete m.pins[key];
      throw new PvsError(CODES.PIN_UNAVAILABLE, '/data not writable', {
        reason: 'unwritable',
        fingerprint,
      });
    }
    if (session !== this.session || !this.running) {
      throw new PvsError(CODES.LATE, 'Configuration changed');
    }
    this.logger.info('sunpower-pvs: certificate of the PVS pinned (first connection)');
  }

  // --- Pace ------------------------------------------------------------------

  /** The rest of the pause (ms), from its wall end, capped to PAUSE_MAX at every use; 0 when none. */
  pauseLeft(mono) {
    const p = this.memory.pause;
    if (!p || !this.session || p.key !== this.session.key) return 0;
    if (p.due === undefined) {
      // Read back from /data: its rest, onto the monotonic clock, once.
      p.due = mono + Math.min(Math.max(0, p.until - this.now()), PAUSE_MAX);
    }
    return Math.min(Math.max(0, p.due - mono), PAUSE_MAX);
  }

  /** The monotonic time from which the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + POLL_INTERVAL;
    if (this.nextTryAt !== undefined) due = Math.max(due, this.nextTryAt);
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  /** One timer: the next read when it is due; none while the password is refused. */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.session?.client || this.refusedApplies()) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`sunpower-pvs: unexpected error (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) this.schedule();
  }

  /** One read when it is due; a read running is never doubled. */
  tick({ evenRefused = false } = {}) {
    if (this.busy) return this.busy;
    this.busy = this.read({ evenRefused }).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read({ evenRefused }) {
    const session = this.session;
    if (!session?.client || !this.running) return;
    // A refused password is never tried again by itself: only the test button.
    if (!evenRefused && this.refusedApplies()) return;
    const mono = this.monotonic();
    // A timer a little early (rounded to the ms): the next one comes when due.
    if (mono < this.dueAt(mono)) return;
    await this.poll(session, mono);
  }

  /** The read itself, once it is due (`mono`: the instant of that decision). */
  async poll(session, mono) {
    /** Another session (or a stop) during an await: this read gives up, silently. */
    const gone = () => session !== this.session || !this.running;
    const client = session.client;
    // Tried again at each read: once /data reads, the counters go on.
    if (this.storeError) this.loadState();
    this.lastReadAt = mono;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    let answer;
    try {
      answer = await client.readNames(PRINCIPAL_VARS);
    } catch (err) {
      if (gone()) return;
      await this.failed(err, gone);
      return;
    }
    if (gone()) return;
    // The live data first: a slow match of 200 inverters never delays it.
    await this.succeeded(answer, mono, gone);
    if (gone()) return;
    if (this.identityState === 'ok') {
      await this.readDevices(client, gone, mono);
      if (gone()) return;
    }
    await this.afterRead(mono, gone);
  }

  /**
   * The devices, every DEVICES_INTERVAL, one `match` per kind: secondary.
   * A failure (a 401/403 or a 5xx too: never a refused password nor a pause)
   * only leaves that kind as it was, tried again after 5 min doubled up to 1 h.
   */
  async readDevices(client, gone, mono) {
    for (const kind of DEVICE_KINDS) {
      const state = this.kinds[kind];
      if (state.nextAt !== undefined && mono < state.nextAt) continue;
      try {
        const { vars } = await client.readMatch(MATCH[kind]);
        if (gone()) return;
        const grouped = groupDevices(vars, kind);
        if (state.code) this.logger.info(`sunpower-pvs: the ${kind} devices answer again`);
        Object.assign(state, {
          ...this.devicesOf(kind, grouped.devices),
          more: grouped.more,
          nextAt: mono + DEVICES_INTERVAL,
          failures: 0,
          code: undefined,
        });
      } catch (err) {
        if (gone()) return;
        if (isCertificate(err) || err?.code === CODES.CREDENTIALS) {
          // The certificate changed or the password was refused between two
          // queries: the principal read tells it at its next turn.
          return;
        }
        const wait = Math.min(DEVICES_RETRY_MIN * 2 ** state.failures, DEVICES_RETRY_MAX);
        if (!state.code) {
          this.logger.warn(`sunpower-pvs: the ${kind} devices could not be read (${err?.code})`);
        }
        Object.assign(state, {
          nextAt: mono + wait,
          failures: Math.min(state.failures + 1, 16),
          code: err?.code ?? 'error',
        });
      }
    }
  }

  /**
   * The devices of a kind as entries: their platform id (src/devices.js),
   * those without a usable serial number and those whose id would hold the
   * password counted apart (never offered).
   */
  devicesOf(kind, raw) {
    const devices = [];
    let unnamed = 0;
    let secret = 0;
    let unheard = 0;
    const roles = new Set();
    for (const { index, fields } of raw) {
      const sample = PARSERS[kind](fields);
      // No readable `msmtEps`: the device was never heard since the PVS
      // started; its fields are defaults (0), never measurements nor
      // capabilities (review r1, I3).
      if (sample.at === undefined) {
        unheard += 1;
        continue;
      }
      let platformId;
      if (kind === 'meter') {
        const role = sample.role && !roles.has(sample.role) ? sample.role : undefined;
        if (role) roles.add(role);
        platformId = role ? `meter-${role}` : `meter-${index}`;
        sample.role = role;
      } else if (!sample.sn) {
        unnamed += 1;
        continue;
      } else {
        platformId = `${kind === 'transfer_switch' ? 'switch' : kind}-${sample.sn}`;
      }
      if (this.session.client.holdsSecret(platformId)) {
        secret += 1;
        continue;
      }
      devices.push({
        entry: { kind, platformId, sn: sample.sn, role: sample.role, index, model: sample.model },
        sample,
      });
    }
    return { devices, unnamed, secret, unheard };
  }

  async saveAttempt(now) {
    // Written before every request (review r1, m1): a process killed during
    // it never reads again sooner than the interval after a restart.
    this.lastAttemptAt = now;
    this.savedAttemptAt = now;
    await this.saveState();
  }

  // --- Outcomes ----------------------------------------------------------------

  async succeeded({ vars, date }, mono, gone) {
    // An answer: a pause asked before, the retries, a refused password and a
    // changed certificate are over.
    const m = this.memory;
    const wasRefused = Boolean(m.refused);
    m.pause = undefined;
    m.refused = undefined;
    m.certChanged = undefined;
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    if (wasRefused) this.logger.info('sunpower-pvs: the PVS accepts the password again');
    const info = infoOf(vars);
    const live = liveOf(vars);
    this.info = info;
    this.outcome = { at: mono, kind: 'reading', live, date };
    await this.checkIdentity(info);
    if (gone()) return;
    await this.saveState();
  }

  /**
   * The MAC of this answer against the identity in /data (a salted hash):
   * learned at the first read (saved before any value), the same: ok;
   * another: nothing published until the user accepts it; unreadable: nothing
   * published from this read (never "another PVS").
   */
  async checkIdentity(info) {
    const m = this.memory;
    if (!info.mac) {
      this.identityState = 'unreadable';
      return;
    }
    const seen = hmac(m.salt, info.mac);
    if (this.storeError) {
      // /data cannot tell which PVS it was: nothing published (src/app.js header).
      this.identityState = 'unreadable';
      return;
    }
    if (!m.identity) {
      m.identity = seen;
      this.identityState = (await this.saveState()) ? 'ok' : 'unreadable';
      if (this.identityState !== 'ok') m.identity = undefined;
      return;
    }
    if (m.identity === seen) {
      this.identityState = 'ok';
      this.otherIdentity = undefined;
      return;
    }
    if (this.otherIdentity !== seen) {
      this.logger.warn('sunpower-pvs: another PVS answers at the address: nothing published');
    }
    this.identityState = 'other';
    this.otherIdentity = seen;
  }

  /** After a read: Discovery when something new showed, the values, /data, the status. */
  async afterRead(mono, gone) {
    if (this.outcome?.kind === 'reading' && this.identityState === 'ok') {
      if (this.learn() || !this.session.discovered) {
        this.session.discovered = true;
        await this.discover();
        if (gone()) return;
      }
      await this.publish(mono, gone);
      if (gone()) return;
    }
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  /** Whether the battery features of the site are offered: the PVS lists a battery. */
  hasBattery() {
    return (
      Object.values(this.memory.seen).some((s) => s.kind === 'ess') ||
      (this.kinds.ess.devices?.length ?? 0) > 0
    );
  }

  /** The current samples: `[{ entry, sample }]`, the site first. */
  currentSamples() {
    const list = [];
    if (this.outcome?.kind === 'reading') {
      list.push({ entry: { kind: 'site', platformId: SITE }, sample: this.outcome.live });
    }
    for (const kind of DEVICE_KINDS) {
      list.push(...(this.kinds[kind].devices ?? []));
    }
    // Within a kind, the device published longest ago first: a site with more
    // micro-inverters than the budget of a minute sends them all in turn
    // (review r1, m2).
    const last = (s) => this.memory.samples[s.entry.platformId] ?? 0;
    return list.sort(
      (a, b) => PRIORITY[a.entry.kind] - PRIORITY[b.entry.kind] || last(a) - last(b),
    );
  }

  /** The feature keys seen, from the samples of this read; whether a key is new. */
  learn() {
    const seen = this.memory.seen;
    const battery = this.hasBattery();
    let grew = false;
    for (const { entry, sample } of this.currentSamples()) {
      const keys = capabilitiesOf(entry.kind, sample, { role: entry.role, battery });
      if (keys.size === 0) continue;
      const before = seen[entry.platformId];
      const all = union(before?.keys, keys);
      if (!before || all.size !== before.keys.length) grew = true;
      seen[entry.platformId] = {
        kind: entry.kind,
        keys: [...all],
        ...(entry.sn ? { sn: entry.sn } : {}),
        ...(entry.role ? { role: entry.role } : {}),
        ...(entry.index !== undefined ? { index: entry.index } : {}),
      };
    }
    return grew;
  }

  async failed(err, gone) {
    const code = err?.code ?? 'error';
    // The pause and the next try count from the failure, not from the start of the read.
    const at = this.monotonic();
    const now = this.now();
    const m = this.memory;
    // Our own words only (PvsError codes): never a text of the PVS.
    this.logger.warn(
      `sunpower-pvs read failed: ${code}${Number.isInteger(err?.status) ? ` ${err.status}` : ''}`,
    );
    this.outcome = { at, kind: 'error', err };
    if (code === CODES.CREDENTIALS) {
      // The login is refused: final, kept in /data, never tried again by
      // itself (only another password or the test button).
      m.refused = {
        key: this.session.key,
        typed: this.config.password !== '',
        tag: tagOf(m.salt, this.config.password),
      };
      this.failures = 0;
      this.nextTryAt = undefined;
      this.lastError = undefined;
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === CODES.RATE_LIMITED || code === CODES.SERVER) {
      const count = (m.pause?.count ?? 0) + 1;
      const asked = finite(err.retryAfter) ? err.retryAfter : PAUSE_MIN * 2 ** (count - 1);
      const wait = Math.min(Math.max(asked, PAUSE_MIN), PAUSE_MAX);
      m.pause = {
        key: this.session.key,
        until: now + wait,
        due: at + wait,
        count: Math.min(count, 32),
        code,
        status: Number.isInteger(err.status) ? err.status : null,
      };
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === CODES.CERTIFICATE || code === CODES.CERTIFICATE_TYPED) {
      m.certChanged = { key: this.session.key, seen: err.fingerprint };
      if (code === CODES.CERTIFICATE) {
        this.logger.warn(
          'sunpower-pvs: the certificate of the PVS is not the pinned one: nothing sent',
        );
      }
    }
    // Retries doubled (never faster than the interval).
    const wait = Math.min(RETRY_MIN * 2 ** this.failures, RETRY_MAX);
    this.failures = Math.min(this.failures + 1, 16);
    this.lastError = err;
    this.nextTryAt = at + wait;
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  // --- Values ------------------------------------------------------------------------

  /** The created Gladys device of a platform id, undefined until the user creates it. */
  createdDevice(platformId) {
    const id = ids(this.gladys, platformId).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  /** The guard of a counter of a created device, from Gladys and /data (session clock). */
  guardOf(platformId, key, created, limits) {
    const id = `${platformId}|${key}`;
    const device = deviceKeyOf(created);
    const current = this.guards.get(id);
    if (current && current.device !== device) {
      // Another device of this platform id (created again while the app was away).
      this.forgetCounter(id);
    }
    if (!this.guards.has(id)) {
      let saved = this.memory.counters[id];
      if (saved?.device !== undefined && device !== undefined && saved.device !== device) {
        // Kept for another device (deleted, created again): never its reference.
        delete this.memory.counters[id];
        saved = undefined;
      }
      const sessionNow = this.sessionNow();
      // /data and Gladys hold wall dates: back to the session clock; a date
      // "in the future" (a wall clock set back) is now, so that the margin of
      // the next rise never shrinks to nothing.
      const offset = this.now() - sessionNow;
      const toSession = (ref) =>
        isPlain(ref) && finite(ref.at)
          ? { ...ref, at: Math.min(ref.at - offset, sessionNow) }
          : undefined;
      const kept = saved ? { last: toSession(saved.last), held: toSession(saved.held) } : undefined;
      const known = toSession(lastValueOf(created, ids(this.gladys, platformId).feature(key)));
      this.guards.set(id, { guard: new IndexGuard(known, kept, sessionNow, limits), device });
    }
    return this.guards.get(id).guard;
  }

  forgetCounter(id) {
    this.guards.delete(id);
    this.heldLogged.delete(id);
    delete this.memory.counters[id];
  }

  /** One log line per hold (its direction), never one per read; never a value. */
  logHold(id, guard) {
    const held = guard.held;
    const key = held ? `${held.direction}:${held.from}` : undefined;
    if (key && this.heldLogged.get(id) !== key) {
      this.logger.warn(
        `sunpower-pvs: a lifetime counter ${held.direction === 'down' ? 'drop' : 'jump'} held back (${id.split('|')[1]})`,
      );
    }
    if (key) this.heldLogged.set(id, key);
    else this.heldLogged.delete(id);
  }

  /** States still allowed this minute (STATES_PER_MINUTE), on the monotonic clock. */
  budget(mono) {
    // A minute and a margin: Gladys counts on its own clock.
    this.sent = this.sent.filter((s) => mono - s.at < 65_000 && s.at <= mono);
    return STATES_PER_MINUTE - this.sent.reduce((sum, s) => sum + s.count, 0);
  }

  /** The clock of the PVS: its Date header, else the time of its live data. */
  pvsClock() {
    return this.outcome?.date ?? this.outcome?.live?.at;
  }

  /** Whether a sample dated `at` may be published against the clock of the PVS. */
  fresh(at) {
    const clock = this.pvsClock();
    if (at === undefined || clock === undefined) return true;
    return Math.abs(clock - at) <= STALE_AFTER;
  }

  /**
   * The states of the current samples of the created devices: each sample
   * once (its time kept in /data), never stale; the counters of the site
   * once a minute. The guards are in /data BEFORE Gladys gets a counter: a
   * save that fails (or a /data unreadable) sends none. Within the budget of
   * states: a sample left out is sent at the next read.
   */
  async publish(mono, gone) {
    if (this.lastIndexAt !== undefined && mono < this.lastIndexAt) this.lastIndexAt = undefined;
    const indexDue = this.lastIndexAt === undefined || mono - this.lastIndexAt >= INDEX_INTERVAL;
    const battery = this.hasBattery();
    const sessionNow = this.sessionNow();
    const wallNow = this.now();
    const clock = this.pvsClock();
    let left = this.budget(mono);
    const live = [];
    const counters = [];
    const samples = this.memory.samples;
    let sitePublished = false;
    for (const { entry, sample } of this.currentSamples()) {
      const created = this.createdDevice(entry.platformId);
      if (!created) continue;
      const site = entry.kind === 'site';
      const at = sample.at;
      if (!this.fresh(at)) continue;
      const known = at !== undefined && samples[entry.platformId] === at;
      // A sample already sent: only the counters of the site (once a minute)
      // or those the user just accepted go again, never its plain values.
      const countersOnly = known && (site ? indexDue : this.recount.has(entry.platformId));
      if (known && !countersOnly) continue;
      // A sample older than a few minutes (a device just created, a PVS that
      // came back) is dated: Gladys files it at its own time, never as new.
      const age = at !== undefined && clock !== undefined ? clock - at : undefined;
      const dated =
        age !== undefined && age > DATED_AFTER ? new Date(wallNow - age).toISOString() : undefined;
      const features = keysOfDevice(entry.kind, created);
      const only = (states) =>
        states.filter((s) => features.has(s.device_feature_external_id.split(':').at(-1)));
      const values = known
        ? []
        : only(liveStates(this.gladys, entry.kind, entry.platformId, sample, { battery })).map(
            (s) => (dated ? { ...s, created_at: dated } : s),
          );
      const due =
        (!site || indexDue) && !this.storeError
          ? CATALOG[entry.kind].filter(
              (e) =>
                e.counter &&
                features.has(e.key) &&
                (!e.role || e.role === entry.role) &&
                finite(sample[e.value]) &&
                sample[e.value] > 0,
            )
          : [];
      // Out of budget: this sample waits for the next read, its guards untouched.
      if (values.length + due.length > left) break;
      const sums = [];
      for (const e of due) {
        const id = `${entry.platformId}|${e.key}`;
        const guard = this.guardOf(entry.platformId, e.key, created, e.counter);
        const value = sample[e.value];
        const plausible = guard.accept(value, sessionNow);
        this.logHold(id, guard);
        if (plausible) sums.push(...counterState(this.gladys, entry.platformId, e.key, value));
      }
      left -= values.length + sums.length;
      live.push(...values);
      counters.push(...sums);
      if (at !== undefined) samples[entry.platformId] = at;
      this.recount.delete(entry.platformId);
      if (site) sitePublished = true;
    }
    if (indexDue && sitePublished) this.lastIndexAt = mono;
    let states = live;
    const saved = await this.saveState();
    if (gone()) return;
    if (saved && !this.storeError) states = [...live, ...counters];
    if (states.length === 0) return;
    this.sent.push({ at: mono, count: states.length });
    await this.gladys
      .publishChangedStates(states)
      .catch((err) => this.logger.warn(`Publishing the PVS values failed (${err?.name})`));
    if (gone()) return;
    await this.publishBadges();
  }

  /**
   * The badge of each created device: degraded (orange) while one of its
   * counters is held, local otherwise. Sent when it changes, and at each start.
   */
  async publishBadges() {
    const held = new Set(this.heldList().map((h) => h.platformId));
    const badges = [];
    for (const platformId of this.knownPlatforms()) {
      if (!this.createdDevice(platformId)) continue;
      badges.push({
        external_id: ids(this.gladys, platformId).device,
        transport: 'local',
        ...(held.has(platformId) ? { degraded: true, message: T.badgeHeld } : {}),
      });
    }
    const key = JSON.stringify(badges);
    if (badges.length === 0 || key === this.lastBadges) return;
    this.lastBadges = key;
    await this.gladys
      .publishTransports(badges)
      .catch((err) => this.logger.warn(`Publishing the device badges failed (${err?.name})`));
  }

  // --- Devices -----------------------------------------------------------------------

  /** Every platform id known: seen in /data, read now, or created. */
  knownPlatforms() {
    const set = new Set(Object.keys(this.memory.seen));
    for (const { entry } of this.currentSamples()) set.add(entry.platformId);
    const prefix = ids(this.gladys, '').device;
    for (const d of this.gladys.devices ?? []) {
      const id = String(d.external_id ?? '');
      if (id.startsWith(prefix) && PLATFORM_ID.test(id.slice(prefix.length))) {
        set.add(id.slice(prefix.length));
      }
    }
    return [...set];
  }

  /** The devices offered: what each showed (or kept in /data), with its created features. */
  async discover() {
    if (!this.session?.client) return;
    const current = new Map(this.currentSamples().map((s) => [s.entry.platformId, s.entry]));
    const devices = [];
    for (const platformId of this.knownPlatforms()) {
      const kind = kindOfPlatform(platformId);
      const seen = this.memory.seen[platformId];
      const created = this.createdDevice(platformId);
      const keys = union(validKeys(kind, seen?.keys), keysOfDevice(kind, created));
      if (keys.size === 0) continue;
      const entry = current.get(platformId) ?? {
        kind,
        platformId,
        sn: seen?.sn ?? platformId.split('-').slice(1).join('-'),
        role: seen?.role,
        index: seen?.index ?? platformId.split('-').slice(1).join('-'),
      };
      const params =
        kind === 'site'
          ? [
              { name: 'address', value: addressOf(this.config) },
              { name: 'model', value: this.info?.model ?? '' },
              { name: 'software_version', value: this.info?.softwareVersion ?? '' },
              { name: 'hardware_version', value: this.info?.hardwareVersion ?? '' },
            ]
          : [{ name: 'model', value: entry.model ?? '' }];
      devices.push(buildDevice(this.gladys, entry, keys, params));
    }
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the PVS devices failed (${err?.name})`));
  }

  /** The Discover tab asks: the known devices, never a read (the next one comes at its time). */
  async scan() {
    await this.discover();
  }

  /** The platform id of a device external id of this integration, or undefined. */
  platformOf(externalId) {
    const prefix = ids(this.gladys, '').device;
    const id = String(externalId ?? '');
    const platformId = id.startsWith(prefix) ? id.slice(prefix.length) : '';
    return PLATFORM_ID.test(platformId) ? platformId : undefined;
  }

  /**
   * A device created (or deleted): it has no reference of its counters yet
   * (nor a state kept for a deleted device of the same id): nothing can be
   * counted twice. Its values come with the next sample (a sample already
   * sent is never sent again as new).
   */
  async onDeviceCreated(device) {
    const platformId = this.platformOf(device?.external_id);
    if (!platformId) return;
    for (const id of [...this.guards.keys(), ...Object.keys(this.memory.counters)]) {
      if (id.startsWith(`${platformId}|`)) this.forgetCounter(id);
    }
    this.pendingAccept = undefined;
    if (platformId === SITE) this.lastIndexAt = undefined;
    await this.saveState();
    await this.updateStatus();
  }

  async onDeviceDeleted(device) {
    await this.onDeviceCreated(device);
  }

  async onDeviceUpdated(device) {
    const platformId = this.platformOf(device?.external_id);
    if (!platformId) return;
    // New features (Update in Discovery): their values at the next sample
    // (the current one is never sent again as new).
    if (platformId === SITE) this.lastIndexAt = undefined;
    await this.updateStatus();
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the pin, the identity, the pause, the refusal, the last read, the
   * devices seen, the samples and the guards (their dates on the wall clock
   * of now). Never writes over a /data it could not read.
   * @returns {Promise<boolean>} whether /data holds the state now.
   */
  async saveState() {
    if (this.storeError) return false;
    const m = this.memory;
    const offset = this.now() - this.sessionNow();
    const toWall = (ref) => (ref && finite(ref.at) ? { ...ref, at: ref.at + offset } : null);
    for (const [id, { guard, device }] of this.guards) {
      const state = guard.state();
      m.counters[id] = {
        ...(device !== undefined ? { device } : {}),
        last: toWall(state.last),
        held: toWall(state.held),
      };
    }
    const p = m.pause;
    const state = {
      salt: m.salt,
      pins: m.pins,
      certChanged: m.certChanged ?? null,
      identity: m.identity ?? null,
      pause: p
        ? { key: p.key, until: p.until, count: p.count, code: p.code, status: p.status }
        : null,
      refused: m.refused ?? null,
      lastAttemptAt: this.lastAttemptAt ?? null,
      seen: m.seen,
      counters: m.counters,
      samples: m.samples,
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) return true;
    try {
      await this.store.save(state);
      this.savedKey = key;
      if (this.saveFailed) {
        this.saveFailed = false;
        this.logger.info('sunpower-pvs: /data is written again');
      }
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.logger.warn(`sunpower-pvs: saving /data failed (${err?.code ?? 'error'})`);
      }
      this.saveFailed = true;
      return false;
    }
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'Error'})`));
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The counters held back: `{ id, platformId, key, label, direction, from, to }`. */
  heldList() {
    const list = [];
    for (const [id, { guard }] of this.guards) {
      const held = guard.held;
      if (!held) continue;
      const [platformId, key] = id.split('|');
      const kind = kindOfPlatform(platformId);
      const entry = CATALOG[kind].find((e) => e.key === key);
      list.push({
        id,
        platformId,
        key,
        label: entry.label,
        name: platformId === SITE ? undefined : platformId,
        direction: held.direction,
        from: held.from,
        to: held.to,
        threshold: held.threshold,
      });
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Notes shown with every status: /data, the counters held, the identity. */
  standingNotes() {
    const notes = [];
    if (this.storeError) notes.push(T.notes.storeUnreadable(this.storeError.code));
    else if (this.saveFailed) notes.push(T.notes.saveFailed);
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    return notes;
  }

  /** The status from what is known now: never a read. */
  currentStatus() {
    const config = this.config;
    if (!this.session?.client) {
      if (config.hostError === 'missing') return [false, T.incomplete];
      if (config.hostError === 'http') return [false, T.badAddressHttp];
      if (config.hostError) return [false, T.badAddress];
      if (config.passwordInvalid) return [false, T.badPassword];
      if (config.fingerprint === null) return [false, T.badFingerprint];
      return [false, T.incomplete];
    }
    const address = addressOf(config);
    const mono = this.monotonic();
    const notes = this.standingNotes();
    const m = this.memory;
    if (this.refusedApplies()) {
      return [false, T.refused(address, m.refused.typed, notes)];
    }
    const left = this.pauseLeft(mono);
    if (left > 0) return [false, T.paused(address, m.pause, left, notes)];
    if (m.certChanged && m.certChanged.key === this.session.key) {
      return [
        false,
        T.certificateChanged(address, m.certChanged.seen, Boolean(config.fingerprint), notes),
      ];
    }
    if (this.lastError && this.failures > 0) {
      const wait = Math.max(0, (this.nextTryAt ?? 0) - mono);
      return [false, T.unreachable(address, this.lastError, wait, notes)];
    }
    if (this.outcome?.kind === 'reading') {
      if (this.identityState === 'other') return [false, T.otherPvs(address, notes)];
      if (this.identityState === 'unreadable') return [false, T.noIdentity(address, notes)];
      const extra = [];
      const counts = {};
      for (const kind of DEVICE_KINDS) counts[kind] = this.kinds[kind].devices?.length;
      const failing = DEVICE_KINDS.filter(
        (kind) =>
          this.kinds[kind].code &&
          (kind === 'inverter' ||
            kind === 'meter' ||
            Object.values(m.seen).some((s) => s.kind === kind)),
      );
      if (failing.length > 0) extra.push(T.notes.kindsFailed(failing));
      const unnamed = DEVICE_KINDS.reduce((n, k) => n + (this.kinds[k].unnamed ?? 0), 0);
      if (unnamed > 0) extra.push(T.notes.unnamed(unnamed));
      const unheard = DEVICE_KINDS.reduce((n, k) => n + (this.kinds[k].unheard ?? 0), 0);
      if (unheard > 0) extra.push(T.notes.unheard(unheard));
      const secret = DEVICE_KINDS.reduce((n, k) => n + (this.kinds[k].secret ?? 0), 0);
      if (secret > 0) extra.push(T.notes.secretId(secret));
      const more = DEVICE_KINDS.filter((k) => this.kinds[k].more);
      if (more.length > 0) extra.push(T.notes.tooMany(more));
      const live = this.outcome.live;
      if (live.at !== undefined && !this.fresh(live.at)) extra.push(T.notes.liveStale);
      const notCreated = this.knownPlatforms().filter(
        (p) => this.memory.seen[p] && !this.createdDevice(p),
      ).length;
      if (notCreated > 0) extra.push(T.notes.noDevice(notCreated));
      return [true, T.ok(address, counts, [...extra, ...notes])];
    }
    return [false, T.waiting(address, notes)];
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held values", in two clicks (as gladys-ecodevices, approved):
   * the first lists every counter held and another PVS met, and accepts
   * nothing; the second, 3 s to 5 min later in the same session, accepts
   * exactly what the first listed, each only when it still shows the same
   * thing (a counter: same direction and start, the value shown or what may
   * have been measured since, src/guard.js; a PVS: the same one). A drop is
   * accepted too: a counter set back or a device replaced is a way out,
   * never taken without the user. A save of the form never accepts.
   */
  async acceptHeld() {
    const list = this.heldList();
    const other = this.identityState === 'other' ? this.otherIdentity : undefined;
    const mono = this.monotonic();
    const sessionNow = this.sessionNow();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (
      !pending ||
      pending.session !== this.session ||
      elapsed > ACCEPT_CONFIRM_WITHIN ||
      elapsed < ACCEPT_CONFIRM_AFTER
    ) {
      if (list.length === 0 && !other) return T.accept.nothing;
      this.pendingAccept = { at: mono, listedAt: sessionNow, list, other, session: this.session };
      return T.accept.confirm(list, Boolean(other), ACCEPT_CONFIRM_WITHIN);
    }
    const accepted = [];
    const changed = [];
    for (const entry of pending.list) {
      const guard = this.guards.get(entry.id)?.guard;
      const held = guard?.held;
      const margin = guard ? guard.margin(pending.listedAt, sessionNow) : 0;
      const same =
        held &&
        held.direction === entry.direction &&
        held.from === entry.from &&
        (entry.direction === 'up'
          ? held.threshold === entry.threshold &&
            held.to >= entry.to &&
            held.to - entry.to <= margin
          : Math.abs(held.to - entry.to) <= margin);
      if (same && guard.acceptHeld()) {
        accepted.push({ ...entry, to: held.to });
        this.logger.info(
          `sunpower-pvs: a lifetime counter ${entry.direction === 'down' ? 'drop' : 'jump'} accepted by the user (${entry.key})`,
        );
      } else if (held) {
        changed.push(entry);
      }
    }
    let pvsAccepted = false;
    if (pending.other && pending.other === this.otherIdentity && this.identityState === 'other') {
      const before = this.memory.identity;
      this.memory.identity = pending.other;
      if (await this.saveState()) {
        pvsAccepted = true;
        this.identityState = undefined;
        this.otherIdentity = undefined;
        this.memory.samples = {};
        this.logger.info('sunpower-pvs: the new PVS accepted by the user');
      } else {
        this.memory.identity = before;
      }
    }
    if (accepted.length === 0 && changed.length === 0 && !pvsAccepted) return T.accept.nothing;
    // Published at the next read (never a read sooner than the interval).
    this.lastIndexAt = undefined;
    for (const entry of accepted) this.recount.add(entry.platformId);
    await this.saveState();
    await this.updateStatus();
    return T.accept.done(accepted, changed, pvsAccepted, pending.other && !pvsAccepted);
  }

  /**
   * The test button: never a read sooner than the pace allows. When a read
   * is due, this click makes it (even with a password refused before: only
   * a success lifts the refusal); otherwise it tells the last one.
   */
  async testConnection() {
    if (!this.session?.client) return this.currentStatus()[1];
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) return this.currentStatus()[1];
    if (this.busy || this.dueAt(mono) > mono) return this.describeOutcome();
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      return await Promise.race([
        this.tick({ evenRefused: true }).then(() => this.describeOutcome(mono)),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      if (this.running) this.schedule();
    }
  }

  /** The last read in words, and the time to the next one. */
  describeOutcome(since) {
    const mono = this.monotonic();
    const refused = this.refusedApplies();
    const next = refused ? undefined : Math.max(0, this.dueAt(mono) - mono);
    const outcome = this.outcome;
    if (!outcome) {
      return refused ? this.currentStatus()[1] : T.test.notYet(next, POLL_INTERVAL);
    }
    const ago =
      since !== undefined && outcome.at >= since ? undefined : Math.max(0, mono - outcome.at);
    if (outcome.kind === 'reading') {
      if (this.identityState !== 'ok') return this.currentStatus()[1];
      const held = this.guards.get(`${SITE}|production_index`)?.guard?.held;
      return T.test.reading(
        {
          power: outcome.live.pvPower,
          index: held ? held.to : outcome.live.pvEnergy,
          held: Boolean(held),
          inverters: this.kinds.inverter.devices?.length,
        },
        ago,
        next,
      );
    }
    return T.test.failed(addressOf(this.config), outcome.err, ago, next);
  }
}
