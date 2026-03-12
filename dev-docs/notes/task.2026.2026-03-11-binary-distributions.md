---
id: lwoblwa43m6z5ign6ukghbs
title: 2026 03 11 Binary Distributions
desc: ""
updated: 1773295520734
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
- The native binary pipeline should now be treated as the build substrate for
  npm-wrapper-first installation, not only as a direct archive-download path.
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

### Linux proof of concept

The first Linux smoke pass is now real, not speculative:

- `kato` compiles from `apps/cli/src/main.ts`
- `kato-daemon` compiles from `apps/daemon/src/main.ts`
- `kato-web` compiles from Fresh production output plus a small Kato wrapper
  entrypoint using:
  `deno task --cwd apps/web build`
  then
  from `apps/web`:
  `deno compile --include _fresh -A src/compiled_main.ts`
- the compiled `kato-web` binary starts and serves `/login` successfully on
  Linux
- the wrapper keeps the installed-binary contract aligned with the launcher by
  accepting `--host` and `--port`
- current Linux `kato-web` output is large because Deno embeds `_fresh` plus
  npm-derived web dependencies; bundle size needs explicit packaging review

The two concrete web blockers were both local code issues, not a Fresh compile
dead end:

- islands were importing mixed client/server helpers from
  `apps/web/src/loaders/activity_state.ts`, which pulled runtime filesystem code
  into the client bundle
- `apps/runtime/src/orchestrator/launcher.ts` used
  `new URL("../../../daemon/src/main.ts", import.meta.url)`, which Vite treated
  as a client asset reference and copied into `_fresh/client`

### Repeatable local build task

The proof-of-concept compile flow is now scripted in `scripts/build-binaries.ts`
and exposed as:

- `deno task build:binaries`

Current behavior:

- default output goes to `.test-tmp/binaries/<host-os>-<host-arch>`
- `build-metadata.json` is written alongside the binaries
- frozen `apps/web` install/build is run before `kato-web` compile unless
  explicitly skipped
- ad hoc local smoke rebuilds can skip repeated web setup, for example:
  `deno task build:binaries -- --output-dir .test-tmp/binaries/host-smoke --skip-web-install --skip-web-build`

Current bootstrap permission profile in the scripted build:

- `kato`: `--allow-read --allow-write --allow-env --allow-net --allow-run`
- `kato-daemon`: `--allow-read --allow-write --allow-env`
- `kato-web`: `--allow-read --allow-write --allow-env --allow-net`

This is good enough for repeatable local builds, but launcher `--allow-run`
scoping is still an open hardening item.

### Bundle packaging and manual workflow

The build output is now followed by a packaging step in `scripts/package-binaries.ts`
and exposed as:

- `deno task package:binaries -- --input-dir <build-dir> --label <platform-label>`

Current packaging behavior:

- copies `kato`, `kato-daemon`, `kato-web`, `README.md`, `LICENSE`, and
  `build-metadata.json` into a versioned bundle directory
- writes `bundle-metadata.json` beside the packaged output
- creates a `.tar.gz` bundle on Unix platforms and a `.zip` bundle on Windows
- emits a `.sha256` checksum for the archive
- rejects packaging if CLI/daemon/web versions are not aligned in
  `build-metadata.json`

`.github/workflows/release-manual.yml` now runs this packaged path on the native
runner matrix:

- build binaries
- package the bundle
- smoke-test `kato --version` and `kato-web` from the packaged bundle directory
- upload the packaged directory, archive, checksum, and bundle metadata as the
  workflow artifact

## Open Issues

- `apps/web` now compiles into a standalone `kato-web` binary on Linux. The
  remaining issue is validating stable asset inclusion and startup behavior on
  Windows and macOS.
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
- npm wrapper install should be treated as the intended primary user-facing
  install channel once publish automation is in place.
- The primary npm wrapper package name is `@spectacular-voyage/kato`.
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
- Current Linux smoke result:
  - `deno compile --config apps/cli/deno.json ... apps/cli/src/main.ts`
  - `deno compile --config apps/daemon/deno.json ... apps/daemon/src/main.ts`
  - `deno task --cwd apps/web build`
  - from `apps/web`: `deno compile --include _fresh -A src/compiled_main.ts`
  - HTTP probe of compiled `kato-web` at `/login`
- Current scripted host build result:
  - `deno task build:binaries -- --output-dir .test-tmp/binaries/host-smoke --skip-web-install --skip-web-build`
  - `./.test-tmp/binaries/host-smoke/kato --version`
  - `build-metadata.json` emitted beside the binaries
- Current packaged host build result:
  - `deno task build:binaries -- --output-dir .test-tmp/binaries/package-smoke`
  - `deno task package:binaries -- --input-dir .test-tmp/binaries/package-smoke --output-dir .test-tmp/bundles/package-smoke --label linux-x64`
  - `.test-tmp/bundles/package-smoke/kato-v0.2.4-linux-x64.tar.gz`
  - `.test-tmp/bundles/package-smoke/kato-v0.2.4-linux-x64.tar.gz.sha256`
  - `./.test-tmp/bundles/package-smoke/kato-v0.2.4-linux-x64/kato --version`
  - HTTP probe of bundled `kato-web` at `/login`
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
- JSR executable distribution in Phase 1.
- A temporary Deno-required installer channel.
- Replacing the Fresh/Vite developer workflow.

## Implementation Plan

- [x] Add a binary-resolution abstraction for daemon launch with precedence:
      `KATO_DAEMON_BIN` -> sibling binary -> developer fallback.
- [x] Add a binary-resolution abstraction for web launch with precedence:
      `KATO_WEB_BIN` -> sibling binary -> developer fallback.
- [x] Refactor `kato start` / `kato restart` launcher paths to target installed
      daemon binaries instead of repo source by default.
- [x] Refactor `kato web start` to target installed web binaries instead of the
      current source/dev path by default.
- [x] Build a minimal `deno compile` proof of concept for `kato`.
- [x] Build a minimal `deno compile` proof of concept for `kato-daemon`.
- [x] Build a minimal `deno compile` proof of concept for `kato-web`.
- [x] Add a repeatable local binary build task and metadata manifest.
- [x] Verify that `kato-web` includes the required production assets and starts
      cleanly on the initial target matrix:
      Linux x64, Windows x64, macOS x64, macOS arm64.
- [x] Confirm that the packaged-artifact fallback is not needed for the initial
      target matrix; keep it only as a contingency for future unsupported
      platforms.
- [ ] Define Phase 1 compile permissions for each executable, with launcher-only
      spawning power where possible.
- [x] Add focused tests for installed binary discovery and lifecycle behavior.
- [x] Add native-runner GitHub Actions workflow(s) that compile all Phase 1
      executables for the initial platform matrix.
- [x] Add bundle assembly steps so each platform artifact includes the required
      sibling executables and metadata.
- [ ] Add signing/notarization steps required for documented default installs.
- [x] Add lightweight packaged-bundle smoke checks for:
      `kato --version`, bundled `kato-web`, and HTTP probe of `/login`.
- [ ] Expand packaged-bundle smoke checks to full daemon lifecycle and web
      lifecycle coverage.
- [x] Align the binary docs and release runbook with npm wrapper install as the
      intended primary user-facing channel.
- [x] Update [[dev.release-runbook]] once the implementation shape is proven by
      a real binary build and smoke pass.

Current implementation note:

- `.github/workflows/release-manual.yml` now builds, packages, smoke-tests, and
  uploads manual per-platform bundle artifacts on the native runner matrix for:
  - Windows x64
  - macOS arm64
  - macOS x64
  - Linux x64
- each runner now packages:
  - a versioned bundle directory
  - platform archive (`.tar.gz` or `.zip`)
  - archive checksum
  - `bundle-metadata.json`
- a follow-up Ubuntu job now:
  - downloads the per-platform bundle artifacts
  - assembles npm wrapper/platform packages
  - uploads the generated npm package assembly output
- a native-runner post-assembly npm smoke matrix now:
  - downloads the assembled `kato-npm-packages` artifact on Linux, Windows,
    macOS x64, and macOS arm64
  - runs `deno task smoke:npm-install` on each native runner
  - keeps the smoke assertions aligned through the shared smoke script instead
    of per-OS workflow forks
- the default npm wrapper target is now `@spectacular-voyage/kato`
- it also runs a lightweight packaged-bundle smoke slice on each runner:
  - `kato --version`
  - `kato-web --host 127.0.0.1 --port 45177`
  - HTTP probe of `/login`
- the binary matrix has already been exercised successfully in GitHub on all
  four native runners
- the npm assembly and host-package smoke path has also been exercised in
  GitHub
- local npm publish dry-run has succeeded for the assembled package set
- `.github/workflows/release-manual.yml` now also has a GitHub Release job that
  can create or update a draft or published release from the packaged bundle
  artifacts, upload the versioned archives and checksums, and use the matching
  `release-notes.v<version>.md` body for the release page
- first real publish attempt surfaced the remaining product decision that the
  wrapper package should be scoped as `@spectacular-voyage/kato`, so release
  artifacts must be regenerated after that naming change before the first real
  npm release cut

## Additional Smoke Plan

The next smoke expansion should focus on the install channel users will
actually touch, not only the raw bundle directory.

- [x] Add a post-assembly npm smoke job matrix to
      `.github/workflows/release-manual.yml` for:
      - Windows x64
      - macOS x64
      - macOS arm64
      - Linux x64
- [x] Have each npm smoke runner download the assembled `kato-npm-packages`
      artifact and run:
      `deno task smoke:npm-install -- --input-dir <downloaded-dir> --npm-bin npm`
- [x] Keep the smoke assertions aligned across platforms:
      - `kato --version`
      - `kato init`
      - `kato web init`
      - `kato web start`
      - HTTP probe of `/login`
      - `kato web status`
      - `kato web stop`
- [x] Fix platform-specific npm install or process-launch issues in
      `scripts/smoke-npm-install.ts` rather than forking per-OS workflow logic.
- [ ] Only treat the npm channel as release-hardened once the above job matrix
      is green on real native runners.

## GitHub Release Plan

GitHub Release assets are still worth doing even if npm becomes the primary
install path:

- they provide a direct-download fallback for users who do not want npm
- they keep versioned archives, checksums, and release notes in one immutable
  place
- they give the binary pipeline a user-visible release surface independent of
  npm registry state

Planned follow-up:

- [x] Add a release-upload job after binary packaging and npm validation that
      attaches per-platform archives and checksums to the tagged GitHub Release.
- [c] Upload at least these assets for each release:
      - `kato-v<version>-linux-x64.tar.gz`
      - `kato-v<version>-linux-x64.tar.gz.sha256`
      - `kato-v<version>-windows-x64.zip`
      - `kato-v<version>-windows-x64.zip.sha256`
      - `kato-v<version>-macos-x64.tar.gz`
      - `kato-v<version>-macos-x64.tar.gz.sha256`
      - `kato-v<version>-macos-arm64.tar.gz`
      - `kato-v<version>-macos-arm64.tar.gz.sha256`
- [x] Keep GitHub Release assets versioned in Phase 1; defer stable-name alias
      assets until the installer/download story settles.
- [c] Prefer creating or updating a draft GitHub Release after successful
      package assembly, then publish/undraft it only after npm publish for that
      version succeeds.
- [x] Include or link release notes for the same version so archive consumers
      can understand platform support, checksums, and install guidance from the
      release page alone.


## Coderabbit Review

- [x] Remove the current `scripts/package-binaries.ts` lint failure and rerun
      focused validation for the binary-packaging slice.
- [ ] Run the full repo `deno task lint` pass after the current cross-turn
      changes settle, not just the focused binary/web lint slice.
- [ ] Add automated tests for `scripts/package-binaries.ts` covering:
      - version-mismatch rejection from `build-metadata.json`
      - expected bundled file set
      - emitted `bundle-metadata.json`
      - archive/checksum creation
- [ ] Add a smoke check that validates the downloadable archive itself, not just
      the pre-archive bundle directory:
      - extract `.tar.gz` / `.zip`
      - run bundled `kato --version`
      - run bundled `kato-web`
      - HTTP probe `/login`
- [x] Exercise `.github/workflows/release-manual.yml` on real native GitHub
      runners and capture any Windows/macOS-specific failures before treating
      the workflow as release-ready.
- [x] Decide that the first documented user-facing install target should be npm
      wrapper install rather than direct archive download.
- [x] Align the binary docs and release runbook with npm wrapper install as the
      intended primary user-facing channel.
