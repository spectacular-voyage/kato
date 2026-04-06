---
id: 84lo4kejk6d7cyz06vzcq5i
title: Release Notes v0.2.5
desc: >-
  Binary build and packaging groundwork, Fresh web binary proof, and release
  workflow scaffolding.
updated: 1773306141709
created: 1773293521679
---

`v0.2.5` focuses on distribution groundwork rather than a new end-user feature
drop.

Primary changes:

- added repeatable binary build and packaging scripts for `kato`,
  `kato-daemon`, and `kato-web`
- proved the Fresh web app can be compiled into a working Linux `kato-web`
  binary and served successfully at `/login`
- added a manual multi-platform GitHub Actions workflow for binary build,
  packaging, and smoke testing
- tightened launcher resolution so installed sibling binaries are preferred over
  source-tree fallbacks
- removed the stale repo-root `main.ts` stub entrypoint

Upgrade notes:

- source-based contributor workflows remain supported
- release packaging is now moving toward packaged binaries and npm-wrapper
  installation, but signing, notarization, and full install-channel polish are
  still in progress

Acknowledgements:

- internal iteration with CodeRabbit and Codex review helped shake out the
  binary-packaging edge cases in this release line
