# gladys-sunpower-pvs

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**SunPower PVS5 / PVS6** monitoring gateways, read through the local
varserver API SunStrong Management published (HTTPS on the LAN), no cloud.
Not affiliated with SunPower nor SunStrong Management.

**Never tested with a real PVS**: built from SunStrong's "LocalAPI" document,
its public variable lists and the logic of
[pypvs](https://github.com/SunStrong-Management/pypvs) (MIT, SunStrong
Management), ported to JavaScript, and tested against a fake PVS made from
them.

- The site: production power, production index (the only feature in the
  Gladys energy monitoring), grid power (signed), home consumption, battery
  power and backup time with a SunVault.
- Each micro-inverter, meter, SunVault battery and transfer switch the PVS
  lists, as its own device.
- Every lifetime counter checked by a guard: never 0, a jump or a drop held
  until the user accepts it in two clicks; the guard runs on the session
  clock.
- The certificate of the PVS pinned at the first connection, before the
  password is sent; the password made from the serial number when none is
  typed; neither is ever logged nor kept.
- Read-only: never `/vars?set=`, never the installer API (`dl_cgi`).

User guides: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npm run cover        # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .
```

Architecture and rules: [CLAUDE.md](CLAUDE.md). Decisions and open points:
[TODO.md](TODO.md). Releases: Actions → Release (see
[CHANGELOG.md](CHANGELOG.md)).

## License

Apache-2.0 (see [LICENSE](LICENSE)); the ported logic of pypvs is under MIT,
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
