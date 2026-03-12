---
id: lwoblwa43m6z5ign6ukghbs
title: 2026 03 11 Binary Distributions
desc: ""
updated: 1773290313000
created: 1773290214027
---

## Goal

Ship a tight Phase 1 binary distribution for Kato that removes the Deno
prerequisite for normal users, keeps the current CLI/daemon/web command
surface, and preferably includes a standalone web binary so `kato web start`
does not require Deno, Vite, or Node on the target machine.

## Summary

- This note narrows the much broader distribution discussion in
  [[task.2026.2026-03-05-distribution-solutions]] into one implementation track.
- Phase 1 should jump directly to native binaries rather than building an
  intermediate Deno-required installer channel.
- Preferred bundle shape:
  - `kato`
  - `kato-daemon`
  - `kato-web`
- If `kato-web` cannot be compiled cleanly in the first pass, the only accepted
  fallback is a packaged prebuilt production web runtime tracked explicitly as a
  temporary exception.

## Discussion

The repo already has the right product split for binary packaging:

- CLI launcher behavior lives in `apps/cli` and runtime launcher helpers.
- Daemon behavior lives in `apps/daemon`.
- Web behavior lives in `apps/web`.

That means the binary problem is not "invent a new architecture." It is:

- replace source-oriented launcher resolution with installed-binary resolution
- define a Phase 1 permission model that is good enough without blocking on
  Permission Broker
- produce release bundles that are installable by non-programmers

### Preferred executable model

Phase 1 should prefer three binaries:

- `kato`: user-facing CLI and process launcher
- `kato-daemon`: detached background daemon runtime
- `kato-web`: detached local web server runtime

Why include a web binary if possible:

- it removes the Deno prerequisite for the web service
- it also removes the current Fresh/Vite/Node-adjacent toolchain dependency from
  the installed path
- it makes `kato web start` a real operator command rather than a developer
  convenience path

### Permission model

Phase 1 does not need dynamic Deno-enforced `AllowedRoot` updates to ship.

Recommended Phase 1 security model:

- keep a coarse baked Deno sandbox in compiled binaries
- keep dynamic `AllowedRoot` enforcement in Kato application logic
- defer Permission Broker to a later hardening phase

Recommended process split:

- `kato` is the only binary allowed to spawn sibling Kato executables
- `kato-daemon` should avoid `--allow-run`
- `kato-web` should avoid `--allow-run`

This keeps process-launch power concentrated in one place and limits the blast
radius if the launcher path needs broader privileges than the long-running
services.

### Web build vs web runtime

Keep Vite for contributor development and release builds.

Do not keep Vite in the installed runtime dependency set.

That means:

- `deno task dev:web` remains the live-reload developer path
- release packaging builds production web output first
- `kato web start` launches the installed production runtime, not the dev server

## Open Issues

- Can `apps/web` be compiled cleanly into a standalone `kato-web` binary with
  stable asset inclusion and startup behavior across Windows, macOS, and Linux?
- What is the narrowest practical `--allow-run` policy for the launcher when
  sibling executables live in an installed bundle with platform-specific paths?
- Should `kato-web` be a documented user-visible executable, or a private
  sibling binary launched only through `kato web ...`?
- How should release bundles lay out executables and auxiliary files so CLI
  discovery is stable across zip/tar/installer channels?
- What signing/notarization sequencing is required for the first documented
  default install path on macOS and Windows?

## Decisions

- Phase 1 skips a Deno-dependent interim installer channel and goes directly to
  native binaries.
- Phase 1 permission model is coarse baked Deno sandbox plus app-level
  `AllowedRoot`.
- Permission Broker is explicitly deferred; it is not a release blocker.
- `kato` remains the launcher and primary user entrypoint.
- Preferred Phase 1 bundle is three binaries:
  - `kato`
  - `kato-daemon`
  - `kato-web`
- Web binary is the target, not merely a nice-to-have.
- If `kato-web` proves blocked in the first pass, fallback to packaged prebuilt
  production web artifacts is acceptable only as an explicitly tracked temporary
  exception.
- `deno task dev:web` remains the contributor dev loop and is not part of the
  installed runtime story.
- Release versioning should be user-facing and unified across the shipped
  bundle.

## Contract Changes

- `kato start` should resolve and launch a sibling installed `kato-daemon`
  binary by default.
- `kato web start` should resolve and launch a sibling installed `kato-web`
  binary by default.
- Source-tree launch behavior becomes a developer fallback, not the primary
  runtime contract.
- Add explicit binary override hooks for local debugging and unusual installs:
  - `KATO_DAEMON_BIN`
  - `KATO_WEB_BIN`
- Release bundles must contain the executables and metadata needed for:
  - version reporting
  - lifecycle start/stop/status
  - install-channel identification
  - checksums/signatures

## Testing

- Add launcher-resolution tests for sibling binary discovery and env override
  precedence.
- Add compile smoke coverage for `kato`, `kato-daemon`, and the initial
  `kato-web` target.
- Add packaged-runtime smoke checks for:
  - `kato --version`
  - `kato start`
  - `kato status`
  - `kato stop`
  - `kato web init`
  - `kato web start`
  - HTTP probe of `/login`
  - `kato web status`
  - `kato web stop`
- Add permission regression checks proving app-level `AllowedRoot` still blocks
  out-of-policy writes even when the binary has a broader baked sandbox.
- Run release packaging and smoke tests on native OS runners for:
  - Windows x64
  - macOS arm64
  - macOS x64
  - Linux x64

## Non-Goals

- Permission Broker in Phase 1.
- Dynamic Deno-enforced `AllowedRoot` updates in Phase 1.
- `systemd --user`, `launchd`, or Windows startup/service integration in Phase 1.
- npm/JSR executable distribution in Phase 1.
- A temporary Deno-required installer channel.
- Replacing the Fresh/Vite developer workflow.

## Implementation Plan

- [ ] Add a binary-resolution abstraction for daemon launch with precedence:
      `KATO_DAEMON_BIN` -> sibling binary -> developer fallback.
- [ ] Add a binary-resolution abstraction for web launch with precedence:
      `KATO_WEB_BIN` -> sibling binary -> developer fallback.
- [ ] Refactor `kato start` / `kato restart` launcher paths to target installed
      daemon binaries instead of repo source by default.
- [ ] Refactor `kato web start` to target installed web binaries instead of the
      current source/dev path by default.
- [ ] Build a minimal `deno compile` proof of concept for `kato`.
- [ ] Build a minimal `deno compile` proof of concept for `kato-daemon`.
- [ ] Build a minimal `deno compile` proof of concept for `kato-web`.
- [ ] Verify whether `kato-web` can include the required production assets and
      start cleanly on all target platforms.
- [ ] If `kato-web` compile is blocked, document the exact blocker and add the
      temporary fallback plan as packaged prebuilt web runtime artifacts.
- [ ] Define Phase 1 compile permissions for each executable, with launcher-only
      spawning power where possible.
- [ ] Add focused tests for installed binary discovery and lifecycle behavior.
- [ ] Add native-runner GitHub Actions workflow(s) that compile all Phase 1
      executables for the initial platform matrix.
- [ ] Add bundle assembly steps so each platform artifact includes the required
      sibling executables and metadata.
- [ ] Add signing/notarization steps required for documented default installs.
- [ ] Add packaged-bundle smoke checks for daemon lifecycle and web lifecycle.
- [ ] Update [[dev.release-runbook]] once the implementation shape is proven by
      a real binary build and smoke pass.
