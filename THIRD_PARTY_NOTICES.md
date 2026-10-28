# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license. No code of it is shipped: the logic was rewritten in JavaScript.

## pypvs (SunStrong-Management/pypvs)

<https://github.com/SunStrong-Management/pypvs>, by SunStrong Management, the
company that now runs the SunPower PVS fleet. Version 0.2.9 (`main` at commit
adb6a61, 2026-04-28).

Ported to JavaScript in `src/pvs/client.js` and `src/pvs/model.js`: the
varserver API of the PVS (`/auth?login` with HTTP Basic authentication for
the user `ssm_owner`, the `session` cookie, `/vars?name=` and `/vars?match=`),
the password made of the last 5 characters of the serial number read from
`/sys/info/serialnum`, a new session after a 401 or a 500, the variable names
and units of the live data (`/sys/livedata/*`), of the PVS (`/sys/info/*`)
and of the devices (`/sys/devices/{inverter,meter,ess,transfer_switch}/<index>/<field>`),
the `msmtEps` sample time, the state of charge as a fraction. The document
`doc/LocalAPI.md` and the public variable lists
`doc/varserver-variables-public-pvs5.csv` and `-pvs6.csv` of that repository
were read as the documentation of the API; the anonymized samples of
`tests/test_varserver_models.py` became the fixtures of `test/fixtures/pvs.js`.
Changed here: GET requests as the document shows them (pypvs posts), values
read against strict patterns and bounds (an empty, "nan" or textual value is
never 0), the certificate pinned instead of ignored, never a write (`set=`),
never the installer API (`dl_cgi`).

```
MIT License

Copyright (c) 2025 SunStrong Management

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Shared code of this author

`src/guard.js` (the guard of the lifetime counters) comes from
gladys-p1-monitor, gladys-ecodevices and gladys-openems, `src/pvs/http.js`
and the parsers of `src/config.js` from gladys-airos: same author, same
license (Apache-2.0).
