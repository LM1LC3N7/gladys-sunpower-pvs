// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the fake PVS of test/fixtures/pvs.js
// and a virtual clock that moves at every read (1 µs), so that a decision
// reading the clock twice is caught. The wall clock may be moved apart
// (`wall.offset`: NTP setting the clock).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SunPowerApp } from '../../src/app.js';
import { CATALOG, buildDevice } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { HOST, NOW, createPvs } from '../fixtures/pvs.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'sunpower-pvs';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const D = (platformId) => `ext:${SELECTOR}:pvs:${platformId}`;
export const F = (platformId, key) => `${D(platformId)}:${key}`;
export const CONFIG = { address: HOST };

const KIND = {
  site: 'site',
  inverter: 'inverter',
  meter: 'meter',
  ess: 'ess',
  switch: 'transfer_switch',
};

/**
 * The device of a platform id as the user created it (every feature of its
 * kind, or `keys`); `values`: `{ key: { value, at } }` Gladys holds.
 */
export function created(
  platformId,
  { keys, values = {}, id = `device-${platformId}-1`, role } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const kind = KIND[platformId === 'site' ? 'site' : platformId.split('-')[0]];
  const all = CATALOG[kind]
    .filter((e) => !e.role || e.role === (role ?? platformId.split('-')[1]))
    .map((e) => e.key);
  const device = buildDevice(
    gladys,
    { kind, platformId, sn: platformId.split('-').slice(1).join('-'), role, index: 0 },
    new Set(keys ?? all),
  );
  device.id = id;
  for (const [key, { value, at }] of Object.entries(values)) {
    const feature = device.features.find((f) => f.external_id === F(platformId, key));
    feature.last_value = value;
    feature.last_value_changed = new Date(at).toISOString();
  }
  return device;
}

export async function setup({
  devices: known = [],
  store,
  now = NOW,
  pvs,
  config = CONFIG,
  random,
  wall = { offset: 0 },
  connect = true,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  if (connect) await gladys.connect();
  const { clock, timers, advance, pending } = createFakeClock(now);
  const device = pvs ?? createPvs({ clock });
  device.clock = clock;
  let drift = 0;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? createMemoryStore();
  const app = new SunPowerApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now + wall.offset,
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store: kept,
    request: device.request,
    ...(random ? { random } : {}),
  });
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
  };
  /** The states published to one feature (values only). */
  const statesOf = (platformId, key) =>
    gladys.fake.states
      .filter((s) => s.device_feature_external_id === F(platformId, key))
      .map((s) => s.state);
  return {
    app,
    gladys,
    clock,
    store: kept,
    pvs: device,
    start,
    wait,
    advance,
    pending,
    lines,
    statesOf,
  };
}
