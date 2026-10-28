// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js, external ids) is forever:
// never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held' };

/** The type part of every external id: `ext:<selector>:pvs:<platform id>`. */
export const EXTERNAL_ID_TYPE = 'pvs';

// --- The local API of the PVS (SunStrong "LocalAPI", pypvs) -----------------------

/** HTTPS on the LAN (a self-signed certificate: pinned, src/app.js checkPeer). */
export const DEFAULT_PORT = 443;
/** The user of the local API, fixed by SunStrong. */
export const USERNAME = 'ssm_owner';
/** The password SunStrong documents: the last 5 characters of the PVS serial number. */
export const DERIVED_PASSWORD_LENGTH = 5;
export const USER_AGENT = 'gladys-sunpower-pvs';

export const PATHS = {
  LOGIN: '/auth?login',
  /** `/vars?name=a,b,c` or `/vars?match=prefix`: read only; `set=` is never sent. */
  VARS: '/vars',
};

/** The serial number of the PVS: read without a session, only to make the password. */
export const VAR_SERIAL = '/sys/info/serialnum';

/** The PVS itself, read at every cycle with the live data (its identity: the LAN MAC). */
export const INFO_VARS = {
  mac: '/sys/info/lmac',
  softwareVersion: '/sys/info/sw_rev',
  model: '/sys/info/model',
  hardwareVersion: '/sys/info/hwrev',
};

/** The live data of the site (pypvs models/livedata.py, the LocalAPI example). */
export const LIVE_VARS = {
  time: '/sys/livedata/time',
  pvPower: '/sys/livedata/pv_p',
  pvEnergy: '/sys/livedata/pv_en',
  netPower: '/sys/livedata/net_p',
  netEnergy: '/sys/livedata/net_en',
  loadPower: '/sys/livedata/site_load_p',
  loadEnergy: '/sys/livedata/site_load_en',
  essEnergy: '/sys/livedata/ess_en',
  essPower: '/sys/livedata/ess_p',
  soc: '/sys/livedata/soc',
  backupMinutes: '/sys/livedata/backupTimeRemaining',
  midstate: '/sys/livedata/midstate',
};

/** The devices behind the PVS, one `match` query each (pypvs const.py). */
export const DEVICE_KINDS = ['inverter', 'meter', 'ess', 'transfer_switch'];
export const MATCH = {
  inverter: '/sys/devices/inverter/',
  meter: '/sys/devices/meter/',
  ess: '/sys/devices/ess/',
  transfer_switch: '/sys/devices/transfer_switch/',
};
/** At most this many devices of a kind are read (a PVS6 drives tens of micro-inverters). */
export const MAX_DEVICES = { inverter: 200, meter: 8, ess: 8, transfer_switch: 4 };

// --- Sizes and times of a request ---------------------------------------------------------

/** One request: 15 s for the whole exchange, body included. */
export const REQUEST_TIMEOUT = 15_000;
/** The login and the live data: a few hundred bytes. */
export const SMALL_BYTES = 64 * 1024;
/** A `match` of 200 inverters (12 variables each): about 200 KB. */
export const MATCH_BYTES = 2 * 1024 * 1024;
/** Variables in one answer, at most. */
export const MAX_VALUES = 20_000;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/**
 * The live data every 30 s, never faster, whatever asks for it: SunStrong asks
 * for no query "faster than once every few seconds", above all on SunVault
 * systems.
 */
export const POLL_INTERVAL = 30 * SECOND;
/** The devices (inverters, meters, battery, transfer switch): every 5 minutes (their samples are 5-minute ones). */
export const DEVICES_INTERVAL = 5 * MINUTE;
/** A device kind whose query failed: tried again after 5 min, doubled up to 1 h; never blocking. */
export const DEVICES_RETRY_MIN = 5 * MINUTE;
export const DEVICES_RETRY_MAX = HOUR;
/** The production index (and the other lifetime counters of the site): once a minute at most. */
export const INDEX_INTERVAL = MINUTE;
/** An unreachable PVS or a wrong answer: tries after 30 s, doubled up to 30 minutes. */
export const RETRY_MIN = 30 * SECOND;
export const RETRY_MAX = 30 * MINUTE;
/** HTTP 429 or 5xx of the live data: a pause from 1 min to 6 h, kept in /data. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The time of the last read is written in /data at most once per this delay. */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** The test button answers within this delay (the manifest gives it 30 s). */
export const TEST_ANSWER_WITHIN = 25 * SECOND;
/** `getConfig()` failing at a connection: tried again after 5 s, doubled up to 5 min, without end. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** A sample older than this (against the PVS clock) is never published. */
export const STALE_AFTER = 2 * HOUR;
/** A sample older than this (a device just created) is published with its own date. */
export const DATED_AFTER = 10 * MINUTE;
/** "Accept the held values": the second click comes 3 s to 5 min after the first. */
export const ACCEPT_CONFIRM_AFTER = 3 * SECOND;
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/** A stop saves /data, then waits for the read running at most this long and saves again. */
export const STOP_WAIT = 5 * SECOND;
/** Gladys takes 300 states a minute from an integration: this one sends 250 at most. */
export const STATES_PER_MINUTE = 250;

// --- Bounds of the values --------------------------------------------------------------
/** A power, in W (a home site, a micro-inverter, a meter): beyond is not a reading. */
export const POWER_MAX = 1_000_000;
/** A lifetime counter, in kWh. */
export const ENERGY_MAX = 1_000_000_000;

// --- Plausibility of the lifetime counters (src/guard.js, kW on average) ----------------
/** The site (production, home consumption, a meter): 200 kW on average at most, 0.5 kWh slack. */
export const SITE_LIMITS = { maxKw: 200, slackKwh: 0.5 };
/** One micro-inverter: 2 kW at most (an AC module gives 0.4), 0.05 kWh slack. */
export const INVERTER_LIMITS = { maxKw: 2, slackKwh: 0.05 };
