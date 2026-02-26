---
id: qj35rmg7lnprv1nf706jhh1
title: 2026 02 23 Improved Status
desc: ''
updated: 1771998167782
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

## Dependency

This task explicitly depends on:

- [task.2026.2026-02-24-memory-management](./completed.2026.2026-02-24-memory-management.md) ✓ Complete

Required prerequisite outputs from that task (all delivered):

- `RuntimeConfig.daemonMaxMemoryMb`
- `DaemonStatusSnapshot.memory.daemonMaxMemoryBytes`
- `DaemonStatusSnapshot.memory.process.{rss,heapTotal,heapUsed,external}`
- `DaemonStatusSnapshot.memory.snapshots.{estimatedBytes,sessionCount,eventCount}`
- `DaemonStatusSnapshot.memory.snapshots.evictions{...}`
- `DaemonStatusSnapshot.memory.snapshots.overBudget`

Status UX in this task should **consume/display** these fields, not invent a
separate memory model.

## Scope (This Task)

1. Rich status model in shared contract
2. CLI status output improvements
3. Shared status projection/formatting logic for daemon + web reuse
4. Memory-section consumption from prereq task
5. Live/watch mode
6. Tests + docs updates

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
- `kato status --json` carries the same richer data model in machine-readable
  form, including the memory section. Text and JSON output must have **parity**:
  whatever fields appear in text output must also be present in JSON, and
  vice-versa (no JSON-only or text-only fields except cosmetic formatting).
- `kato status --json --all` includes stale entries as well.

### 2) Shared Modeling for CLI + Web

Put reusable status model/projection logic in `shared/`:

- contracts for session-level and recording-level status entries
- stale filtering helpers
- lightweight projection helpers that daemon, CLI, and web can reuse

CLI-specific plain text formatting can remain in daemon, but it should consume
shared projected data.

### 3) "Live status" (`--live` / `--watch`)

A simple **refresh-loop display** — not a full interactive TUI.

Design goals (inspired by [melker.sh](https://melker.sh/)):

- Clean, compact fixed-layout sections separated by dividers.
- Readable at a glance: header, sessions block, memory block.
- Monospace, no color required but ANSI is fine where the terminal supports it.

Behavior:

- `kato status --live` clears the terminal and redraws the full status block on
  a configurable interval (default: 2 seconds).
- Layout is **fixed-height per section** — sessions block shows the N most
  recent sessions (default 5), not an unbounded scrolling list.
- Press `q` or `Ctrl+C` to exit live mode.
- No interactive navigation, no resize handling, no alternate-screen buffer
  management. This is a refresh loop, not a TUI.
- `--live` implicitly applies `--all` (stale rows shown with `○` marker).

Example layout:

```text
kato  ·  daemon running  ·  refreshed 12:34:05
─────────────────────────────────────────────────

Sessions (5 most recent):
● claude/abc123: "how do I configure X"
  -> ~/notes/claude.md
  recording · started 2h ago · last write 1m ago

○ codex/def456: "refactor the auth module"
  (stale) no active recording · last message 3d ago

─────────────────────────────────────────────────
Memory:
  rss 142 MB / 200 MB budget  ·  snapshots 38 MB
  sessions 12  ·  events 4820  ·  evictions 0
```

Out of scope for this task:

- Sparklines or historical memory graphs (additive, future task).
- Interactive session selection or scrolling.
- Alternate-screen buffer (`smcup`/`rmcup`) management.

### 4) Memory Visibility

Text and JSON output have full parity on memory fields:

- Default `kato status` (text): compact memory summary line — rss + snapshot
  estimated bytes + budget + over-budget flag.
- `kato status --json`: includes the full `memory` section (all fields from the
  memory-management prereq).
- `--live` mode: shows the same compact memory block, refreshed each cycle.
- Over-budget state is visually highlighted (e.g., `⚠ OVER BUDGET`) in text
  output.

## Proposed Data Model Changes

Extend `DaemonStatusSnapshot` with session-level details instead of only
provider aggregate counts.

Candidate additions:

- `sessions: DaemonSessionStatus[]`
- `recordings.active: DaemonRecordingStatus[]` (or `recordings.entries`)
- `memory: ...` from memory-management task (required, not optional)

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
- Add `Memory:` section with compact summary line.

Suggested row style:

```text
Sessions:
● claude/<session-id>: "<snippet>"
  -> /path/to/destination.md
  recording · started 1d ago · last write 3h ago

○ codex/<session-id>: "<snippet>"
  (stale) no active recording · last message 2d ago

Memory:
  rss 142 MB / 200 MB budget  ·  snapshots 38 MB
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

- Add `status --all` and `status --live` parser support.
- Default filtering: hide stale session rows.
- `--all`: include stale rows.
- `--live`: refresh-loop mode (implies `--all`).
- `--json` returns richer snapshot as-is; obeys `--all` filter for parity with
  text output (full snapshot always available via `--json --all`).

### Web (`kato-status-web`)

- Consume same status snapshot fields.
- Reuse shared projection helpers for filtering/sorting and stale labeling.
- Avoid duplicating stale-threshold logic in app-specific code.

## Implementation Steps

### 0. Dependency gate

- [x] Verify memory-management task is complete and contract fields are present.

### 1. Shared contracts

- [x] Extend `shared/src/contracts/status.ts` with session/recording detail types.
- [x] Add `DaemonSessionStatus` and `DaemonRecordingStatus` types.
- [x] Export new types from `shared/src/mod.ts`.

### 2. Runtime status projection

- [x] Add `toSessionStatuses` helper in
      `apps/daemon/src/orchestrator/daemon_runtime.ts`.
- [x] Add pure projection helpers in `shared/src/status_projection.ts`.
- [x] Join session snapshot list with active recordings on heartbeat.
- [x] Persist rich status payload (sessions + memory) to status store.

### 3. CLI status command

- [x] Extend parser/types for `status --all` and `status --live`.
- [x] Implement detailed session renderer in
      `apps/daemon/src/cli/commands/status.ts`.
- [x] Add compact memory summary line to default text output.
- [x] Add over-budget visual highlight.
- [x] Ensure `--json` output carries new session and memory fields (text/JSON
      parity).
- [x] Implement `--live` refresh-loop: clear + redraw on interval, exit on `q`
      or Ctrl+C.
- [x] Cap live session list at N most recent (default 5).

### 4. Web view model

- [x] Update `apps/web/src/main.ts` to consume richer snapshot (sessions +
      memory).
- [x] Keep web formatting/presentation thin; reuse shared projection helpers.

### 5. Documentation

- [ ] Update README command docs for `status --all` and `status --live`.
- [ ] Update `dev.codebase-overview` status model section.
- [ ] Document memory summary fields and their source task dependency.
- [ ] Document text/JSON parity contract.

## Testing Plan

- [x] CLI parser tests:
  - [x] `status --all` flag parsed correctly
  - [x] `status --live` flag parsed correctly
  - [x] `status --json --all` combination works
- [x] CLI output tests:
  - [x] default hides stale sessions
  - [x] `--all` includes stale sessions
  - [x] session block displays provider/sessionId/output path/timestamps
  - [x] memory summary line present in default text output
  - [x] over-budget flag shown when `memory.snapshots.overBudget` is true
  - [x] `--json` and text output have field parity (no JSON-only or text-only
        fields)
- [ ] Runtime tests:
  - [ ] status snapshot includes active recording/session details
  - [ ] stale classification behavior is deterministic
  - [ ] heartbeat projection populates memory section from process + store
- [x] Live mode tests:
  - [x] session list capped at N most recent
- [x] Memory tests:
  - [x] text output shows memory summary when memory section is present
  - [x] over-budget state reflected in both text and JSON
- [x] Web model tests:
  - [x] filtering/sorting parity with CLI projection rules

## Acceptance Criteria

- [x] `kato status` shows currently recording sessions with provider/session id
      and destination.
- [x] `kato status --all` includes stale sessions and stale recording rows.
- [x] Both text and `--json` output include memory information sourced from
      memory-management fields (full parity).
- [x] `kato status --live` provides a periodic refresh-loop display with fixed
      layout: header, sessions block (capped), memory block.
- [x] Shared status projection/model logic is used by both CLI and web code
      paths.
- [ ] CI passes with updated tests and docs.

## Open Questions

- Stale threshold source-of-truth:
  - Reuse runtime `providerStatusStaleAfterMs` logic exactly, or add a dedicated
    status-view threshold?
- Label wording:
  - Keep `last write` terminology (matches current `RecordingPipeline`) or
    introduce `last export` only for export-specific actions?
- Live mode refresh interval:
  - Hard-coded 2s default, or runtime config / `--interval` flag?
- Live mode session cap:
  - Hard-coded 5, or `--count` flag?
