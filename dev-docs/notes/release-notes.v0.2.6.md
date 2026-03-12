---
id: 68lydvffz2v30ag7mywae1w
title: 'Release Notes v0.2.6'
desc: >-
  Scoped npm install, cross-platform npm smoke coverage, Windows packaged-start
  fix, and GitHub Release asset publishing.
updated: 1773335859450
created: 1773335534555
---

`v0.2.6` turns the new binary distribution pipeline into a usable public release
path.

Primary changes:

- switched the npm wrapper package to `@spectacular-voyage/kato`
- added native-runner npm install smoke on Linux, Windows, macOS x64, and
  macOS arm64
- fixed packaged Windows `kato start` so the daemon launcher no longer passes
  an empty PowerShell `ArgumentList`
- added GitHub Release asset upload/update support to the manual release
  workflow so per-platform archives and checksums ship alongside npm packages

Upgrade notes:

- install or update with `npm install -g @spectacular-voyage/kato`
- `npx @spectacular-voyage/kato@latest ...` is now the zero-install path for
  one-off use
- Windows users should prefer `v0.2.6` or later for packaged `kato start`

Acknowledgements:

- release hardening in this cut came from real Windows/npm smoke testing plus
  continued Codex and CodeRabbit iteration on the packaging flow
