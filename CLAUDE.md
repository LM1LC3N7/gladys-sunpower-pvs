# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads a **SunPower PVS5 / PVS6** through the local varserver API
SunStrong Management published in 2025 (`GET /auth?login`, `GET
/vars?name=`, `GET /vars?match=`, HTTPS with a self-signed certificate),
ported from [pypvs](https://github.com/SunStrong-Management/pypvs) (MIT,
SunStrong Management) and its `doc/LocalAPI.md`, see
`THIRD_PARTY_NOTICES.md`. Unofficial: not affiliated with SunPower nor
SunStrong. **Read-only**: never `onSetValue`, never `/vars?set=`, never the
old installer API (`dl_cgi`). Siblings: `gladys-openems` (the devices, the
guard on the session clock), `gladys-ecodevices` (the structure of
`src/app.js`, the store, the two-click acceptance), `gladys-airos` (the
HTTPS transport and the pinned certificate). No PVS was available: every
test runs against the fake PVS of `test/fixtures/pvs.js`, built from the
document and the anonymized fixtures of pypvs.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        SunPowerApp: getConfig retries, the pace, the pin, the identity, the guards, /data, buttons
src/pvs/http.js                   the only network access (HTTPS GET, fingerprint checked before any byte, bounded)
src/pvs/client.js                 the varserver API: serial -> password, login, session cookie, /vars queries
src/pvs/model.js                  the variables -> values, strict (pure)
src/pvs/errors.js                 our error codes (messages safe to log)
src/guard.js                      plausibility of a lifetime counter (shared file, pure)
src/store.js                      what /data keeps across restarts (unreadable is not empty)
src/devices.js                    the devices, feature keys, external ids, states (pure)
src/config.js                     the address, the password, the fingerprint, normalized
src/constants.js                  variables, pacing, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
scripts/cover.mjs                 the cover image
test/fixtures/pvs.js              the fake PVS (transport level) and the pypvs samples
test/helpers/server.js            the fake PVS behind a real HTTPS server; a TLS impostor
```

## Rules

- **Energy monitoring**: the ONLY index is `production_index` of the site
  (`energy-production-sensor` / `index`, `/sys/livedata/pv_en`, kWh), with
  its `production_index_30min` declared (UUID v5 ids, the core fills it).
  Never an `energy-sensor` / `index`, never `publishEnergyConsumption`: the
  consumption meter's placement and signs are undocumented, and another
  integration may already count the grid (TODO.md "Decisions"). Every other lifetime
  counter is a plain sensor, kWh in the name. Every lifetime counter passes
  `IndexGuard` (`src/guard.js`, 200 kW for the site and the meters, 2 kW for
  a micro-inverter): never 0, a drop and a jump never confirmed by repetition
  nor by time, taken only by `accept_held` in two clicks. The guards run on
  the **session clock** (`sessionNow`: wall at the start + monotonic
  elapsed); /data keeps wall dates written with the offset of the moment. Do
  not change `src/guard.js` without the same change in its siblings and a
  review.
- **Units**: only the core's (`DEVICE_FEATURE_UNITS_BY_CATEGORY`); signed
  powers are plain sensors, the sign in the name.
- **Strict values**: a number or a decimal text; `''`, `nan`, `N/A`, `TBD`,
  null or a word is unknown, never 0; a voltage or a frequency at 0 is "not
  wired"; a sample without a readable `msmtEps` is no sample.
- **Secrets**: the password (typed or made from the serial number) and the
  serial number live in private fields of `PvsClient`; never in a log, an
  error, a status, /data, an id or a name. An id that would hold the password
  is never made (`holdsSecret`). Meters are never named after their serial
  number (the built-in ones belong to the PVS). The MAC of the PVS is kept
  as a salted hash only; the serial number is read with `name=` only, never
  in the principal query.
- **Certificate**: pinned at the first connection, written to /data BEFORE
  the password goes (`checkPeer`, src/pvs/http.js checks it before any byte
  and never reads an answer that came before the request). Another
  certificate: nothing sent, its fingerprint in the status, trusted only when
  the user types it. /data unreadable or not writable: nothing learned,
  nothing sent.
- **The pace**: never two reads less than 30 s apart, whatever asks; the time
  of the last read is in /data before the request. The devices every 5
  minutes, each kind with its own retries: never blocking. One request at a
  time, one session.
- **Identity**: the MAC of every read against /data; another one: nothing
  published until `accept_held`; unreadable: nothing published from that
  read.
- **Freshness**: a sample is published once (its time in /data) and never
  when it is more than 2 h older than the clock of the PVS (Date header or
  live data time); without a readable clock, never "expired".
- **Late answers**: every await in a read is followed by `gone()`.
- **`/data`**: an unreadable file is not an empty state: never overwritten,
  no counter published; a save that fails holds the counters back.
- **getConfig** in `connected` is retried without end (5 s doubled to 5 min).
- **At most 250 states a minute** (`budget`): the site first, then meters,
  batteries, transfer switches, micro-inverters; a sample left out waits for
  the next read with its guards untouched.
- **External ids are forever**: `pvs:site`, `pvs:inverter-<sn>`,
  `pvs:meter-production|consumption|<index>`, `pvs:ess-<sn>`,
  `pvs:switch-<sn>`, the `FEATURE` keys of `src/devices.js`, the manifest
  keys and actions. Features only grow.
- **The container rootfs is read-only.** Write only under `/data`
  (`/data/sunpower-pvs-state.json`).
- **Versions belong to the Release workflow** (Actions → Release), except the
  first 0.1.0 set by hand. `test/manifest.test.js` checks they agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **Manifest**: texts `{ en, fr }`; never a `default` on a secret.
- **User-facing text** is bilingual; files are UTF-8 without BOM nor control
  bytes (`test/encoding.test.js`).
- **Style**: Prettier, ESLint; comments explain why, in English. Tests never
  touch the network (the HTTPS tests use 127.0.0.1).

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is not
  a bug in the code.

## Checking an answer against a real PVS

On the same LAN, as SunStrong's document shows it (`pwd` = the last 5
characters of the serial number):

```bash
auth=$(echo -n "ssm_owner:$pwd" | base64)
curl -k -c c.txt -b c.txt -H "Authorization: basic $auth" "https://$ip/auth?login"
curl -k -c c.txt -b c.txt "https://$ip/vars?match=livedata"
curl -k -c c.txt -b c.txt "https://$ip/vars?match=/sys/devices/meter/"
```

Remove the serial numbers and the MAC before an answer becomes a fixture.
