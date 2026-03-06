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
