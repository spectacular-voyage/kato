---
id: qj35rmg7lnprv1nf706jhh1
title: 2026 02 23 Improved Status
desc: ""
updated: 1771970992600
created: 1771870111637
---

## Goal

Improve `kato status` so it is useful for real operator workflows and reusable
by `kato-status-web`.

Logging-specific work is tracked separately in
[[task.2026.2026-02-23-awesome-logging]].

## Why This Matters

- Current status output only shows aggregate counts (`providers`, `recordings`)
  and hides the actionable data users care about: which sessions are recording,
  where output is going, and whether the session is stale.
- `kato-status-web` will need almost the same status projection logic, so
  sharing model/projection code avoids duplicate business logic.

## Scope (This Task)

1. Rich status model in shared contract
2. CLI status output improvements
3. Shared status projection/formatting logic for daemon + web reuse
4. Tests + docs updates

## Requirements

### 1) Status Command UX

`kato status` should include a session-level list for currently recording
sessions (active only by default):

- provider + session id
- short session label/snippet
- output destination
- started time
- last write/export time

Requested example direction:

```text
● claude/<session-id>: "<snippet>"
  -> /absolute/path/to/output.md
  started 1 day ago · last write 1 day ago
```

Rules:

- Default `kato status` shows active sessions only.
- `kato status --all` shows both active and stale sessions, and includes stale
  recordings as well.
- `kato status --json` includes the same richer data model in machine-readable
  form.
- `kato status --json --all` should include stale entries as well.

### 2) Shared Modeling for CLI + Web

Put reusable status model/projection logic in `shared/`:

- contracts for session-level and recording-level status entries
- stale filtering helpers
- lightweight projection helpers that daemon, CLI, and web can reuse

CLI-specific plain text formatting can remain in daemon, but it should consume
shared projected data.

### 3) "Live status"

- instead of returning, the status stays onscreen (maybe fullscreen) and updates in real time
- including a text-based memory graph would be nice. Keep execution-scope data fixed, and display most recent sessions/recordings. 

## Proposed Data Model Changes

Extend `DaemonStatusSnapshot` with session-level details instead of only
provider aggregate counts.

Candidate additions:

- `sessions: DaemonSessionStatus[]`
- `recordings.active: DaemonRecordingStatus[]` (or `recordings.entries`)
- performance data like memory use, maybe with OpenTelemetry

Candidate `DaemonSessionStatus` fields:

- `provider: string`
- `sessionId: string`
- `snippet?: string`
- `updatedAt: string`
- `lastMessageAt?: string`
- `stale: boolean` (or computed on read from `updatedAt`)
- `recording?: { outputPath: string; startedAt: string; lastWriteAt: string }`

Notes:

- Keep existing aggregate fields for compatibility in this task (`providers`,
  `recordings.activeRecordings`, `recordings.destinations`).
- Prefer additive contract change first; remove legacy aggregate-only surfaces
  later if needed.

## Status Format Recommendation (CLI)

Recommended text layout:

- Keep existing daemon/header lines.
- Add `Sessions:` section with one block per session.
- Sort by recency (`lastWriteAt`/`updatedAt` desc), then provider/session id.
- Mark stale rows explicitly when `--all` is used.

Suggested row style:

```text
Sessions:
● claude/<session-id>: "<snippet>"
  -> /path/to/destination.md
  recording · started 1d ago · last write 3h ago

○ codex/<session-id>: "<snippet>"
  (stale) no active recording · last message 2d ago
```

Legend:

- `●` active
- `○` stale

## Architecture Plan

### Daemon Runtime

- On heartbeat, derive rich session status from `sessionSnapshotStore.list()`.
- Join with `recordingPipeline.listActiveRecordings()` by provider/sessionId.
- Persist derived session/recording details to `status.json`.

### CLI

- Add `status --all` parser support.
- Default filtering: hide stale session rows.
- `--all`: include stale rows.
- `--json` returns richer snapshot as-is (filtered when `--all` is absent, or
  include all with explicit filter metadata; choose one and document).

### Web (`kato-status-web`)

- Consume same status snapshot fields.
- Reuse shared projection helpers for filtering/sorting and stale labeling.
- Avoid duplicating stale-threshold logic in app-specific code.

## Implementation Steps

1. Shared contracts

- Extend `shared/src/contracts/status.ts` with session/recording detail types.
- Export new types from `shared/src/mod.ts`.

2. Runtime status projection

- Add projection helper in `apps/daemon/src/orchestrator/daemon_runtime.ts` (or
  move pure pieces into shared).
- Persist rich status payload to status store.

3. CLI status command

- Extend parser/types for `status --all`.
- Implement detailed renderer in `apps/daemon/src/cli/commands/status.ts`.
- Ensure `--json` output carries new fields.

4. Web view model

- Update `apps/web/src/main.ts` to consume richer snapshot.
- Keep web formatting/presentation thin.

5. Documentation

- Update README command docs for `status --all`.
- Update `dev.codebase-overview` status model section.

## Testing Plan

- CLI parser tests for `status --all`.
- CLI output tests:
  - default hides stale
  - `--all` includes stale
  - displays provider/sessionId/output path/timestamps
- Runtime tests:
  - status snapshot includes active recording/session details
  - stale classification behavior is deterministic
- Web model tests for filtering/sorting parity with CLI projection rules.

## Acceptance Criteria

- `kato status` shows currently recording sessions with provider/session id and
  destination.
- `kato status --all` includes stale sessions and stale recording rows.
- Shared status projection/model logic is used by both CLI and web code paths.
- CI passes with updated tests and docs.

## Open Questions

- Stale threshold source-of-truth:
  - Reuse runtime `providerStatusStaleAfterMs` logic exactly, or add a dedicated
    status-view threshold?
- Label wording:
  - Keep `last write` terminology (matches current `RecordingPipeline`) or
    introduce `last export` only for export-specific actions?
- JSON filtering behavior:
  - Should `--json` always return full snapshot and let clients filter, or
    should `--json` obey `--all` filtering for parity with text output?
