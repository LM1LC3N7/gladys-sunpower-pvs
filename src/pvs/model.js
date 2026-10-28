// -----------------------------------------------------------------------------
// The variables of the PVS -> values. Pure. Field names and units from pypvs
// (models/*.py, MIT, SunStrong Management) and the public variable lists of
// its repository (doc/varserver-variables-public-pvs5.csv, -pvs6.csv):
//
// - live data (`/sys/livedata/*`): powers in kW, lifetime energies in kWh,
//   `time` in Unix seconds (pypvs takes milliseconds too);
// - devices (`/sys/devices/<kind>/<index>/<field>`): one sample each, dated by
//   `msmtEps` ("2025-06-28T03:35:00Z"); powers in kW, energies in kWh,
//   voltages in V, currents in A, temperatures in °C, the state of charge of
//   the battery as a fraction (pypvs multiplies it by 100).
//
// Strict values: a number or a decimal text; '', "nan", "N/A", "TBD", null, a
// word are unknown, never 0. A device whose `msmtEps` cannot be read has no
// sample (the PVS lists defaults, `n/a` and 0, before the first one). A voltage
// or a frequency at 0 is "not wired", never a measurement.
// -----------------------------------------------------------------------------

import { ENERGY_MAX, INFO_VARS, LIVE_VARS, MAX_DEVICES, POWER_MAX } from '../constants.js';

const DECIMAL = /^[-+]?(?:\d{1,15}(?:\.\d{0,12})?|\.\d{1,12})(?:[eE][-+]?\d{1,3})?$/;

/** A number of the PVS: a finite number or a decimal text; anything else is undefined. */
export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!DECIMAL.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** A number within bounds, else undefined. */
const within = (value, min, max) =>
  value !== undefined && value >= min && value <= max ? value : undefined;

/** kW -> W, bounded (signed when `signed`). */
const watts = (value, signed = false) => {
  const kw = numberOf(value);
  if (kw === undefined) return undefined;
  return within(kw * 1000, signed ? -POWER_MAX : 0, POWER_MAX);
};
/** A production power: a small negative reading (standby draw at night) is 0 W. */
const productionWatts = (value) => {
  const w = watts(value, true);
  if (w === undefined) return undefined;
  return w < 0 ? (w >= -500 ? 0 : undefined) : w;
};
/** A lifetime energy (kWh), above 0 (0 is "not counted yet", never a value). */
const lifetime = (value) => {
  const kwh = numberOf(value);
  return kwh !== undefined && kwh > 0 && kwh <= ENERGY_MAX ? kwh : undefined;
};
/** A voltage (V): 0 is "not wired". */
const volts = (value) => {
  const v = numberOf(value);
  return v !== undefined && v > 0 && v <= 1000 ? v : undefined;
};
const amps = (value) => within(numberOf(value), -1000, 1000);
const hertz = (value) => within(numberOf(value), 40, 70);
const celsius = (value) => within(numberOf(value), -60, 150);
/** A fraction 0..1 -> percent. */
const percentOfFraction = (value) => {
  const f = within(numberOf(value), 0, 1);
  return f === undefined ? undefined : Math.round(f * 1000) / 10;
};

/** A short printable text of the PVS (model, version), or undefined. */
export function labelOf(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return /^[\x20-\x7e]{1,64}$/.test(text) && !/^(n\/a|tbd|unknown)$/i.test(text) ? text : undefined;
}

/** "2025-06-28T03:35:00Z" -> ms, strictly (UTC, seconds), else undefined. */
export function sampleTimeOf(value) {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value.trim());
  if (!m) return undefined;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Before 2015 is the default of a device never heard (1970), not a sample.
  return Number.isFinite(at) && at >= Date.UTC(2015, 0, 1) ? at : undefined;
}

/** Unix seconds (or milliseconds, as pypvs takes them) -> ms, else undefined. */
export function liveTimeOf(value) {
  const n = numberOf(value);
  if (n === undefined || !Number.isInteger(n) || n <= 0) return undefined;
  const ms = n > 1e12 ? n : n * 1000;
  return ms >= Date.UTC(2015, 0, 1) && ms <= Date.UTC(2100, 0, 1) ? ms : undefined;
}

/** The LAN MAC of the PVS, 12 lowercase hex digits, or undefined. */
export function macOf(value) {
  if (typeof value !== 'string') return undefined;
  const hex = value.trim().replace(/[:-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(hex) && !/^0+$/.test(hex) && !/^f+$/.test(hex) ? hex : undefined;
}

/** The PVS itself: its MAC (identity, never published), model and versions. */
export function infoOf(vars) {
  return {
    mac: macOf(vars.get(INFO_VARS.mac)),
    model: labelOf(vars.get(INFO_VARS.model)),
    softwareVersion: labelOf(vars.get(INFO_VARS.softwareVersion)),
    hardwareVersion: labelOf(vars.get(INFO_VARS.hardwareVersion)),
  };
}

/** The live data of the site (W, kWh), undefined where the PVS gives none. */
export function liveOf(vars) {
  const v = (key) => vars.get(LIVE_VARS[key]);
  const backup = numberOf(v('backupMinutes'));
  return {
    at: liveTimeOf(v('time')),
    pvPower: productionWatts(v('pvPower')),
    pvEnergy: lifetime(v('pvEnergy')),
    netPower: watts(v('netPower'), true),
    loadPower: watts(v('loadPower')),
    loadEnergy: lifetime(v('loadEnergy')),
    essPower: watts(v('essPower'), true),
    backupMinutes:
      backup !== undefined && Number.isInteger(backup) && backup >= 0 && backup <= 100_000
        ? backup
        : undefined,
  };
}

const INDEX = /^\d{1,4}$/;
const FIELD = /^[A-Za-z0-9]{1,40}$/;

/**
 * The devices of one kind from a `match` answer: `/sys/devices/<kind>/<i>/<f>`
 * grouped by index, `[{ index, fields }]` sorted by index (at most
 * MAX_DEVICES[kind]; `more` when there were more). Any other name is skipped.
 */
export function groupDevices(vars, kind) {
  const prefix = `/sys/devices/${kind}/`;
  const groups = new Map();
  for (const [name, value] of vars) {
    if (!name.startsWith(prefix)) continue;
    const [index, field, ...rest] = name.slice(prefix.length).split('/');
    if (rest.length > 0 || !INDEX.test(index ?? '') || !FIELD.test(field ?? '')) continue;
    const i = Number(index);
    if (!groups.has(i)) groups.set(i, new Map());
    groups.get(i).set(field, value);
  }
  const all = [...groups.keys()].sort((a, b) => a - b);
  const max = MAX_DEVICES[kind] ?? 0;
  return {
    devices: all.slice(0, max).map((index) => ({ index, fields: groups.get(index) })),
    more: all.length > max,
  };
}

/** A serial number we may make an id of: letters, digits, `-`, `_` (never `:` nor `.`). */
export const serialOf = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value.trim())
    ? value.trim()
    : undefined;

/** A micro-inverter (pypvs models/inverter.py). */
export function inverterOf(fields) {
  const f = (key) => fields.get(key);
  return {
    sn: serialOf(f('sn')),
    model: labelOf(f('prodMdlNm')),
    at: sampleTimeOf(f('msmtEps')),
    power: productionWatts(f('p3phsumKw')),
    lifetime: lifetime(f('ltea3phsumKwh')),
    voltage: volts(f('vln3phavgV')),
    current: amps(f('i3phsumA')),
    frequency: hertz(f('freqHz')),
    temperature: celsius(f('tHtsnkDegc')),
    dcPower: productionWatts(f('pMppt1Kw')),
    dcVoltage: within(numberOf(f('vMppt1V')), 0, 1000),
    dcCurrent: within(numberOf(f('iMppt1A')), 0, 100),
  };
}

/**
 * The role of a meter from its model name: the PVS6 built-in production
 * meter ends in `p` ("PVS6M0400p"), the consumption meter in `c`.
 */
export function meterRoleOf(model) {
  if (!model) return undefined;
  if (/p$/.test(model)) return 'production';
  if (/c$/.test(model)) return 'consumption';
  return undefined;
}

/** A meter (pypvs models/meter.py). Its serial number is never used (src/devices.js). */
export function meterOf(fields) {
  const f = (key) => fields.get(key);
  const model = labelOf(f('prodMdlNm'));
  return {
    model,
    role: meterRoleOf(model),
    at: sampleTimeOf(f('msmtEps')),
    power: watts(f('p3phsumKw'), true),
    imported: lifetime(f('posLtea3phsumKwh')),
    exported: lifetime(f('negLtea3phsumKwh')),
    net: lifetime(f('netLtea3phsumKwh')),
    voltageL1L2: volts(f('v12V')),
    voltageL1: volts(f('v1nV')),
    voltageL2: volts(f('v2nV')),
    currentL1: amps(f('i1A')),
    currentL2: amps(f('i2A')),
    frequency: hertz(f('freqHz')),
  };
}

/** A SunVault battery (pypvs models/ess.py). */
export function essOf(fields) {
  const f = (key) => fields.get(key);
  return {
    sn: serialOf(f('sn')),
    model: labelOf(f('prodMdlNm')),
    at: sampleTimeOf(f('msmtEps')),
    power: watts(f('p3phsumKw'), true),
    soc: percentOfFraction(f('socVal')),
    batteryVoltage: volts(f('vBattV')),
    temperature: celsius(f('tInvtrDegc')),
  };
}

/**
 * The MID state of a transfer switch: 1 closed (the site on the grid), 0
 * open; any other text (unknown to pypvs' fixtures) is no value.
 */
export function midStateOf(value) {
  if (value === 'MID_STATE_CLOSED') return 1;
  if (value === 'MID_STATE_OPEN') return 0;
  return undefined;
}

/** A transfer switch (pypvs models/transfer_switch.py). */
export function transferSwitchOf(fields) {
  const f = (key) => fields.get(key);
  return {
    sn: serialOf(f('sn')),
    model: labelOf(f('prodMdlNm')),
    at: sampleTimeOf(f('msmtEps')),
    midClosed: midStateOf(f('midStEnum')),
    temperature: celsius(f('tDegc')),
    gridVoltageL1: volts(f('v1nGridV')),
    gridVoltageL2: volts(f('v2nGridV')),
  };
}

export const PARSERS = {
  inverter: inverterOf,
  meter: meterOf,
  ess: essOf,
  transfer_switch: transferSwitchOf,
};
