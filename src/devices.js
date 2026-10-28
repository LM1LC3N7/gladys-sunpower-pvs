// -----------------------------------------------------------------------------
// The Gladys devices of a PVS and their states. Pure.
//
// External ids (forever): `ext:<selector>:pvs:<platform id>`, the platform id:
//   site                       the live data of the site (one PVS per integration)
//   inverter-<serial>          a micro-inverter
//   meter-production           the built-in production meter (model "...p")
//   meter-consumption          the consumption meter (model "...c")
//   meter-<index>              another meter, or a second one of a role
//   ess-<serial>               a SunVault battery
//   switch-<serial>            a transfer switch (MIDC)
// The serial number of a meter is never used: the built-in meters belong to
// the PVS, whose serial number makes the password. Any id holding the
// password is never made (src/app.js).
//
// Energy rules of the Gladys core (server/utils/constants.js) and of this
// project (as gladys-openems, approved):
// - the ONLY index is the production of the site (`energy-production-sensor`
//   / `index`, `/sys/livedata/pv_en`), with its `thirty-minutes-production`
//   declared here (ids computed, UUID v5: an "Update" in Discovery keeps the
//   same rows; the integration never publishes that one);
// - NO `energy-sensor` / `index`, no `daily-consumption`, never
//   publishEnergyConsumption: what the home draws and buys is counted by the
//   utility meter; counted twice, it would be billed twice. Every other
//   lifetime counter (home consumption, bought, sold, a micro-inverter, a
//   meter) is a plain sensor, kWh in the name;
// - every lifetime counter (the index and the plain ones) goes through the
//   guard (src/guard.js): never 0, never a drop nor a jump published without
//   the user (src/app.js);
// - signed powers (grid, battery) are ONE signed plain sensor each, the sign
//   in the name;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY), none for `unknown` (in the name).
//
// The features follow what the PVS showed: the set only grows, and always
// holds the features of the created device, so a device published again
// never loses one (an "Update" in Discovery would drop its history).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  ENERGY_MAX,
  EXTERNAL_ID_TYPE,
  INVERTER_LIMITS,
  POWER_MAX,
  SITE_LIMITS,
} from './constants.js';

export const SITE = 'site';

/** The external ids of a device of the PVS. */
export const ids = (gladys, platformId) => gladys.externalIds(EXTERNAL_ID_TYPE, platformId);

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('1b92d8de49a39ae6c2deb77da5ef23f5', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name (as gladys-openems). */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- The catalog ------------------------------------------------------------------

const measure = (name, category, type, extra = {}) => ({ name, category, type, ...extra });
/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (name, extra = {}) => measure(name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);
const watts = (name) => plain(`${name} (W)`, { max: POWER_MAX });
const signedWatts = (name) => plain(name, { min: -POWER_MAX, max: POWER_MAX });
const total = (name) => plain(`${name} (kWh, lifetime, not counted)`, { max: ENERGY_MAX });
const productionPower = (name) =>
  measure(name, C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER, {
    unit: U.WATT,
    max: POWER_MAX,
  });
const voltage = (name) =>
  measure(name, C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, { unit: U.VOLT, max: 1000 });
const current = (name) =>
  measure(name, C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, {
    unit: U.AMPERE,
    min: -1000,
    max: 1000,
  });
const temperature = (name) =>
  measure(name, C.DEVICE_TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
    unit: U.CELSIUS,
    min: -60,
    max: 150,
  });
const frequency = () => plain('Grid frequency (Hz)', { min: 40, max: 70 });

/**
 * An entry: the feature key, the value of the sample it shows, its rounding,
 * how it is declared, `counter` (the limits of its guard) for a lifetime
 * counter, `declared` for a feature the core feeds (never a value here).
 */
const def = (key, value, digits, spec, extra = {}) => ({ key, value, digits, spec, ...extra });

/** Feature keys (forever). */
export const FEATURE = {
  PRODUCTION_POWER: 'production_power',
  PRODUCTION_INDEX: 'production_index',
  /** 30-minute production: fed by the Gladys core from the index, never by the integration. */
  PRODUCTION_30MIN: 'production_index_30min',
  GRID_POWER: 'grid_power',
  HOME_POWER: 'home_power',
  HOME_TOTAL: 'home_total',
  BATTERY_POWER: 'battery_power',
  BACKUP_TIME: 'backup_time',
  POWER: 'power',
  LIFETIME: 'lifetime',
  VOLTAGE: 'voltage',
  CURRENT: 'current',
  FREQUENCY: 'frequency',
  TEMPERATURE: 'temperature',
  DC_POWER: 'dc_power',
  DC_VOLTAGE: 'dc_voltage',
  DC_CURRENT: 'dc_current',
  PRODUCTION_TOTAL: 'production_total',
  BOUGHT_TOTAL: 'bought_total',
  SOLD_TOTAL: 'sold_total',
  VOLTAGE_L1_L2: 'voltage_l1_l2',
  VOLTAGE_L1: 'voltage_l1',
  VOLTAGE_L2: 'voltage_l2',
  CURRENT_L1: 'current_l1',
  CURRENT_L2: 'current_l2',
  SOC: 'soc',
  BATTERY_VOLTAGE: 'battery_voltage',
  GRID_RELAY: 'grid_relay',
  GRID_VOLTAGE_L1: 'grid_voltage_l1',
  GRID_VOLTAGE_L2: 'grid_voltage_l2',
};

const F = FEATURE;

export const CATALOG = {
  site: [
    def(F.PRODUCTION_POWER, 'pvPower', 0, productionPower('Production power')),
    def(
      F.PRODUCTION_INDEX,
      'pvEnergy',
      3,
      measure('Production index', C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.INDEX, {
        unit: U.KILOWATT_HOUR,
        max: ENERGY_MAX,
      }),
      { counter: SITE_LIMITS, label: 'production' },
    ),
    def(
      F.PRODUCTION_30MIN,
      undefined,
      3,
      measure(
        'Production index (30-minute production)',
        C.ENERGY_PRODUCTION_SENSOR,
        T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
        { unit: U.KILOWATT_HOUR, max: ENERGY_MAX },
      ),
      { declared: true },
    ),
    def(F.GRID_POWER, 'netPower', 0, signedWatts('Grid power (W, + bought, - sold)')),
    def(F.HOME_POWER, 'loadPower', 0, watts('Home consumption')),
    def(F.HOME_TOTAL, 'loadEnergy', 3, total('Home consumption'), {
      counter: SITE_LIMITS,
      label: 'home',
    }),
    def(
      F.BATTERY_POWER,
      'essPower',
      0,
      signedWatts('Battery power (W, + discharging, - charging)'),
      { battery: true },
    ),
    def(
      F.BACKUP_TIME,
      'backupMinutes',
      0,
      measure('Battery backup time left', C.DURATION, T.DURATION.INTEGER, {
        unit: U.MINUTES,
        max: 100_000,
      }),
      { battery: true },
    ),
  ],
  inverter: [
    def(F.POWER, 'power', 0, productionPower('Production power')),
    def(F.LIFETIME, 'lifetime', 3, total('Production'), {
      counter: INVERTER_LIMITS,
      label: 'inverter',
    }),
    def(F.VOLTAGE, 'voltage', 1, voltage('AC voltage')),
    def(F.CURRENT, 'current', 2, current('AC current')),
    def(F.FREQUENCY, 'frequency', 2, frequency()),
    def(F.TEMPERATURE, 'temperature', 1, temperature('Heat sink temperature')),
    def(F.DC_POWER, 'dcPower', 0, watts('Panel DC power')),
    def(F.DC_VOLTAGE, 'dcVoltage', 1, plain('Panel DC voltage (V)', { max: 1000 })),
    def(F.DC_CURRENT, 'dcCurrent', 2, plain('Panel DC current (A)', { max: 100 })),
  ],
  meter: [
    def(F.POWER, 'power', 0, signedWatts('Power (W, signed as the PVS gives it)')),
    def(F.PRODUCTION_TOTAL, 'net', 3, total('Production'), {
      counter: SITE_LIMITS,
      role: 'production',
      label: 'meterProduction',
    }),
    def(F.BOUGHT_TOTAL, 'imported', 3, total('Bought from the grid'), {
      counter: SITE_LIMITS,
      role: 'consumption',
      label: 'bought',
    }),
    def(F.SOLD_TOTAL, 'exported', 3, total('Sold to the grid'), {
      counter: SITE_LIMITS,
      role: 'consumption',
      label: 'sold',
    }),
    def(F.VOLTAGE_L1_L2, 'voltageL1L2', 1, voltage('Voltage L1-L2')),
    def(F.VOLTAGE_L1, 'voltageL1', 1, voltage('Voltage L1')),
    def(F.VOLTAGE_L2, 'voltageL2', 1, voltage('Voltage L2')),
    def(F.CURRENT_L1, 'currentL1', 2, current('Current L1')),
    def(F.CURRENT_L2, 'currentL2', 2, current('Current L2')),
    def(F.FREQUENCY, 'frequency', 2, frequency()),
  ],
  ess: [
    def(
      F.SOC,
      'soc',
      1,
      measure('State of charge', C.BATTERY_STORAGE, T.BATTERY_STORAGE.BATTERY_LEVEL, {
        unit: U.PERCENT,
        max: 100,
      }),
    ),
    def(F.POWER, 'power', 0, signedWatts('Battery power (W, signed as the PVS gives it)')),
    def(F.BATTERY_VOLTAGE, 'batteryVoltage', 1, plain('Battery voltage (V)', { max: 1000 })),
    def(F.TEMPERATURE, 'temperature', 1, temperature('Inverter temperature')),
  ],
  transfer_switch: [
    def(
      F.GRID_RELAY,
      'midClosed',
      0,
      measure('Grid relay closed (MID state)', C.UNKNOWN, T.SENSOR.BINARY, { max: 1 }),
    ),
    def(F.TEMPERATURE, 'temperature', 1, temperature('Temperature')),
    def(F.GRID_VOLTAGE_L1, 'gridVoltageL1', 1, voltage('Grid voltage L1')),
    def(F.GRID_VOLTAGE_L2, 'gridVoltageL2', 1, voltage('Grid voltage L2')),
  ],
};

/** Every guarded counter: `{ kind, key, label, limits }`. */
export const COUNTERS = Object.entries(CATALOG).flatMap(([kind, entries]) =>
  entries
    .filter((e) => e.counter)
    .map((e) => ({ kind, key: e.key, label: e.label, limits: e.counter })),
);

export const counterOf = (kind, key) => CATALOG[kind]?.find((e) => e.key === key && e.counter);

/** The keys known for a kind. */
const KNOWN = Object.fromEntries(
  Object.entries(CATALOG).map(([kind, entries]) => [kind, new Set(entries.map((e) => e.key))]),
);

/** The feature keys of a created device (its features are fixed at its creation). */
export function keysOfDevice(kind, device) {
  return new Set(
    (device?.features ?? [])
      .map((f) =>
        String(f.external_id ?? '')
          .split(':')
          .at(-1),
      )
      .filter((key) => KNOWN[kind]?.has(key)),
  );
}

/** Keys read back from /data: known keys of that kind only. */
export const validKeys = (kind, keys) =>
  new Set(Array.isArray(keys) ? keys.filter((key) => KNOWN[kind]?.has(key)) : []);

export const union = (...sets) => new Set(sets.flatMap((s) => [...(s ?? [])]));

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The feature keys a sample shows: a value read (a counter above 0), the
 * role of a meter for its counters, the battery features of the site only
 * when the PVS lists a battery. The 30-minute feature comes with the index.
 */
export function capabilitiesOf(kind, sample, { role, battery } = {}) {
  const keys = new Set();
  for (const entry of CATALOG[kind] ?? []) {
    if (entry.declared) continue;
    if (entry.role && entry.role !== role) continue;
    if (entry.battery && !battery) continue;
    const value = sample?.[entry.value];
    if (isNumber(value) && (!entry.counter || value > 0)) keys.add(entry.key);
  }
  if (keys.has(F.PRODUCTION_INDEX)) keys.add(F.PRODUCTION_30MIN);
  return keys;
}

const NAMES = {
  site: () => 'SunPower PVS site',
  inverter: (d) => `SunPower micro-inverter ${d.sn}`,
  meter: (d) =>
    d.role === 'production'
      ? 'SunPower production meter'
      : d.role === 'consumption'
        ? 'SunPower consumption meter'
        : `SunPower meter ${d.index}`,
  ess: (d) => `SunVault battery ${d.sn}`,
  transfer_switch: (d) => `SunPower transfer switch ${d.sn}`,
};

/**
 * The device of the PVS. `entry`: `{ kind, platformId, sn, role, index,
 * model }` (src/app.js); `keys`: the feature keys to give it (a Set);
 * `params`: `[{ name, value }]`.
 */
export function buildDevice(gladys, entry, keys, params = []) {
  const external = ids(gladys, entry.platformId);
  const indexId = external.feature(F.PRODUCTION_INDEX);
  const features = (CATALOG[entry.kind] ?? [])
    .filter((e) => keys.has(e.key))
    .map(({ key, spec }) => {
      const feature = {
        min: 0,
        read_only: true,
        has_feedback: false,
        keep_history: true,
        ...spec,
        external_id: external.feature(key),
      };
      if (key === F.PRODUCTION_INDEX) {
        feature.id = uuidOf(indexId);
      } else if (key === F.PRODUCTION_30MIN) {
        feature.id = uuidOf(external.feature(F.PRODUCTION_30MIN));
        feature.energy_parent_id = uuidOf(indexId);
      }
      return feature;
    });
  return {
    name: NAMES[entry.kind](entry),
    external_id: external.device,
    features,
    params: params.filter((p) => typeof p.value === 'string' && p.value !== ''),
  };
}

export const round = (value, digits) => {
  const r = Math.round(value * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * The states of the plain values of a sample (never a counter, never the
 * 30-minute feature): `[{ device_feature_external_id, state }]`.
 */
export function liveStates(gladys, kind, platformId, sample, { battery } = {}) {
  const external = ids(gladys, platformId);
  const states = [];
  for (const entry of CATALOG[kind] ?? []) {
    if (entry.counter || entry.declared) continue;
    if (entry.battery && !battery) continue;
    const value = sample?.[entry.value];
    if (!isNumber(value)) continue;
    states.push({
      device_feature_external_id: external.feature(entry.key),
      state: round(value, entry.digits),
    });
  }
  return states;
}

/** The state of a lifetime counter: never 0 (nor below), whatever the PVS said. */
export const counterState = (gladys, platformId, key, value) =>
  isNumber(value) && value > 0
    ? [{ device_feature_external_id: ids(gladys, platformId).feature(key), state: round(value, 3) }]
    : [];
