# TODO

## Before announcing

- [ ] Review r1 (xhigh).
- [ ] Test on a real Gladys with a real PVS6 (none available): first
      connection and pin, the password made from the serial number, device
      creation, the production the core derives from the index.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.

## To confirm on a real PVS (built without one)

- [ ] GET (as the LocalAPI document shows) for `/vars`; pypvs posts the same
      query in the body. A PVS that refuses GET would answer 4xx/405: read as
      an HTTP error.
- [ ] `/sys/info/serialnum` readable without a session (pypvs reads it so
      before logging in). If not, the status asks for the password.
- [ ] The answer of `/vars?match=` for a kind the site does not have (no
      battery): an empty list, or an error? An error only marks that kind
      as failing, and the status only says it for inverters, meters and
      kinds seen before.
- [ ] The signs of `p3phsumKw` of a battery and of the meters (pypvs only
      documents the live data: `ess_p` + discharging, `net_p` + importing).
- [ ] `/sys/livedata/soc` is a fraction in the LocalAPI example (0.86):
      the state of charge is taken from the battery device (`socVal`, a
      fraction as pypvs reads it), not from the live data.
- [ ] Whether the self-signed certificate is the same on every PVS (the
      identity check by MAC covers it).
- [ ] The meter role read from the last letter of the model ("PVS6M0400p",
      "PVS6M0400c"): other meters (a PVS5, an external CT) get `meter-<index>`.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.0` (the template's; the latest published is 0.16.0).
- Manifest: `categories: ["energy"]`, `gladys_version: ">=5.1.0"`; no
  `keywords` / `countries` yet (to add when the core accepts them: `US`).
- Only the production index of the site is in the energy monitoring (as
  gladys-openems): the grid totals (bought, sold) and the home consumption
  are plain sensors. An option to make "bought from the grid" the
  consumption index (a US home without another meter in Gladys) is for
  Louis to decide.
- Battery lifetime counters (`posLtea3phsumKwh` / `negLtea3phsumKwh` of
  the ESS), the state of health, the operating mode (a text) and the
  `midstate` of the live data are not published: their direction or unit
  is not documented.
- The password field is optional: empty, the integration uses SunStrong's
  documented rule (last 5 characters of the serial number). The serial
  number is read with its own query, never with the principal one, and
  never kept.
- Meter ids by role, never by serial number (the built-in meters' serial
  numbers may derive from the PVS's, which makes the password).
- Live data every 30 s, devices every 5 min (their samples are 5-minute
  ones), not configurable: SunStrong asks for no query faster than every
  few seconds, above all on SunVault systems.
- The `cache=` feature of the API is not used (a cache lost at a reboot of
  the PVS could answer empty).

## Later

- Guards of devices whose sample is stale (a night) are built at their next
  fresh sample: a value held from /data shows in the status only then.
- A fallback production index from the production meter when the live data
  is missing (older firmware).
