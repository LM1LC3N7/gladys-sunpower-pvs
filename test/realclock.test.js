// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTPS server playing the PVS: the reads really start, at 0, the
// interval and twice the interval, with a bounded number of timers; the
// period is measured on the method that decides. Time sped up 20 times
// (30 s are 1.5 s), but the real clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SunPowerApp } from '../src/app.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { createPvs } from './fixtures/pvs.js';
import { measurePeriod, realClock, spyOn } from './helpers/realclock.js';
import { pvsServer } from './helpers/server.js';

const SPEED = 20;

test('real clock x20 over HTTPS: reads at 0, the interval and twice the interval; timers bounded', async (t) => {
  const pvs = createPvs({ clock: { now: Date.now() } });
  const srv = await pvsServer(pvs);
  t.after(() => srv.close());
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'sunpower-pvs', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new SunPowerApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
  });
  const spy = spyOn(app, 'poll', clock);
  try {
    await app.start({ address: `127.0.0.1:${srv.port}` });
    await measurePeriod(spy, { count: 3, period: POLL_INTERVAL });
    // The third read ends before the stop (its HTTPS handshake takes real time).
    await app.idle();
    await app.stop();
  } finally {
    clock.close();
  }
  const reads = srv.received.filter((r) => r.path.startsWith('/vars?name=/sys/livedata')).length;
  assert.ok(reads >= 3 && reads <= 4, `${reads} reads`);
  assert.equal(srv.received.filter((r) => r.path === '/auth?login').length, 1, 'one session');
  assert.equal(
    srv.received.filter((r) => r.path === '/vars?match=/sys/devices/inverter/').length,
    1,
  );
  assert.ok(clock.timersSet <= 12, `${clock.timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
