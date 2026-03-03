---
id: nqa3ggx8aoe186xd1b6qrq4
title: 2026 03 02 Little Stuff
desc: ''
updated: 1772548910879
created: 1772523156700
---

## Goal

Prepare a minimum-shippable, source-only `v0.2.0` release and curate release-adjacent backlog/docs so they reflect current reality.

## Summary

This task locks a low-churn `v0.2.0` scope:

- source-only release (no compiled binaries in `v0.2.0`)
- documentation and backlog curation across `[[dev.todo]]` and `[[task.2026.2026-02-22-ci-cd]]`
- one versioning change (`deno.json`)
- one targeted regression test (cross-kind dedupe)

GitHub policy hardening (branch protection and release environment) remains follow-up hardening, not a blocker for first source-only release.

## Discussion

### Scope Lock

- Release model: source-only `v0.2.0`.
- Churn profile: low.
- Docs touched in this task: `task.2026.2026-03-02-little-stuff.md`, `task.2026.2026-02-22-ci-cd.md`, `dev.todo.md`, `dev.release-runbook.md`.
- No new release workflow YAML for binaries in this task.

### Current-State Matrix: `dev.todo` Release-Adjacent Items

| Item | Current State | v0.2.0 Action | Notes |
| --- | --- | --- | --- |
| Codex `request_user_input` fixture + decision synthesis tests | Done | Close | Fixture exists and parser coverage is in place. |
| Cross-kind dedupe regression test | Open | Complete now | Add explicit test that different `kind` values do not dedupe. |
| `JsonlConversationWriter` in active recording pipeline | Open | Defer | Behavior expansion not required for source-only release. |
| `SessionSnapshotStore delete/clear` + clean integration | Open | Defer | Medium implementation; not release-critical for `v0.2.0`. |
| `kato config validate` CLI command | Open | Defer | Useful hardening, but out of low-churn release scope. |
| Compiled-runtime permission smoke coverage | Open | Defer | Binary packaging is intentionally deferred post-`v0.2.0`. |

### Current-State Matrix: CI/CD for Source-Only `v0.2.0`

| Item | Current State | v0.2.0 Action | Notes |
| --- | --- | --- | --- |
| CI workflow (`.github/workflows/ci.yml`) | Done | Keep | `deno task ci` on PR + main exists. |
| Version field in `deno.json` | Missing | Complete now | Set to `0.2.0`. |
| Binary release workflows | Missing | Defer | Move to post-`v0.2.0` track. |
| Coverage patch gate / Codecov | Missing | Defer | Keep as hardening backlog after first release. |
| Dependabot for actions | Missing | Defer | Keep as post-release hardening item. |

### First-Release Readiness Prerequisites

| Prerequisite | Status | Release Blocking? | Notes |
| --- | --- | --- | --- |
| Source-only release runbook in `dev.release-runbook.md` | Complete in this task | Yes | Must define release steps and verification. |
| `deno task ci` green locally | Complete in this task | Yes | Baseline quality gate. |
| Branch protection on `main` | Open | No (for first source-only release) | Track as immediate follow-up hardening. |
| GitHub `release` environment/reviewers | Open | No (for first source-only release) | Needed when binary workflow is introduced. |

## Contract Changes

- Add `"version": "0.2.0"` to [deno.json](/home/djradon/hub/spectacular-voyage/kato/deno.json).
- User-visible effect: `kato --version` resolves to `0.2.0` through existing version loader.
- Documentation contract updates:
  - `[[task.2026.2026-02-22-ci-cd]]` now explicitly splits active source-only track vs deferred binary track.
  - `[[dev.todo]]` reflects completed stale items and intentional low-churn deferrals.
  - `dev.release-runbook.md` includes source-only release runbook and explicit binary defer statement.

## Testing

- Add ingestion regression test:
  - two events with same content/timestamp/provider metadata but different `kind` values must both remain after dedupe.
- Run full verification:

```bash
deno task test
deno task check
deno task ci
```

## Non-Goals

- Adding `deno compile` release workflows in this task.
- Enabling Codecov/patch coverage gates in this task.
- Implementing `kato config validate`.
- Wiring JSONL into active recording append pipeline.
- Solving broader config-migration strategy in this task.

## Implementation Plan

### v0.2.0 Task Execution

- [x] Rewrite this task note to decision-complete execution format.
- [x] Add state matrices for `dev.todo`, CI/CD, and release prerequisites.
- [x] Curate `[[dev.todo]]`: close stale completed item(s), mark deferrals with rationale.
- [x] Update `[[task.2026.2026-02-22-ci-cd]]` to active source-only vs deferred binary tracks.
- [x] Add source-only release runbook to `dev.release-runbook.md`.
- [x] Set `deno.json` version to `0.2.0`.
- [x] Add cross-kind dedupe regression test in `tests/provider-ingestion_test.ts`.
- [x] Run `deno task test`, `deno task check`, and `deno task ci`.

### Immediate Post-Release Hardening (Tracked, Not Blocking v0.2.0)

- [ ] Enable branch protection requiring CI checks.
- [ ] Add Dependabot for GitHub Actions.
- [ ] Add coverage artifact generation and patch coverage gate.
- [ ] Add binary distribution workflow(s) with scoped `deno compile` permissions.

## Follow-Up (March 3, 2026)

- Gemini support was revalidated in a real VS Code session:
  - new chat snippet `test12345` was ingested into Kato status/session metadata
  - Gemini `::capture-k` command application was observed in operational logs
- No additional implementation work is required for this item in `v0.2.0`
  scope; deeper investigation is deferred.
