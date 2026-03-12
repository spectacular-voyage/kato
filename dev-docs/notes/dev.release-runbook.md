---
id: zskc5s6r8d1khexmq6q6q7t
title: Release Runbook
desc: ''
updated: 1772776769658
created: 1772551839242
---

## Purpose

Developer-facing release process for `kato` after CLI/daemon separation.

For `v0.2.0`, release is intentionally source-only. Binary artifact publishing
is deferred to a follow-up hardening track.

## v0.2.0 Source-Only Release

### Version Policy

- CLI version source for `kato --version`: `apps/cli/deno.json`.
- Daemon version source for `status` identity: `apps/daemon/deno.json`.
- Release tag for this cut tracks CLI version:
  - tag: `v0.2.0`
  - `apps/cli/deno.json` `version`: `0.2.0`
- Daemon version is allowed to differ for this release line.

### Release Steps

1. Confirm release commit is on `main` and CI is green.
2. Run full local quality gate:

```bash
deno task ci
```

3. Verify CLI version:

```bash
deno run -A apps/cli/src/main.ts --version
```

Expected output includes `kato 0.2.0`.

4. Verify daemon version source and status projection (with daemon running):

```bash
cat apps/daemon/deno.json | rg '"version"'
deno run -A apps/cli/src/main.ts status --json | rg '"daemonVersion"'
```

5. Create and push annotated tag:

```bash
git tag -a v0.2.0 -m "kato v0.2.0"
git push origin v0.2.0
```

6. Create GitHub release from `v0.2.0`.
7. In release notes, state explicitly:
   - source-only release
   - compiled binaries are deferred

### Verification Checklist

- [x] `kato --version` reports `0.2.0`.
- [x] `deno task ci` passed for release commit.
- [x] `apps/cli/deno.json` version is `0.2.0`.
- [x] Daemon status payload includes `daemonVersion`.
- [x] Git tag `v0.2.0` exists and points to release commit.
- [x] GitHub release exists from `v0.2.0`.
- [x] Release notes mention binaries are deferred.

### Gemini Smoke Check (Internal)

Use this lightweight check to confirm Gemini ingestion and in-chat command
handling before release cut:

1. Start/continue a Gemini chat in VS Code.
2. Run:

```bash
deno run -A apps/cli/src/main.ts status --all --json
```

Confirm a `gemini` session appears with recent `lastEventAt`.

3. Issue `::capture-<alias>` in the Gemini chat (for example `::capture-k`).
4. Run:

```bash
rg -n "recording.command.(applied|failed)|recording.capture" ~/.kato/daemon/logs/operational.jsonl -S
```

Confirm at least one Gemini command-handling event is present:

- success path:
  - `recording.command.applied` (with `provider: "gemini"`)
  - and/or `recording.capture`
- failure path:
  - `recording.command.failed` with actionable error details

## Immediate Follow-Up Hardening (Post-v0.2.0)

- [c] Enable branch protection on `main` requiring CI checks.
- [x] Add Dependabot for GitHub Actions.
- [x] Add coverage artifact generation and patch coverage gating.
- [c] Add binary release workflow(s) with scoped `deno compile` permissions.

## Planned Binary + Prebuilt Web Release Flow

This section is target-state planning for the post-source-only release track. It
does not replace the historical `v0.2.0` source-only steps above.

### Product Decision

- Keep Vite as the contributor/dev and CI build tool for `apps/web`.
- Stop treating `kato web start` as a Vite/dev-server entrypoint.
- Make `kato web start` use a prebuilt packaged web runtime.
- Keep `deno task dev:web` as the live-reload developer path.

### Release Packaging Contract

Each platform release bundle should contain:

- `kato`
- `kato-daemon`
- preferably `kato-web`

Temporary fallback only if another platform blocks `kato-web` compile:

- packaged web runtime/artifacts required by `kato web start`

Planning note:

- Linux proof now supports the three-binary shape directly
- the release contract should still be fixed now: end users do not build web
  assets locally and do not need Vite for `kato web start`

### Current Local Build Task

The current repeatable local build entrypoint is:

```bash
deno task build:binaries -- --output-dir .test-tmp/binaries/release-smoke
```

Useful flags for faster local reruns after a successful web build:

```bash
deno task build:binaries -- --output-dir .test-tmp/binaries/release-smoke --skip-web-install --skip-web-build
```

Current builder behavior:

- compiles `kato`, `kato-daemon`, and `kato-web`
- runs `deno install --frozen` in `apps/web` before the web build unless
  skipped for local reruns
- writes `build-metadata.json` beside the binaries
- uses the current bootstrap permission profile from `scripts/build-binaries.ts`

Current local packaging entrypoint:

```bash
deno task package:binaries -- --input-dir .test-tmp/binaries/release-smoke --label <platform-label>
```

Current packaging behavior:

- assembles a versioned bundle directory containing `kato`, `kato-daemon`,
  `kato-web`, `README.md`, `LICENSE`, and `build-metadata.json`
- writes `bundle-metadata.json` beside the bundle
- emits a platform archive (`.tar.gz` on Unix, `.zip` on Windows)
- emits a `.sha256` checksum for the archive
- rejects packaging if CLI/daemon/web versions are not aligned in
  `build-metadata.json`

Current limitation:

- `scripts/build-binaries.ts` does not yet narrow launcher `--allow-run` to
  sibling executables only; that remains follow-up hardening

Current manual CI entrypoint:

- `.github/workflows/release-manual.yml`
- trigger via GitHub Actions `workflow_dispatch`
- current workflow behavior:
  - build binaries on native runners
  - package platform bundles with `deno task package:binaries`
  - smoke-test `kato --version` and bundled `kato-web` from the packaged bundle
  - upload bundle directory, archive, checksum, and bundle metadata

### Planned Release Steps

1. Confirm release commit is on `main` and CI is green.
2. Run the full local quality gate:

```bash
deno task ci
```

3. Build platform binaries on the native runner with the scripted builder:

```bash
deno task build:binaries -- --output-dir <staging-dir>
```

4. Verify staged build metadata and version alignment before packaging:
   - inspect `<staging-dir>/build-metadata.json`
   - confirm CLI/daemon/web versions are aligned for the release cut
5. Package the staged binaries into release bundles:

```bash
deno task package:binaries -- --input-dir <staging-dir> --label <platform-label>
```

6. Verify packaged bundle outputs:
   - versioned bundle directory exists
   - platform archive exists
   - archive checksum exists
   - `bundle-metadata.json` exists
7. Assemble per-platform release archives/installers so the web runtime is
   colocated with the CLI bundle.
8. Run per-platform smoke checks against the packaged runtime, not the Vite dev
   server:
   - `kato --version`
   - `kato status`
   - `KATO_WEB_PASSWORD=<password> kato web init --username <username>`
   - `kato web start`
   - HTTP probe of `/login` on the configured host/port
   - `kato web status`
   - `kato web stop`
9. Upload versioned and stable-name release assets.
10. Publish GitHub release and any installer/channel metadata.

### Planned Verification Checklist

- [ ] `deno task ci` passed for the release commit.
- [ ] `deno task build:binaries -- --output-dir <staging-dir>` passed on each
      native runner.
- [ ] `<staging-dir>/build-metadata.json` exists and shows aligned release
      versions.
- [ ] `deno task package:binaries -- --input-dir <staging-dir> --label <platform-label>`
      passed on each native runner.
- [ ] Packaged output includes bundle directory, archive, checksum, and
      `bundle-metadata.json`.
- [ ] Each platform artifact bundle includes `kato`, `kato-daemon`, and
      `kato-web` unless an explicit fallback exception is documented.
- [ ] `kato web start` works from the packaged release output without invoking
      the Vite dev server.
- [ ] `/login` responds on the configured host/port after `kato web start`.
- [ ] `kato web status` and `kato web stop` succeed against the packaged web
      runtime.
- [ ] Release notes distinguish developer `deno task dev:web` from installed
      `kato web start`.
