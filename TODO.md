# TODO

## Before announcing

- [x] Review r1 (xhigh): REFUSÉ (4 important, 6 minor), fixed.
- [ ] Review r2.
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
      before logging in; the public CSV marks it `ssm_owner`). If not
      (fcgi_vars answers 400, or 401/403), the status asks for the password.
- [ ] The answer of `/vars?match=` for a kind the site does not have (no
      battery): fcgi_vars answers 400 when nothing matches; that kind is then
      tried again after 5 min doubled up to 1 h, silently unless it was seen.
- [ ] The signs of `p3phsumKw` of a battery and of the meters (pypvs only
      documents the live data: `ess_p` + discharging, `net_p` + importing).
- [ ] `/sys/livedata/soc` is a fraction in the LocalAPI example (0.86):
      the state of charge is taken from the battery device (`socVal`, a
      fraction as pypvs reads it), not from the live data.
- [ ] Whether the self-signed certificate is the same on every PVS (the
      identity check by MAC covers it).
- [ ] `pv_en` is the net counter of the production meter (40747.87 on both
      sides in LocalAPI.md): the night standby draw of the inverters may make
      it go down by a few Wh, and the index would then be held each night
      (orange badge, a log line) until the morning. If so: a small slack for
      drops of the production index.
- [ ] The meter role read from the last letter of the model ("PVS6M0400p",
      "PVS6M0400c"): other meters (a PVS5, an external CT) get `meter-<index>`.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.0` (the template's; the latest published is 0.16.0).
- Manifest: `categories: ["energy"]`, `gladys_version: ">=5.1.0"`; no
  `keywords` / `countries` yet (to add when the core accepts them: `US`).
- Only the production index of the site is in the energy monitoring (as
  gladys-openems; kept at review r1): the grid totals (bought, sold) and the
  home consumption are plain sensors. Why: the consumption CTs may sit at the
  grid connection or on the loads and the signs are undocumented (a wrong
  index skews the monitoring silently); a home already sending its grid
  meter (Rainforest Eagle, Sense, Opower...) would count it twice. With this
  module alone, the consumption does not show in the energy monitoring.
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

- An option, off by default, "bought from the grid = consumption index",
  once the direction of `posLtea3phsumKwh` is confirmed on a real PVS.
- Rotation of the micro-inverters beyond the budget (about 130): each gets a
  value every 10-15 minutes; a lighter catalog would raise that limit.

- Guards of devices whose sample is stale (a night) are built at their next
  fresh sample: a value held from /data shows in the status only then.
- A fallback production index from the production meter when the live data
  is missing (older firmware).

## Next patch

- r2 m1: a 429 on the serial-number read has no test (the mutant treating it as `NO_SERIAL` survives).
- r2 m2: a non-varserver body on the serial-number read gives `NO_SERIAL` without a test; `BAD_ANSWER`
  ("is this a PVS?") would be more accurate.
- r2 m3: docs fr/en: a device not yet heard publishes nothing; a serial refused with a 400 makes the status
  ask for the password.
