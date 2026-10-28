// -----------------------------------------------------------------------------
// A fake PVS at the transport level (src/pvs/http.js replaced): the varserver
// API as SunStrong's "LocalAPI" document and pypvs describe it, its values
// from the anonymized fixtures of pypvs (tests/test_varserver_models.py, MIT,
// SunStrong Management) and the examples of the document. Values come as the
// document shows them: texts for the live data, numbers in the devices.
// -----------------------------------------------------------------------------

/** 2026-04-10T11:30:00Z: the sample instant of the pypvs fixtures. */
export const NOW = Date.UTC(2026, 3, 10, 11, 30, 0);
export const SERIAL = 'ZT222285000549W3193';
/** SunStrong's rule: the last 5 characters of the serial number. */
export const PASSWORD = SERIAL.slice(-5);
export const MAC = '02:aa:bb:cc:dd:01';
export const FP =
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
export const OTHER_FP =
  '11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF';
export const HOST = '192.168.1.20';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const live = (at = NOW, over = {}) => ({
  '/sys/livedata/time': String(Math.floor(at / 1000)),
  '/sys/livedata/pv_p': '2.971486',
  '/sys/livedata/pv_en': '11992.030273',
  '/sys/livedata/net_p': '-1.447360',
  '/sys/livedata/net_en': '-5843.060059',
  '/sys/livedata/site_load_p': '1.524126',
  '/sys/livedata/site_load_en': '6148.970215',
  '/sys/livedata/ess_en': 'nan',
  '/sys/livedata/ess_p': 'nan',
  '/sys/livedata/soc': 'nan',
  '/sys/livedata/backupTimeRemaining': '0',
  '/sys/livedata/midstate': '2',
  ...over,
});

export const info = (over = {}) => ({
  '/sys/info/model': 'PVS6 ',
  '/sys/info/hwrev': '6.02 ',
  '/sys/info/sw_rev': '2025.06.24.61840',
  '/sys/info/lmac': MAC,
  '/sys/info/serialnum': SERIAL,
  '/sys/info/wpa_key': 'never-read',
  ...over,
});

export const inverter = (sn = 'E00987654321001', at = NOW, over = {}) => ({
  freqHz: 59.98,
  i3phsumA: 1.21,
  iMppt1A: 5.4,
  ltea3phsumKwh: 2843.847168,
  msmtEps: iso(at),
  p3phsumKw: 0.29659,
  pMppt1Kw: 0.25992,
  prodMdlNm: 'AC_Module_Type_E',
  sn,
  tHtsnkDegc: 29,
  vMppt1V: 48.09,
  vln3phavgV: 244.070007,
  ...over,
});

export const productionMeter = (at = NOW, over = {}) => ({
  msmtEps: iso(at),
  sn: 'PVS6M90000001p',
  prodMdlNm: 'PVS6M0400p',
  ctSclFctr: 100,
  freqHz: 59.988712,
  i1A: 0.0,
  i2A: 0.0,
  negLtea3phsumKwh: 0.0,
  netLtea3phsumKwh: 11991.549805,
  p1Kw: 0.0,
  p2Kw: 0.0,
  p3phsumKw: 2.972999,
  posLtea3phsumKwh: 0.0,
  q3phsumKvar: 0.184966,
  s3phsumKva: 2.982468,
  totPfRto: 0.996842,
  v12V: 243.58197,
  v1nV: 0.0,
  v2nV: 0.0,
  ...over,
});

export const consumptionMeter = (at = NOW, over = {}) => ({
  msmtEps: iso(at),
  sn: 'PVS6M90000002c',
  prodMdlNm: 'PVS6M0400c',
  ctSclFctr: 100,
  freqHz: 59.988712,
  i1A: 5.867875,
  i2A: 6.082969,
  negLtea3phsumKwh: 5842.859863,
  netLtea3phsumKwh: -5842.830078,
  p1Kw: -0.711292,
  p2Kw: -0.738008,
  p3phsumKw: -1.449301,
  posLtea3phsumKwh: 0.01,
  q3phsumKvar: -0.101444,
  s3phsumKva: 1.455515,
  totPfRto: -0.995831,
  v12V: 243.58197,
  v1nV: 121.751556,
  v2nV: 121.830658,
  ...over,
});

export const ess = (sn = 'ESS-TEST-UNIT-00001', at = NOW, over = {}) => ({
  msmtEps: iso(at),
  sn,
  prodMdlNm: 'SPWR-Equinox-model',
  chrgLimitPmaxKw: 10.762,
  customerSocVal: 0.59,
  dischrgLimPmaxKw: 10.004,
  negLtea3phsumKwh: 7492.96582,
  opMode: 'ENERGY_ARBITRAGE',
  p3phsumKw: 0.326787,
  posLtea3phsumKwh: 5672.499023,
  socVal: 0.65,
  sohVal: 1,
  tInvtrDegc: 36.619999,
  v1nV: 122.489265,
  v2nV: 122.489265,
  vBattV: 52.445,
  ...over,
});

export const transferSwitch = (sn = 'MIDC-TEST-UNIT-01', at = NOW, over = {}) => ({
  msmtEps: iso(at),
  sn,
  prodMdlNm: 'SunPower MIDC',
  midStEnum: 'MID_STATE_CLOSED',
  pvd1StEnum: 'PVD_STATE_CLOSED',
  tDegc: 28.0,
  v1nGridV: 122.41333,
  v1nV: 122.519333,
  v2nGridV: 122.514664,
  v2nV: 122.414665,
  vSpplyV: 11.237206,
  ...over,
});

/** The variables of a kind of device, flat: `/sys/devices/<kind>/<i>/<field>`. */
export function flat(kind, devices) {
  const out = {};
  devices.forEach((fields, i) => {
    for (const [field, value] of Object.entries(fields)) {
      out[`/sys/devices/${kind}/${i}/${field}`] = value;
    }
  });
  return out;
}

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * The fake PVS. Its state is plain data the tests change live:
 * `live`, `info`, `devices.{inverter,meter,ess,transfer_switch}` (lists of
 * field objects), `fingerprint`, `serialPublic`, `hook(path, request)` (an
 * answer, a thrown error, a promise: a slow PVS), `dateHeader` (a function of
 * the clock, or null: no Date header).
 */
export function createPvs({ clock = { now: NOW }, password = PASSWORD } = {}) {
  let sessionCount = 0;
  const pvs = {
    clock,
    password,
    fingerprint: FP,
    serialPublic: true,
    live: live(),
    info: info(),
    devices: {
      inverter: [inverter('E00987654321001'), inverter('E00987654321002')],
      meter: [productionMeter(), consumptionMeter()],
      ess: [],
      transfer_switch: [],
    },
    sessions: new Set(),
    requests: [],
    peers: 0,
    dateHeader: (now) => new Date(now).toUTCString(),
    hook: undefined,
    /** Every variable, flat. */
    vars() {
      return {
        ...pvs.live,
        ...pvs.info,
        ...flat('inverter', pvs.devices.inverter),
        ...flat('meter', pvs.devices.meter),
        ...flat('ess', pvs.devices.ess),
        ...flat('transfer_switch', pvs.devices.transfer_switch),
      };
    },
    count: (prefix) => pvs.requests.filter((r) => r.path.startsWith(prefix)).length,
    expire() {
      pvs.sessions.clear();
    },
  };
  const values = (names) => {
    const all = pvs.vars();
    const list = names.filter((n) => n in all).map((name) => ({ name, value: all[name] }));
    return { values: list, count: list.length };
  };
  pvs.request = async (target, options) => {
    // The certificate first, before anything is written (src/pvs/http.js).
    pvs.peers += 1;
    try {
      await options.checkPeer(pvs.fingerprint);
    } catch (err) {
      throw Object.assign(err, { notSent: true });
    }
    const path = target.path;
    const headers = options.headers ?? {};
    pvs.requests.push({ path, headers: { ...headers }, at: pvs.clock.now });
    if (pvs.hook) {
      const answer = await pvs.hook(path, { headers, target, options });
      if (answer !== undefined) return answer;
    }
    const date = pvs.dateHeader ? { date: pvs.dateHeader(pvs.clock.now) } : {};
    if (path === '/auth?login') {
      const auth = String(headers.authorization ?? '');
      const decoded = Buffer.from(auth.replace(/^basic /i, ''), 'base64').toString('utf8');
      if (decoded !== `ssm_owner:${pvs.password}`) return json(401, 'Unauthorized', date);
      sessionCount += 1;
      const token = `tok${sessionCount}abcdef`;
      pvs.sessions.add(token);
      return json(
        200,
        { session: token },
        { ...date, 'set-cookie': [`session=${token}; HttpOnly`] },
      );
    }
    const query = /^\/vars\?(name|match)=(.*)$/.exec(path);
    if (!query) return json(404, 'Not found', date);
    const cookie = /^session=(.*)$/.exec(String(headers.cookie ?? ''))?.[1];
    const authed = cookie && pvs.sessions.has(cookie);
    if (!authed) {
      if (pvs.serialPublic && query[1] === 'name' && query[2] === '/sys/info/serialnum') {
        return json(200, values(['/sys/info/serialnum']), date);
      }
      return json(401, 'Unauthorized', date);
    }
    if (query[1] === 'name') return json(200, values(query[2].split(',')), date);
    const all = pvs.vars();
    return json(200, values(Object.keys(all).filter((n) => n.startsWith(query[2]))), date);
  };
  return pvs;
}

export { json };
