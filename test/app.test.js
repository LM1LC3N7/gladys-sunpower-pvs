// -----------------------------------------------------------------------------
// The app end to end: the fake Gladys of the SDK, the fake PVS of
// test/fixtures/pvs.js, a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLL_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import {
  FP,
  MAC,
  NOW,
  OTHER_FP,
  PASSWORD,
  SERIAL,
  ess,
  info,
  inverter,
  json,
  live,
} from './fixtures/pvs.js';
import { CONFIG, D, F, HOUR, MINUTE, SECOND, created, setup } from './helpers/app.js';

const SITE_DEVICES = () => [created('site')];
const text = (status) => status?.message?.en ?? '';

test('first read: certificate pinned before the password goes, password from the serial, devices offered', async () => {
  const t = await setup();
  await t.start();
  const paths = t.pvs.requests.map((r) => r.path);
  assert.equal(paths[0], '/vars?name=/sys/info/serialnum');
  assert.equal(t.pvs.requests[0].headers.cookie, undefined);
  assert.equal(paths[1], '/auth?login');
  assert.equal(
    t.pvs.requests[1].headers.authorization,
    `basic ${Buffer.from(`ssm_owner:${PASSWORD}`).toString('base64')}`,
  );
  assert.match(paths[2], /^\/vars\?name=\/sys\/livedata\/time,/);
  assert.ok(paths.includes('/vars?match=/sys/devices/inverter/'));
  assert.ok(paths.every((p) => !p.includes('set=') && !p.includes('dl_cgi')));
  assert.equal(t.store.data.pins['192.168.1.20:443'], FP);
  const ids = t.gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [
    D('inverter-E00987654321001'),
    D('inverter-E00987654321002'),
    D('meter-consumption'),
    D('meter-production'),
    D('site'),
  ]);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.match(text(t.gladys.fake.connectionStatus), /2 micro-inverters, 2 meters/);
  await t.app.stop();
});

test('the serial number, the password and the MAC are never in the logs, /data, the status nor the devices', async () => {
  const t = await setup({ devices: [created('site'), created('meter-production')] });
  await t.start();
  await t.wait(POLL_INTERVAL);
  await t.app.stop();
  const all = JSON.stringify([
    t.lines,
    t.store.data,
    t.gladys.fake.connectionStatuses,
    t.gladys.fake.discoveredDevices,
    t.gladys.fake.states,
    t.gladys.fake.transports,
  ]);
  for (const secret of [SERIAL, PASSWORD, MAC, MAC.replaceAll(':', ''), 'tok1abcdef']) {
    assert.ok(!all.toLowerCase().includes(secret.toLowerCase()), secret);
  }
});

test('values: the site, its production index, the meters; signed grid power; nothing for a battery absent', async () => {
  const t = await setup({
    devices: [created('site'), created('meter-consumption', { role: 'consumption' })],
  });
  await t.start();
  assert.deepEqual(t.statesOf('site', 'production_power'), [2971]);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  assert.deepEqual(t.statesOf('site', 'grid_power'), [-1447]);
  assert.deepEqual(t.statesOf('site', 'home_power'), [1524]);
  assert.deepEqual(t.statesOf('site', 'home_total'), [6148.97]);
  assert.deepEqual(t.statesOf('site', 'battery_power'), []);
  assert.deepEqual(t.statesOf('site', 'production_index_30min'), []);
  assert.deepEqual(t.statesOf('meter-consumption', 'sold_total'), [5842.86]);
  assert.deepEqual(t.statesOf('meter-consumption', 'bought_total'), [0.01]);
  assert.deepEqual(t.statesOf('meter-consumption', 'voltage_l1'), [121.8]);
  await t.app.stop();
});

// --- Pace -----------------------------------------------------------------------------------

test('pace: one read every 30 s, never sooner whatever asks; devices every 5 minutes', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  await t.start();
  const reads = () => t.pvs.count('/vars?name=/sys/livedata');
  const inverters = () => t.pvs.count('/vars?match=/sys/devices/inverter/');
  assert.equal(reads(), 1);
  assert.equal(inverters(), 1);
  // A save of the form, a reconnection, a Discover click, a device created, the test button.
  await t.app.configUpdated(CONFIG);
  await t.app.connected(async () => CONFIG);
  await t.app.scan();
  await t.app.onDeviceCreated(created('inverter-E00987654321001'));
  await t.app.testConnection();
  await t.wait(POLL_INTERVAL - SECOND);
  assert.equal(reads(), 1);
  await t.wait(SECOND);
  assert.equal(reads(), 2);
  await t.wait(4 * MINUTE);
  assert.equal(inverters(), 1);
  await t.wait(MINUTE);
  assert.equal(inverters(), 2);
  await t.app.stop();
});

test('pace: the time of the last read is in /data before the request; a restart waits the interval', async () => {
  const store = createMemoryStore();
  const t = await setup({ store });
  let saved;
  t.pvs.hook = (path) => {
    if (path.startsWith('/vars?name=/sys/livedata')) saved ??= store.data.lastAttemptAt;
  };
  await t.start();
  assert.equal(saved, NOW);
  await t.app.stop();
  const t2 = await setup({ store, now: NOW + 10 * SECOND });
  await t2.start();
  assert.equal(t2.pvs.count('/vars?name=/sys/livedata'), 0);
  await t2.wait(20 * SECOND);
  assert.equal(t2.pvs.count('/vars?name=/sys/livedata'), 1);
  await t2.app.stop();
});

test('pace: a last read dated in the future (clock set back) never stops the reads', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW + 10 * HOUR });
  const t = await setup({ store });
  await t.start();
  assert.equal(t.pvs.count('/vars?name=/sys/livedata'), 0);
  await t.wait(POLL_INTERVAL);
  assert.equal(t.pvs.count('/vars?name=/sys/livedata'), 1);
  await t.app.stop();
});

// --- getConfig ------------------------------------------------------------------------------

test('getConfig failing in connected: retried without end, the status says it, then the reads start', async () => {
  const t = await setup();
  let fails = 2;
  const getConfig = async () => {
    if (fails-- > 0) throw new Error('down');
    return CONFIG;
  };
  t.app.connected(getConfig);
  await t.advance(0);
  await t.app.idle();
  assert.equal(t.gladys.fake.connectionStatus.connected, false);
  assert.match(
    text(t.gladys.fake.connectionStatus),
    /could not be read from Gladys: tried again in 5 s/,
  );
  await t.wait(5 * SECOND);
  assert.match(text(t.gladys.fake.connectionStatus), /tried again in 10 s/);
  await t.wait(10 * SECOND);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  assert.equal(t.pvs.count('/vars?name=/sys/livedata'), 1);
  await t.app.stop();
});

test('getConfig: a save of the form ends the retries of an older connection', async () => {
  const t = await setup();
  let calls = 0;
  t.app.connected(async () => {
    calls += 1;
    throw new Error('down');
  });
  await t.advance(0);
  await t.app.idle();
  await t.app.configUpdated(CONFIG);
  await t.advance(0);
  await t.wait(10 * MINUTE);
  assert.equal(calls, 1);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

// --- Devices, secondary queries ----------------------------------------------------------------

test('a kind of device failing never holds back the live data nor the other kinds; retried 5 min doubled', async () => {
  const t = await setup({ devices: [created('site'), created('inverter-E00987654321001')] });
  t.pvs.hook = (path) => {
    if (path === '/vars?match=/sys/devices/meter/') return json(500, 'boom');
  };
  await t.start();
  assert.deepEqual(t.statesOf('site', 'production_power'), [2971]);
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'power'), [297]);
  assert.match(text(t.gladys.fake.connectionStatus), /meters could not be read/);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  const meters = () => t.pvs.count('/vars?match=/sys/devices/meter/');
  // A 500 on a session used once: a new session, then the 500 again: a failure of that kind.
  const before = meters();
  await t.wait(5 * MINUTE);
  assert.ok(meters() > before);
  const afterFirstRetry = meters();
  await t.wait(5 * MINUTE);
  assert.equal(meters(), afterFirstRetry, 'doubled: 10 min');
  await t.wait(5 * MINUTE);
  assert.ok(meters() > afterFirstRetry);
  // No pause of the live data for a secondary 5xx.
  assert.equal(t.store.data.pause, null);
  await t.app.stop();
});

test('a battery listed: its device and the battery features of the site', async () => {
  const t = await setup();
  t.pvs.devices.ess = [ess()];
  t.pvs.live = live(NOW, {
    '/sys/livedata/ess_p': '-0.500000',
    '/sys/livedata/backupTimeRemaining': '570',
  });
  await t.start();
  const site = t.gladys.fake.discoveredDevices.find((d) => d.external_id === D('site'));
  const keys = site.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys.includes('battery_power') && keys.includes('backup_time'));
  const battery = t.gladys.fake.discoveredDevices.find(
    (d) => d.external_id === D('ess-ESS-TEST-UNIT-00001'),
  );
  assert.ok(battery);
  await t.app.stop();
  const t2 = await setup({ devices: [created('site'), created('ess-ESS-TEST-UNIT-00001')] });
  t2.pvs.devices.ess = [ess()];
  t2.pvs.live = t.pvs.live;
  await t2.start();
  assert.deepEqual(t2.statesOf('site', 'battery_power'), [-500]);
  assert.deepEqual(t2.statesOf('site', 'backup_time'), [570]);
  assert.deepEqual(t2.statesOf('ess-ESS-TEST-UNIT-00001', 'soc'), [65]);
  await t2.app.stop();
});

test('texts and "nan" are never published as 0; 0 V is not a voltage', async () => {
  const t = await setup({
    devices: [created('site'), created('meter-production', { role: 'production' })],
  });
  t.pvs.live = live(NOW, {
    '/sys/livedata/pv_p': 'nan',
    '/sys/livedata/net_p': '',
    '/sys/livedata/site_load_p': 'N/A',
    '/sys/livedata/pv_en': '0',
    '/sys/livedata/site_load_en': 'TBD',
  });
  await t.start();
  for (const key of [
    'production_power',
    'grid_power',
    'home_power',
    'production_index',
    'home_total',
  ]) {
    assert.deepEqual(t.statesOf('site', key), [], key);
  }
  assert.deepEqual(t.statesOf('meter-production', 'voltage_l1'), []);
  assert.deepEqual(t.statesOf('meter-production', 'voltage_l1_l2'), [243.6]);
  await t.app.stop();
});

// --- Samples ----------------------------------------------------------------------------------

test('a device sample is published once, not again after a restart; a stale one never', async () => {
  const store = createMemoryStore();
  const devices = [created('inverter-E00987654321001')];
  const t = await setup({ devices, store });
  await t.start();
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'power'), [297]);
  await t.wait(5 * MINUTE);
  assert.equal(t.statesOf('inverter-E00987654321001', 'power').length, 1, 'same msmtEps');
  await t.app.stop();
  const t2 = await setup({ devices, store, now: t.clock.now + MINUTE });
  t2.pvs.clock.now = t.clock.now;
  await t2.start();
  await t2.wait(POLL_INTERVAL);
  assert.deepEqual(t2.statesOf('inverter-E00987654321001', 'power'), [], 'not new after a restart');
  // A new sample 5 minutes later: published.
  t2.pvs.devices.inverter[0] = inverter('E00987654321001', NOW + 5 * MINUTE, { p3phsumKw: 0.31 });
  await t2.wait(5 * MINUTE);
  assert.deepEqual(t2.statesOf('inverter-E00987654321001', 'power'), [310]);
  await t2.app.stop();
});

test('stale: a sample more than 2 h older than the clock of the PVS is not published', async () => {
  const t = await setup({
    devices: [created('inverter-E00987654321001'), created('site')],
    now: NOW + 3 * HOUR,
  });
  await t.start();
  // The live data is current (its time follows the PVS clock), the inverter is 3 h old.
  t.pvs.live = live(NOW + 3 * HOUR);
  await t.wait(POLL_INTERVAL);
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'power'), []);
  assert.ok(t.statesOf('site', 'production_power').length > 0);
  await t.app.stop();
});

test('stale: with no readable clock of the PVS, a sample is never taken as expired', async () => {
  const t = await setup({ devices: [created('inverter-E00987654321001')], now: NOW + 3 * HOUR });
  t.pvs.dateHeader = null;
  t.pvs.live = live(NOW, { '/sys/livedata/time': 'nan' });
  await t.start();
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'power'), [297]);
  await t.app.stop();
});

// --- Lifetime counters -----------------------------------------------------------------------

const setPv = (t, kwh, at) => {
  t.pvs.live = live(at ?? t.clock.now, { '/sys/livedata/pv_en': String(kwh) });
};

test('counters: never 0; a drop and a jump held, shown, never confirmed by time nor repetition', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  await t.start();
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  setPv(t, 0);
  await t.wait(MINUTE);
  setPv(t, 100);
  await t.wait(MINUTE);
  assert.match(
    text(t.gladys.fake.connectionStatus),
    /production index of the site dropped from 11992.03 to 100 kWh/,
  );
  for (let i = 0; i < 30; i += 1) await t.wait(HOUR);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  const badge = t.gladys.fake.transports.at(-1);
  assert.equal(badge.degraded, true);
  setPv(t, 99999);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  assert.match(text(t.gladys.fake.connectionStatus), /jumped from 11992.03 to 99999 kWh/);
  assert.equal(t.store.data.counters['site|production_index'].held.direction, 'up');
  await t.app.stop();
});

test('counters: a plausible rise goes through; Gladys gets the guard only after /data holds it', async () => {
  const store = createMemoryStore();
  const t = await setup({ devices: SITE_DEVICES(), store });
  await t.start();
  setPv(t, 11992.5);
  store.failSave = true;
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03], 'save failed: held');
  assert.ok(t.statesOf('site', 'production_power').length >= 1, 'live values go on');
  assert.match(text(t.gladys.fake.connectionStatus), /cannot be written/);
  store.failSave = false;
  setPv(t, 11992.6);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03, 11992.6]);
  await t.app.stop();
});

test('accept: two clicks, 3 s to 5 min apart; the second takes only what was listed', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  await t.start();
  setPv(t, 20000);
  await t.wait(MINUTE);
  assert.match((await t.app.acceptHeld()).en, /Click again within 5 min/);
  // Too soon: listed again, nothing taken.
  assert.match((await t.app.acceptHeld()).en, /Click again/);
  await t.wait(5 * SECOND);
  const done = await t.app.acceptHeld();
  assert.match(done.en, /Accepted, published at the next read/);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03, 20000]);
  assert.match((await t.app.acceptHeld()).en, /Nothing is held back/);
  await t.app.stop();
});

test('accept: a drop is a way out too (a counter set back), counted as nothing', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  await t.start();
  setPv(t, 5);
  await t.wait(MINUTE);
  await t.app.acceptHeld();
  await t.wait(5 * SECOND);
  await t.app.acceptHeld();
  await t.wait(MINUTE);
  setPv(t, 5.2);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03, 5, 5.2]);
  await t.app.stop();
});

test('accept: a value changed between the clicks, a late second click, a save of the form: nothing taken', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  await t.start();
  setPv(t, 20000);
  await t.wait(MINUTE);
  await t.app.acceptHeld();
  setPv(t, 30000);
  await t.wait(MINUTE);
  assert.match((await t.app.acceptHeld()).en, /Changed since the first click, not accepted/);
  await t.app.acceptHeld();
  await t.wait(6 * MINUTE);
  assert.match((await t.app.acceptHeld()).en, /Click again/, 'too late: a new list');
  // A save of the form takes nothing; a list belongs to its session.
  await t.app.configUpdated({ ...CONFIG, password: PASSWORD });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  assert.match((await t.app.acceptHeld()).en, /Click again/, 'another session: a new list');
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  await t.app.stop();
});

test('counters run on the session clock: NTP moving the wall clock 10 h never widens the margin', async () => {
  const wall = { offset: 0 };
  const t = await setup({ devices: SITE_DEVICES(), wall });
  await t.start();
  wall.offset = 10 * HOUR;
  // 1500 kWh in 1 minute: plausible over 10 h of wall clock (200 kW), not over 1 minute.
  setPv(t, 11992.03 + 1500);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  assert.match(text(t.gladys.fake.connectionStatus), /jumped/);
  await t.app.stop();
});

test('counters: a held value survives a restart; the dates kept are wall dates of the moment written', async () => {
  const store = createMemoryStore();
  const t = await setup({ devices: SITE_DEVICES(), store });
  await t.start();
  setPv(t, 50000);
  await t.wait(MINUTE);
  await t.app.stop();
  const t2 = await setup({ devices: SITE_DEVICES(), store, now: t.clock.now + MINUTE });
  setPv(t2, 50000);
  await t2.start();
  await t2.wait(POLL_INTERVAL);
  assert.match(text(t2.gladys.fake.connectionStatus), /jumped from 11992.03 to 50000 kWh/);
  assert.deepEqual(t2.statesOf('site', 'production_index'), []);
  await t2.app.stop();
});

test('a device created again: no reference of the old one; its values come with the next sample', async () => {
  const t = await setup({ devices: [created('inverter-E00987654321001')] });
  await t.start();
  const again = created('inverter-E00987654321001', { id: 'device-2' });
  t.gladys.fake.devices.splice(0, t.gladys.fake.devices.length, again);
  t.gladys.devices.splice(0, t.gladys.devices.length, again);
  await t.app.onDeviceCreated(again);
  await t.wait(POLL_INTERVAL);
  assert.deepEqual(
    t.statesOf('inverter-E00987654321001', 'power'),
    [297],
    'never sent again as new',
  );
  t.pvs.devices.inverter[0] = inverter('E00987654321001', NOW + 5 * MINUTE, { ltea3phsumKwh: 10 });
  await t.wait(5 * MINUTE);
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'lifetime'), [2843.847, 10]);
  await t.app.stop();
});

test('a sample more than 10 minutes old is sent with its own date, never as new', async () => {
  const t = await setup({ devices: [created('inverter-E00987654321001')], now: NOW + 30 * MINUTE });
  t.pvs.live = live(NOW + 30 * MINUTE);
  await t.start();
  const sent = t.gladys.fake.states.filter(
    (s) => s.device_feature_external_id === F('inverter-E00987654321001', 'power'),
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].created_at, new Date(NOW).toISOString());
  await t.app.stop();
});

// --- Identity -------------------------------------------------------------------------------

test('identity: another PVS at the address publishes nothing until accepted in two clicks', async () => {
  const store = createMemoryStore();
  const t = await setup({ devices: SITE_DEVICES(), store });
  await t.start();
  const identity = store.data.identity;
  assert.match(identity, /^[0-9a-f]{64}$/);
  t.pvs.info = info({ '/sys/info/lmac': '02:aa:bb:cc:dd:99' });
  setPv(t, 11993);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03]);
  assert.equal(t.statesOf('site', 'production_power').length, 1);
  assert.equal(t.gladys.fake.connectionStatus.connected, false);
  assert.match(text(t.gladys.fake.connectionStatus), /Another PVS answers/);
  assert.match((await t.app.acceptHeld()).en, /the new PVS at this address/);
  await t.wait(5 * SECOND);
  assert.match((await t.app.acceptHeld()).en, /New PVS accepted/);
  assert.notEqual(store.data.identity, identity);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03, 11993]);
  await t.app.stop();
});

test('identity: a MAC that cannot be read is not another PVS, and publishes nothing', async () => {
  const store = createMemoryStore();
  const t = await setup({ devices: SITE_DEVICES(), store });
  t.pvs.info = info({ '/sys/info/lmac': 'TBD' });
  await t.start();
  assert.deepEqual(t.statesOf('site', 'production_power'), []);
  assert.equal(store.data.identity, null);
  assert.match(text(t.gladys.fake.connectionStatus), /MAC address could not be checked/);
  t.pvs.info = info();
  await t.wait(POLL_INTERVAL);
  assert.deepEqual(t.statesOf('site', 'production_power'), [2971]);
  await t.app.stop();
});

// --- Certificate ------------------------------------------------------------------------------

test('certificate: another one than pinned: nothing sent, its fingerprint shown; typed, it is trusted', async () => {
  const store = createMemoryStore();
  const t = await setup({ devices: SITE_DEVICES(), store });
  await t.start();
  const sent = t.pvs.requests.length;
  t.pvs.fingerprint = OTHER_FP;
  await t.wait(POLL_INTERVAL);
  assert.equal(t.pvs.requests.length, sent, 'nothing written to the other certificate');
  assert.match(text(t.gladys.fake.connectionStatus), new RegExp(OTHER_FP));
  assert.equal(store.data.pins['192.168.1.20:443'], FP);
  assert.equal(store.data.certChanged.seen, OTHER_FP);
  // Typed with spaces and lowercase: normalized.
  await t.app.configUpdated({
    ...CONFIG,
    certificate_fingerprint: OTHER_FP.toLowerCase().replaceAll(':', ' '),
  });
  await t.wait(10 * MINUTE);
  assert.ok(t.pvs.requests.length > sent);
  assert.equal(store.data.pins['192.168.1.20:443'], OTHER_FP);
  assert.equal(store.data.certChanged, null);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

test('certificate: a typed fingerprint that is not the one met sends nothing', async () => {
  const t = await setup({ config: { ...CONFIG, certificate_fingerprint: OTHER_FP } });
  await t.start({ ...CONFIG, certificate_fingerprint: OTHER_FP });
  assert.equal(t.pvs.requests.length, 0);
  assert.match(text(t.gladys.fake.connectionStatus), /not the fingerprint typed/);
  await t.app.stop();
});

test('/data unreadable: no certificate learned, nothing sent, the file never overwritten', async () => {
  const store = createMemoryStore({ lastAttemptAt: 1 });
  store.broken = true;
  const t = await setup({ store });
  await t.start();
  assert.equal(t.pvs.requests.length, 0);
  assert.match(
    text(t.gladys.fake.connectionStatus),
    /\/data cannot be read: no certificate learned/,
  );
  assert.equal(store.saves, 0);
  assert.equal(store.data.lastAttemptAt, 1);
  await t.app.stop();
});

test('/data unreadable with a typed fingerprint: read, but no value published (identity unknown)', async () => {
  const store = createMemoryStore();
  store.broken = true;
  const cfg = { ...CONFIG, certificate_fingerprint: FP };
  const t = await setup({ store, devices: SITE_DEVICES(), config: cfg });
  await t.start(cfg);
  assert.ok(t.pvs.requests.length > 0);
  assert.deepEqual(t.statesOf('site', 'production_index'), []);
  assert.deepEqual(t.statesOf('site', 'production_power'), []);
  assert.equal(store.saves, 0);
  await t.app.stop();
});

test('/data not writable at the first connection: the certificate cannot be pinned, nothing sent', async () => {
  const store = createMemoryStore();
  store.failSave = true;
  const t = await setup({ store });
  await t.start();
  assert.equal(t.pvs.requests.length, 0);
  assert.match(
    text(t.gladys.fake.connectionStatus),
    /cannot be written: the certificate cannot be pinned/,
  );
  await t.app.stop();
});

// --- Password --------------------------------------------------------------------------------

test('password refused: kept in /data, never tried again by itself; a new password lifts it', async () => {
  const store = createMemoryStore();
  const t = await setup({ store });
  t.pvs.password = 'other';
  await t.start();
  assert.equal(t.pvs.count('/auth?login'), 1);
  assert.match(
    text(t.gladys.fake.connectionStatus),
    /refuses the password made from its serial number/,
  );
  assert.equal(store.data.refused.typed, false);
  await t.wait(HOUR);
  assert.equal(t.pvs.count('/auth?login'), 1);
  await t.app.stop();
  // After a restart: still refused, nothing sent.
  const t2 = await setup({ store, now: NOW + HOUR });
  t2.pvs.password = 'other';
  await t2.start();
  await t2.wait(HOUR);
  assert.equal(t2.pvs.requests.length, 0);
  // Another password typed: tried.
  await t2.app.configUpdated({ ...CONFIG, password: 'other' });
  await t2.wait(0);
  assert.equal(t2.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, null);
  await t2.app.stop();
});

test('password refused: the test button tries once, a success lifts the refusal', async () => {
  const t = await setup();
  t.pvs.password = 'other';
  await t.start();
  await t.wait(POLL_INTERVAL);
  t.pvs.password = PASSWORD;
  const answer = await t.app.testConnection();
  assert.match(answer.en, /Read now: production 2971 W/);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

test('no serial number without a session: the status asks for the password; a typed one never reads it', async () => {
  const t = await setup();
  t.pvs.serialPublic = false;
  await t.start();
  assert.match(
    text(t.gladys.fake.connectionStatus),
    /does not give its serial number: type the password/,
  );
  await t.app.configUpdated({ ...CONFIG, password: PASSWORD });
  await t.wait(10 * MINUTE);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  const serialReads = t.pvs.requests.filter((r) => r.path.includes('serialnum'));
  assert.equal(serialReads.length, 1, 'only the read before the password was typed');
  await t.app.stop();
});

test('an expired session: a new login once, the read goes on', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  await t.start();
  t.pvs.expire();
  await t.wait(POLL_INTERVAL);
  assert.equal(t.pvs.count('/auth?login'), 2);
  assert.equal(t.statesOf('site', 'production_power').length, 1);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

// --- Pauses, failures ---------------------------------------------------------------------------

test('429 or 5xx on the live data: a pause kept in /data, honored after a restart', async () => {
  const store = createMemoryStore();
  const t = await setup({ store });
  await t.start();
  t.pvs.hook = (path) =>
    path.startsWith('/vars?name=/sys/livedata')
      ? json(429, 'slow down', { 'retry-after': '600' })
      : undefined;
  await t.wait(POLL_INTERVAL);
  assert.equal(store.data.pause.code, 'rate_limited');
  assert.match(text(t.gladys.fake.connectionStatus), /too many requests.*paused for 10 min/);
  const count = t.pvs.requests.length;
  await t.wait(5 * MINUTE);
  assert.equal(t.pvs.requests.length, count);
  await t.app.stop();
  const t2 = await setup({ store, now: t.clock.now + MINUTE });
  await t2.start();
  await t2.wait(3 * MINUTE);
  assert.equal(t2.pvs.requests.length, 0);
  await t2.wait(2 * MINUTE);
  assert.ok(t2.pvs.requests.length > 0);
  await t2.app.stop();
});

test('unreachable: retried after 30 s doubled, the status says it, the next success clears it', async () => {
  const t = await setup();
  const err = Object.assign(new Error('x'), { code: 'unreachable' });
  t.pvs.hook = () => {
    throw err;
  };
  await t.start();
  assert.match(text(t.gladys.fake.connectionStatus), /unreachable.*next try in 30 s/);
  await t.wait(30 * SECOND);
  assert.match(text(t.gladys.fake.connectionStatus), /next try in 1 min/);
  t.pvs.hook = undefined;
  await t.wait(MINUTE);
  assert.equal(t.gladys.fake.connectionStatus.connected, true);
  await t.app.stop();
});

test('a late answer of an old session publishes nothing and sets no status', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  let release;
  t.pvs.hook = (path) =>
    path.startsWith('/vars?name=/sys/livedata')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  await t.app.start(CONFIG);
  const running = t.advance(0);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  t.pvs.hook = undefined;
  // The address changes while the old read waits for its answer.
  await t.app.configUpdated({ address: '192.168.1.21' });
  const statuses = t.gladys.fake.connectionStatuses.length;
  const peers = t.pvs.peers;
  // A full, valid answer: the old read would go on to the devices.
  const all = t.pvs.vars();
  const values = Object.keys(all)
    .filter((n) => n.startsWith('/sys/livedata/') || n.startsWith('/sys/info/'))
    .map((name) => ({ name, value: all[name] }));
  release(json(200, { values, count: values.length }));
  await running;
  await t.app.idle();
  assert.deepEqual(t.statesOf('site', 'production_power'), []);
  assert.equal(t.gladys.fake.connectionStatuses.length, statuses, 'no status from the old read');
  assert.equal(t.pvs.peers, peers, 'the old read goes no further: not even a handshake');
  // Nothing of the old answer is taken for the new address.
  assert.match(
    t.app.currentStatus()[1].en,
    /Waiting for the first read of the PVS at 192\.168\.1\.21/,
  );
  await t.app.stop();
});

// --- Budget and ids --------------------------------------------------------------------------

test('200 micro-inverters: never more than 250 states a minute, every sample sent in the end', async () => {
  const sns = Array.from({ length: 200 }, (_, i) => `E0098765432${String(i).padStart(4, '0')}`);
  const devices = sns.map((sn) => created(`inverter-${sn}`));
  const t = await setup({ devices });
  t.pvs.devices.inverter = sns.map((sn) => inverter(sn));
  const batches = [];
  const publish = t.gladys.publishChangedStates.bind(t.gladys);
  t.gladys.publishChangedStates = (states, options) => {
    batches.push({ at: t.clock.now, count: states.length });
    return publish(states, options);
  };
  await t.start();
  for (let i = 0; i < 30; i += 1) await t.wait(POLL_INTERVAL);
  for (const b of batches) {
    const inMinute = batches
      .filter((o) => o.at <= b.at && b.at - o.at < MINUTE)
      .reduce((n, o) => n + o.count, 0);
    assert.ok(inMinute <= 250, `${inMinute} states in a minute`);
  }
  const sent = new Set(
    t.gladys.fake.states
      .filter((s) => s.device_feature_external_id.endsWith(':power'))
      .map((s) => s.device_feature_external_id),
  );
  assert.equal(sent.size, 200);
  await t.app.stop();
});

test('an id that would hold the password is never made', async () => {
  const t = await setup();
  t.pvs.devices.inverter = [inverter(`E001${PASSWORD}`), inverter('E00987654321002')];
  await t.start();
  const ids = t.gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.ok(!ids.some((id) => id.includes(PASSWORD)));
  assert.ok(ids.includes(D('inverter-E00987654321002')));
  assert.match(
    text(t.gladys.fake.connectionStatus),
    /1 device\(s\) whose serial number holds the password/,
  );
  await t.app.stop();
});

test('the value Gladys already holds is the first reference: a lower reading is held', async () => {
  const devices = [
    created('site', { values: { production_index: { value: 20000, at: NOW - HOUR } } }),
  ];
  const t = await setup({ devices });
  await t.start();
  assert.equal(t.gladys.fake.lastState(F('site', 'production_index')), undefined);
  assert.match(text(t.gladys.fake.connectionStatus), /dropped from 20000 to 11992.03 kWh/);
  await t.app.stop();
});

test('accept on a micro-inverter: its counter sent at the next read, its plain values not again', async () => {
  const t = await setup({ devices: [created('inverter-E00987654321001')] });
  await t.start();
  t.pvs.devices.inverter[0] = inverter('E00987654321001', NOW + 5 * MINUTE, {
    ltea3phsumKwh: 5000,
    p3phsumKw: 0.3,
  });
  await t.wait(5 * MINUTE);
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'lifetime'), [2843.847]);
  assert.match(
    (await t.app.acceptHeld()).en,
    /lifetime production \(inverter-E00987654321001\) jumped/,
  );
  await t.wait(5 * SECOND);
  assert.match((await t.app.acceptHeld()).en, /Accepted/);
  await t.wait(POLL_INTERVAL);
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'lifetime'), [2843.847, 5000]);
  assert.deepEqual(t.statesOf('inverter-E00987654321001', 'power'), [297, 300]);
  await t.app.stop();
});

test('refused: a read asked anyway (a timer left over) sends nothing', async () => {
  const t = await setup();
  t.pvs.password = 'other';
  await t.start();
  const count = t.pvs.requests.length;
  await t.wait(POLL_INTERVAL);
  await t.app.tick();
  assert.equal(t.pvs.requests.length, count);
  await t.app.stop();
});

test('accept: a list of another session is never taken', async () => {
  const t = await setup({ devices: SITE_DEVICES() });
  await t.start();
  setPv(t, 20000);
  await t.wait(MINUTE);
  await t.app.acceptHeld();
  t.app.pendingAccept = { ...t.app.pendingAccept, session: {} };
  await t.wait(5 * SECOND);
  assert.match((await t.app.acceptHeld()).en, /Click again/);
  await t.app.stop();
});

test('a device created again without an id from Gladys: its counters start over all the same', async () => {
  const old = created('site');
  delete old.id;
  const t = await setup({ devices: [old] });
  await t.start();
  setPv(t, 100);
  await t.wait(MINUTE);
  assert.match(text(t.gladys.fake.connectionStatus), /dropped/);
  await t.app.onDeviceCreated(old);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('site', 'production_index'), [11992.03, 100]);
  await t.app.stop();
});

test('stop: /data written at once, before waiting for the read running', async () => {
  const store = createMemoryStore();
  const t = await setup({ store });
  await t.start();
  t.pvs.hook = (path) =>
    path.startsWith('/vars?name=/sys/livedata') ? new Promise(() => {}) : undefined;
  const reading = t.advance(POLL_INTERVAL);
  while (t.pvs.count('/vars?name=/sys/livedata') < 2) await new Promise((r) => setImmediate(r));
  assert.equal(store.data.lastAttemptAt, NOW, 'the attempt at 30 s is not saved yet');
  const stopping = t.app.stop();
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(store.data.lastAttemptAt > NOW + POLL_INTERVAL - SECOND);
  await t.advance(10 * SECOND);
  await stopping;
  void reading;
});

test('no battery listed: no battery feature, even with a battery power of 0 in the live data', async () => {
  const t = await setup();
  t.pvs.live = live(NOW, {
    '/sys/livedata/ess_p': '0.000000',
    '/sys/livedata/backupTimeRemaining': '0',
  });
  await t.start();
  const site = t.gladys.fake.discoveredDevices.find((d) => d.external_id === D('site'));
  const keys = site.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(!keys.includes('battery_power') && !keys.includes('backup_time'));
  await t.app.stop();
});
