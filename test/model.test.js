// -----------------------------------------------------------------------------
// The variables of the PVS -> values (pure): strict numbers, units, samples,
// devices grouped and bounded; and the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseFingerprint, parseHost } from '../src/config.js';
import {
  essOf,
  groupDevices,
  inverterOf,
  liveOf,
  liveTimeOf,
  macOf,
  meterOf,
  numberOf,
  sampleTimeOf,
  transferSwitchOf,
} from '../src/pvs/model.js';
import {
  NOW,
  consumptionMeter,
  ess,
  flat,
  inverter,
  live,
  productionMeter,
  transferSwitch,
} from './fixtures/pvs.js';

const mapOf = (object) => new Map(Object.entries(object));

test('numbers: a number or a decimal text; anything else unknown, never 0', () => {
  assert.equal(numberOf('2.971486'), 2.971486);
  assert.equal(numberOf(-1.5), -1.5);
  assert.equal(numberOf('1e3'), 1000);
  for (const value of [
    '',
    ' ',
    'nan',
    'NaN',
    'N/A',
    'TBD',
    'n/a',
    null,
    undefined,
    true,
    '0x10',
    '1,5',
    Infinity,
  ]) {
    assert.equal(numberOf(value), undefined, String(value));
  }
});

test('live data: kW to W, kWh lifetime above 0 only, a small negative production is 0 W', () => {
  const l = liveOf(mapOf(live()));
  assert.equal(Math.round(l.pvPower), 2971);
  assert.equal(l.pvEnergy, 11992.030273);
  assert.equal(Math.round(l.netPower), -1447);
  assert.equal(l.at, NOW);
  assert.equal(l.essPower, undefined, 'nan: no battery value');
  assert.equal(liveOf(mapOf(live(NOW, { '/sys/livedata/pv_p': '-0.010000' }))).pvPower, 0);
  assert.equal(liveOf(mapOf(live(NOW, { '/sys/livedata/pv_p': '-5' }))).pvPower, undefined);
  assert.equal(liveOf(mapOf(live(NOW, { '/sys/livedata/pv_en': '0.000000' }))).pvEnergy, undefined);
  assert.equal(liveTimeOf(String(NOW)), NOW, 'milliseconds taken too, as pypvs');
  assert.equal(liveTimeOf('0'), undefined);
});

test('samples: msmtEps strict UTC; the default of a device never heard is no sample', () => {
  assert.equal(sampleTimeOf('2026-04-10T11:30:00Z'), NOW);
  for (const value of [
    'n/a',
    '1970-01-01T00:00:00Z',
    '2026-04-10 11:30:00',
    '2026-04-10T11:30:00+02:00',
    5,
  ]) {
    assert.equal(sampleTimeOf(value), undefined, String(value));
  }
});

test('a micro-inverter, the meters, a battery, a transfer switch (pypvs fixtures)', () => {
  const inv = inverterOf(mapOf(inverter()));
  assert.equal(inv.sn, 'E00987654321001');
  assert.equal(Math.round(inv.power), 297);
  assert.equal(inv.lifetime, 2843.847168);
  assert.equal(inv.temperature, 29);
  const p = meterOf(mapOf(productionMeter()));
  assert.equal(p.role, 'production');
  assert.equal(p.voltageL1, undefined, '0 V: not wired');
  assert.equal(p.imported, undefined, '0 kWh: never a counter value');
  assert.equal(p.net, 11991.549805);
  const c = meterOf(mapOf(consumptionMeter()));
  assert.equal(c.role, 'consumption');
  assert.equal(c.exported, 5842.859863);
  assert.equal(c.net, undefined, 'a negative net is no lifetime counter');
  const b = essOf(mapOf(ess()));
  assert.equal(b.soc, 65);
  assert.equal(essOf(mapOf(ess(undefined, NOW, { socVal: 65 }))).soc, undefined, 'a fraction only');
  const s = transferSwitchOf(mapOf(transferSwitch()));
  assert.equal(s.midClosed, 1);
  assert.equal(
    transferSwitchOf(mapOf(transferSwitch(undefined, NOW, { midStEnum: 'MID_STATE_OPEN' })))
      .midClosed,
    0,
  );
  assert.equal(
    transferSwitchOf(mapOf(transferSwitch(undefined, NOW, { midStEnum: 'WHATEVER' }))).midClosed,
    undefined,
  );
});

test('devices grouped by index, bounded, odd names skipped; serial numbers safe for an id', () => {
  const vars = mapOf({
    ...flat('inverter', [inverter('A1'), inverter('A:2'), inverter('../x')]),
    '/sys/devices/inverter/__proto__/sn': 'x',
    '/sys/devices/inverter/1/a/b': 'x',
  });
  const { devices, more } = groupDevices(vars, 'inverter');
  assert.deepEqual(
    devices.map((d) => d.index),
    [0, 1, 2],
  );
  assert.equal(more, false);
  assert.deepEqual(
    devices.map((d) => inverterOf(d.fields).sn),
    ['A1', undefined, undefined],
  );
  const many = mapOf(
    flat(
      'meter',
      Array.from({ length: 9 }, () => productionMeter()),
    ),
  );
  assert.equal(groupDevices(many, 'meter').devices.length, 8);
  assert.equal(groupDevices(many, 'meter').more, true);
});

test('the MAC: 12 hex digits, never all zeros', () => {
  assert.equal(macOf('02:AA:bb:cc:dd:01'), '02aabbccdd01');
  for (const value of ['TBD', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '02:aa', 5]) {
    assert.equal(macOf(value), undefined, String(value));
  }
});

test('configuration: address, port, HTTPS only, no broadcast; password kept as typed; fingerprint', () => {
  assert.deepEqual(parseHost('192.168.1.20'), { host: '192.168.1.20', port: null });
  assert.deepEqual(parseHost('https://192.168.1.20:8443/'), { host: '192.168.1.20', port: 8443 });
  assert.deepEqual(parseHost('http://192.168.1.20'), { error: 'http' });
  for (const bad of [
    '255.255.255.255',
    '0.0.0.0',
    '192.168.1.255',
    '224.0.0.1',
    'user:pw@1.2.3.4',
    'a b',
    '[ff02::1]',
  ]) {
    assert.ok(parseHost(bad).error, bad);
  }
  assert.equal(parseFingerprint('ab'.repeat(32)), Array(32).fill('AB').join(':'));
  assert.equal(parseFingerprint('xyz'), null);
  const c = normalizeConfig({ address: '192.168.1.20', password: ' ab1 ' });
  assert.equal(c.password, ' ab1 ');
  assert.equal(c.port, 443);
  assert.equal(normalizeConfig({ address: 'x', password: 'a\nb' }).passwordInvalid, true);
});
