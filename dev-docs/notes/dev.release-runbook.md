---
id: zskc5s6r8d1khexmq6q6q7t
title: Release Runbook
desc: ''
updated: 1773416456516
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

Current semi-automatic version bump entrypoint:

```bash
deno task bump:version -- --patch
```

Other supported forms:

```bash
deno task bump:version -- --minor
deno task bump:version -- --major
deno task bump:version -- --version 0.2.5
```

Current version bump behavior:

- updates `apps/cli/deno.json`
- updates `apps/daemon/deno.json`
- updates `apps/web/deno.json`
- creates `dev-docs/notes/release-notes.v<version>.md` if it does not already
  exist
- supports `--dry-run` for previewing the change

This is intentionally semi-automatic:

- it prepares the versioned files and release-notes stub
- it does not commit, tag, or publish anything

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
  - download all bundle artifacts on Ubuntu
  - assemble npm packages with `deno task assemble:npm-packages`
  - run npm pack/install smoke with `deno task smoke:npm-install`
  - upload generated npm package assembly artifacts
  - optionally run `deno task publish:npm-packages` from the assembled npm
    artifact with `workflow_dispatch` inputs:
    - `npm_publish_mode=skip`
    - `npm_publish_mode=dry-run`
    - `npm_publish_mode=publish`
    - `npm_tag=<dist-tag>`

Current npm publish behavior:

- uses the same assembled npm packages from the current `release-manual` run
- publishes platform packages first, then the public wrapper package
- current wrapper package target is `@spectacular-voyage/kato`
- uses `npm publish --dry-run` when `npm_publish_mode=dry-run`
- uses plain `npm publish` for local/manual bootstrap publishes
- adds `npm publish --provenance` only when the GitHub workflow runs with
  `npm_publish_mode=publish`
- is intended to use npm trusted publishing from GitHub Actions
- leaves `NODE_AUTH_TOKEN` available as a fallback via `NPM_TOKEN` if trusted
  publishing is not configured yet

Trusted publishing note:

- npm trusted publishers are configured per workflow file, so the npm registry
  side must trust `.github/workflows/release-manual.yml` for
  `@spectacular-voyage/kato` and each
  `@spectacular-voyage/kato-*` platform package before `npm_publish_mode=publish`
  will work without a token.

### Current Release Steps

Use `.github/workflows/release-manual.yml` as the primary release path. The
script-by-script commands below remain useful for local debugging and manual
fallback, but the normal release cut should go through the workflow.

1. Bump versions and create the next release-notes stub:

```bash
deno task bump:version -- --patch
```

2. Confirm the release commit is on `main` and the normal CI quality gate is
   green.
3. Trigger `Release Manual` from GitHub Actions with the inputs you want for
   this pass:
   - `npm_publish_mode=skip`, `dry-run`, or `publish`
   - `npm_tag=<dist-tag>`
   - `github_release_mode=skip`, `draft`, or `publish`
4. Let the workflow run the actual release pipeline:
   - build binaries on Linux x64, Windows x64, macOS x64, and macOS arm64
   - package each platform bundle
   - run the lightweight packaged-bundle smoke on each native runner
   - assemble the npm wrapper and platform packages
   - run native-runner npm install smoke on Linux, Windows, macOS x64, and
     macOS arm64
   - optionally publish npm packages from the assembled artifact
   - optionally create or update the GitHub Release with archives, checksums,
     and the matching release-notes body
5. Review the results for the draft pass:
   - npm dry-run output looks correct
   - all native smoke jobs are green
   - the draft GitHub Release contains the expected per-platform archives and
     `.sha256` files
   - the release page body matches `release-notes.v<version>.md`
6. If the draft pass looks good, rerun `Release Manual` for the same commit
   with publish-oriented inputs:
   - `npm_publish_mode=publish` when you are ready to publish npm packages
   - `github_release_mode=publish` when you are ready to publish the release

Current workflow caveat:

- the workflow supports the draft-first pattern, but publishing currently means
  rerunning the full workflow for the same commit; it does not yet have a
  lightweight "publish existing draft release" path

Manual local note:

- `kato web init --username <username>` now prompts for the password on an
  interactive terminal
- keep release/CI smoke on `KATO_WEB_PASSWORD` or `--password-stdin`; do not
  rely on an interactive prompt in workflow automation

### Manual Fallback Steps

Use these only when debugging the workflow or bootstrapping a release outside
GitHub Actions.

1. Run the full local quality gate:

```bash
deno task ci
```

2. Build platform binaries with the scripted builder:

```bash
deno task build:binaries -- --output-dir <staging-dir>
```

3. Verify staged build metadata and version alignment:
   - inspect `<staging-dir>/build-metadata.json`
   - confirm CLI/daemon/web versions are aligned for the release cut
4. Package the staged binaries:

```bash
deno task package:binaries -- --input-dir <staging-dir> --label <platform-label>
```

5. Verify packaged bundle outputs:
   - versioned bundle directory exists
   - platform archive exists
   - archive checksum exists
   - `bundle-metadata.json` exists
6. Assemble npm wrapper and platform packages from the packaged bundle outputs:

```bash
deno task assemble:npm-packages -- --input-dir <bundle-dir> [--input-dir <bundle-dir> ...]
```

7. Run npm pack/install smoke on the assembled packages:

```bash
deno task smoke:npm-install -- --input-dir <npm-package-dir> --npm-bin <npm-path>
```

8. If publishing manually to npm from the assembled artifact, use:
   - `deno task publish:npm-packages -- --input-dir <npm-package-dir> --npm-bin <npm-path> --dry-run`
   - then the same command without `--dry-run`

### Current Verification Checklist

- [ ] `deno task ci` passed for the release commit.
- [ ] `Release Manual` completed the native binary build matrix for the release
      commit.
- [ ] `Release Manual` completed the packaged-bundle smoke slice on all four
      native runners.
- [ ] `Release Manual` completed the native npm install smoke matrix on Linux,
      Windows, macOS x64, and macOS arm64.
- [ ] The build artifacts show aligned CLI/daemon/web versions for the release
      cut.
- [ ] Each platform artifact bundle includes `kato`, `kato-daemon`, and
      `kato-web` unless an explicit fallback exception is documented.
- [ ] `kato web start` works from the packaged release output without invoking
      the Vite dev server.
- [ ] `/login` responds on the configured host/port after `kato web start`.
- [ ] `kato web status` and `kato web stop` succeed against the packaged web
      runtime.
- [ ] `Release Manual` npm dry-run or publish output looks correct for
      `@spectacular-voyage/kato` and the `@spectacular-voyage/kato-*`
      platform packages.
- [ ] The GitHub Release contains the expected per-platform archives, checksums,
      and matching release-notes body for the release version.
- [ ] Release notes distinguish developer `deno task dev:web` from installed
      `kato web start`.

### TODO

- [ ] Add a lightweight workflow path to publish an existing draft GitHub
      Release without rerunning the full release pipeline.
