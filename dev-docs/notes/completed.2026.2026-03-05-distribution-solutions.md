---
id: wvgli7yr4zmuwcalv6wyevu
title: 2026 03 05 Distribution Solutions
desc: ''
updated: 1773375733364
created: 1772761416593
---

## Status

This note is closed as the broad distribution-planning umbrella.

- The Phase 1 implementation track now lives in
  [[completed.2026.2026-03-11-binary-distributions]].
- The npm-wrapper install path now lives in
  [[task.2026.2026-03-11-npmjs-install]].
- The older recommendation that direct GitHub-release archives should be the
  primary user-facing channel is superseded: npm wrapper install is now the
  preferred documented user path, while GitHub release bundles remain the build
  substrate and direct-download fallback.
- Future-facing distribution ideas from the old Phase 2/3 plan moved to
  [[dev.feature-ideas.distribution-phase-2]].
- Near-term hardening and release follow-ups moved to [[dev.todo]].

## Durable Decisions Worth Keeping

- Prebuilt native binaries are the right distribution substrate; normal users
  should not need Deno or local web builds.
- Keep sibling executables for `kato`, `kato-daemon`, and `kato-web` rather
  than collapsing distribution into one hidden self-reexec binary.
- Installed `kato start` and `kato web start` should resolve sibling installed
  binaries first, with source-tree fallback only for developer environments.
- Daemon instance identity stays tied to the runtime root and shared files under
  `~/.kato`, not to the binary name, install channel, or service-manager label.
- Program files should live outside `~/.kato`; runtime/config/state should stay
  under `~/.kato`.
- Uninstall should remove program bits and autostart/service wiring owned by
  that channel, but preserve `~/.kato` unless the user explicitly chooses data
  purge.
- Phase 1 security remains coarse compiled permissions plus app-level policy;
  Permission Broker is not a release blocker for the current binary track.
- OS-native service-manager integration is still explicitly post-Phase-1 work.

## Where To Look Now

- [[completed.2026.2026-03-11-binary-distributions]] owns the implemented
  binary bundle shape, launcher/runtime contract, packaging workflow, GitHub
  release upload path, and remaining binary hardening items.
- [[task.2026.2026-03-11-npmjs-install]] owns the npm wrapper/package layout
  and the primary user-facing install/update contract.
- [[dev.feature-ideas.distribution-phase-2]] holds the deferred ideas worth
  keeping around: channel-aware self-update, installer channels, and per-user
  OS-native background integration.
- [[dev.todo]] holds the concrete near-term follow-ups still worth doing in the
  current binary distribution track.

## Topics Intentionally Moved Out Of This Note

- Channel-aware `kato self-update`
- Shell/PowerShell direct installers
- Windows installer work
- Per-user service/autostart installation helpers
- Stable latest-download aliases and update-manifest design
- Longer-range rollback and multi-channel lifecycle ownership design
