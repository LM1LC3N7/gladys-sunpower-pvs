// -----------------------------------------------------------------------------
// The client and the HTTPS transport, against a real local HTTPS server: the
// certificate checked before any byte is written, an answer sent before the
// request never read, a body too large cut while it comes, no redirect
// followed, a deadline. And the parsing of the varserver answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PvsClient, parseVars, sessionCookieOf } from '../src/pvs/client.js';
import { CODES } from '../src/pvs/errors.js';
import { httpsGet } from '../src/pvs/http.js';
import { PASSWORD, createPvs } from './fixtures/pvs.js';
import { certs, fingerprintOf, impostorServer, pvsServer } from './helpers/server.js';

const DEVICE_FP = fingerprintOf(certs.device);

const clientOf = (srv, checkPeer = (fp) => assert.equal(fp, DEVICE_FP), password = '') =>
  new PvsClient({ host: '127.0.0.1', port: srv.port, password, checkPeer });

test('a whole read over HTTPS: serial, login, variables with the session cookie', async (t) => {
  const pvs = createPvs();
  const srv = await pvsServer(pvs);
  t.after(() => srv.close());
  const client = clientOf(srv);
  const { vars, date } = await client.readNames(['/sys/livedata/pv_p', '/sys/info/lmac']);
  assert.equal(vars.get('/sys/livedata/pv_p'), '2.971486');
  assert.ok(Number.isFinite(date));
  assert.deepEqual(
    srv.received.map((r) => r.path),
    [
      '/vars?name=/sys/info/serialnum',
      '/auth?login',
      '/vars?name=/sys/livedata/pv_p,/sys/info/lmac',
    ],
  );
  assert.equal(srv.received[2].headers.cookie, 'session=tok1abcdef');
  assert.equal(srv.received[2].headers['user-agent'], 'gladys-sunpower-pvs');
  assert.ok(client.holdsSecret(`x${PASSWORD.toLowerCase()}y`));
  assert.ok(!client.holdsSecret('E00987654321001'));
});

test('a certificate refused by checkPeer: nothing written, marked not sent', async (t) => {
  const srv = await pvsServer(createPvs());
  t.after(() => srv.close());
  const client = clientOf(srv, () => {
    throw Object.assign(new Error('pin'), { code: CODES.CERTIFICATE });
  });
  await assert.rejects(client.readNames(['/sys/livedata/pv_p']), (err) => {
    assert.equal(err.code, CODES.CERTIFICATE);
    assert.equal(err.notSent, true);
    return true;
  });
  assert.equal(srv.received.length, 0);
});

test('a slow checkPeer (a pin written to /data) delays the request, never skips it', async (t) => {
  const srv = await pvsServer(createPvs());
  t.after(() => srv.close());
  let done = false;
  const client = clientOf(srv, async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    done = true;
  });
  await client.readNames(['/sys/livedata/pv_p']);
  assert.ok(done);
});

test('an impostor answering before the request: never read, the password never sent', async (t) => {
  const imp = await impostorServer();
  t.after(() => imp.close());
  const client = new PvsClient({
    host: '127.0.0.1',
    port: imp.port,
    password: PASSWORD,
    checkPeer: () => new Promise((resolve) => setTimeout(resolve, 50)),
  });
  await assert.rejects(client.readNames(['/sys/livedata/pv_p']), (err) => {
    assert.equal(err.code, CODES.BAD_ANSWER);
    assert.equal(err.notSent, true);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(imp.received, 0);
});

test('a body too large is cut while it comes; a redirect is never followed; a silent PVS times out', async (t) => {
  const srv = await pvsServer(createPvs());
  t.after(() => srv.close());
  const target = { host: '127.0.0.1', port: srv.port, path: '/vars?name=x' };
  const checkPeer = () => {};
  srv.mode = 'big';
  await assert.rejects(httpsGet(target, { timeout: 5000, maxBytes: 64 * 1024, checkPeer }), {
    code: CODES.TOO_LARGE,
  });
  srv.mode = 'redirect';
  const client = clientOf(srv, checkPeer, PASSWORD);
  await assert.rejects(client.readNames(['/sys/livedata/pv_p']), { code: CODES.REDIRECT });
  assert.equal(srv.received.filter((r) => r.path === '/').length, 0);
  srv.mode = 'silent';
  await assert.rejects(httpsGet(target, { timeout: 200, maxBytes: 1024, checkPeer }), {
    code: CODES.TIMEOUT,
  });
});

test('nothing listening: unreachable, and the message never holds the address', async () => {
  const err = await httpsGet(
    { host: '127.0.0.1', port: 1, path: '/vars?name=x' },
    { timeout: 2000, maxBytes: 1024, checkPeer: () => {} },
  ).catch((e) => e);
  assert.equal(err.code, CODES.UNREACHABLE);
  assert.ok(!err.message.includes('127.0.0.1'));
});

test('login refused: credentials, said derived when the password came from the serial', async (t) => {
  const pvs = createPvs({ password: 'other' });
  const srv = await pvsServer(pvs);
  t.after(() => srv.close());
  await assert.rejects(clientOf(srv).readNames(['/sys/livedata/pv_p']), (err) => {
    assert.equal(err.code, CODES.CREDENTIALS);
    assert.equal(err.derived, true);
    assert.ok(!err.message.includes(PASSWORD));
    return true;
  });
});

test('variables refused right after a new login: access, never a refused password', async (t) => {
  const pvs = createPvs();
  pvs.hook = (path) =>
    path.startsWith('/vars?name=/sys/livedata')
      ? { status: 403, headers: {}, body: Buffer.from('no') }
      : undefined;
  const srv = await pvsServer(pvs);
  t.after(() => srv.close());
  await assert.rejects(clientOf(srv).readNames(['/sys/livedata/pv_p']), { code: CODES.ACCESS });
});

test('429 and 5xx: their own codes with Retry-After', async () => {
  const answers = [
    { status: 429, headers: { 'retry-after': '120' }, body: Buffer.from('') },
    { status: 503, headers: {}, body: Buffer.from('') },
  ];
  for (const answer of answers) {
    const client = new PvsClient({
      host: 'x',
      port: 443,
      password: 'abcde',
      checkPeer: () => {},
      request: async (target) =>
        target.path === '/auth?login'
          ? { status: 200, headers: { 'set-cookie': ['session=abc'] }, body: Buffer.from('') }
          : answer,
    });
    const err = await client.readNames(['/sys/livedata/pv_p']).catch((e) => e);
    if (answer.status === 429) {
      assert.equal(err.code, CODES.RATE_LIMITED);
      assert.equal(err.retryAfter, 120_000);
    } else {
      assert.equal(err.code, CODES.SERVER);
    }
  }
});

test('parseVars: bounded, strict names, no prototype key, odd values skipped', () => {
  const body = Buffer.from(
    JSON.stringify({
      values: [
        { name: '/sys/livedata/pv_p', value: '1.5' },
        { name: '__proto__', value: 'x' },
        { name: '/sys/x\n', value: '1' },
        { name: '/sys/devices/meter/0/data', value: { nested: true } },
        { name: '/sys/ok', value: 3 },
      ],
      count: 5,
    }),
  );
  const vars = parseVars(body);
  assert.deepEqual([...vars.keys()], ['/sys/livedata/pv_p', '/sys/ok']);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseVars(Buffer.from('<html>')), { code: CODES.BAD_ANSWER });
  assert.throws(() => parseVars(Buffer.from('{"x":1}')), { code: CODES.BAD_ANSWER });
  const many = {
    values: Array.from({ length: 20_001 }, (_, i) => ({ name: `/a/${i}`, value: 1 })),
  };
  assert.throws(() => parseVars(Buffer.from(JSON.stringify(many))), { code: CODES.TOO_LARGE });
});

test('the session cookie: from Set-Cookie, else the body; a value with CR/LF or ";" refused', () => {
  assert.equal(
    sessionCookieOf({ 'set-cookie': ['session=abc; HttpOnly'] }, Buffer.from('')),
    'session=abc',
  );
  assert.equal(sessionCookieOf({}, Buffer.from('{"session": "xyz"}')), 'session=xyz');
  assert.equal(sessionCookieOf({ 'set-cookie': ['other=abc'] }, Buffer.from('')), null);
  assert.equal(sessionCookieOf({}, Buffer.from('{"session": "a\\r\\nb"}')), null);
  assert.equal(sessionCookieOf({}, Buffer.from('{"session": "a;b"}')), null);
});
