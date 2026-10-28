# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- First version: a SunPower PVS5/PVS6 read through its local varserver API
  (HTTPS, certificate pinned at the first connection, password made from the
  serial number when none is typed). The site: production power, production
  index for the energy monitoring, grid and home power, home consumption
  total, battery power and backup time. Each micro-inverter, meter, SunVault
  battery and transfer switch as its own device. Guard of every lifetime
  counter on the session clock (never 0, jumps and drops accepted in two
  clicks), identity of the PVS checked at every read, samples published once
  and never stale, at most 250 states a minute, test button. Read-only.

[Unreleased]: https://github.com/LM1LC3N7/gladys-sunpower-pvs/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-sunpower-pvs/releases/tag/v0.1.1
