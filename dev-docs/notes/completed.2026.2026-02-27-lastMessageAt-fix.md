---
id: difxpbo3om08c4jm1l7ft2o
title: 2026-02-27-lastMessageAt-fix
desc: ''
updated: 1772418125827
created: 1772211556025
---

# Fix Codex Synthetic Timestamp And Status Time Fields

Implementation is complete on the current branch. The remaining unchecked items
below are the full `deno task check` / full-suite verification pass.

## Summary

Three related issues are still bundled together here:

1. **Codex synthetic timestamp**: `parseCodexEvents` still stamps
   `timestamp = new Date().toISOString()` onto every event, even for
   retrospective parses. For full-file parses (`fromOffset === 0`), that
   produces fake "right now" timestamps on historical events. The session twin
   mapper already knows this and drops those timestamps when writing the twin,
   but the in-memory snapshot path still reads the raw parser timestamp via
   `readLastEventAt`, so runtime `lastEventAt` remains poisoned.

2. **Sort order bug**: `recencyKey` in `status_projection.ts` still prefers
   `lastMessageAt` for sorting, with `updatedAt` as fallback. That mixes
   optional event-time with daemon-ingest-time and makes ordering sensitive to
   absent or synthetic event timestamps.

3. **Status naming shim**: the public status contracts still expose
   `lastMessageAt`, but the value is projected from `lastEventAt`. That name is
   now misleading and should be removed in favor of `lastEventAt` everywhere in
   the status API surface.

## Root Cause

- `codex/parser.ts` sets `timestamp` unconditionally at parse entry regardless
  of `fromOffset`.
- `status_projection.ts` uses `s.lastMessageAt ?? s.updatedAt` for recency
  sorting.
- `status.ts`, `status_projection.ts`, `daemon_runtime.ts`, and
  `control_plane.ts` still serialize and validate the old `lastMessageAt` field
  name even though the source data is `lastEventAt`.

## Current Reality

- `updatedAt` is the canonical session-modified / daemon-ingest timestamp.
- `lastEventAt` is the canonical optional event-time signal in runtime snapshot
  state.
- `lastMessageAt` is only a projection alias today; it is not a distinct source
  of truth.
- This task should **not** rename `updatedAt`. The earlier
  `updatedAt` → `lastDaemonIngestTime` idea is unnecessary churn and does not
  help the actual bug surface.

## Goals

- Codex events parsed retrospectively (`fromOffset === 0`) have no `timestamp`.
- Codex events parsed incrementally (`fromOffset > 0`) retain synthetic
  timestamp (close to real event time). **Known limitation**: after a daemon
  restart with a backlog of file changes, the first incremental parse
  (`fromOffset > 0`) can still include events created hours or days prior. That
  timestamp may still be inaccurate; Codex source files contain no per-event
  timestamps, so no better option exists.
- All sessions sort by `updatedAt` exclusively.
- Public status contracts use `lastEventAt` instead of `lastMessageAt`.
- Status display always shows `updatedAt` as the canonical modified time and
  shows a separate `last event X ago` segment only when `lastEventAt` is
  present.

## Non-goals

- Do not rename `updatedAt` to `lastDaemonIngestTime` in this task.
- Do not change the core meaning of `updatedAt`; use it more consistently.

## Contract Change: `ConversationEvent.timestamp` becomes optional

Making `timestamp` optional in `ConversationEventBase` is required to allow
Codex retrospective events to carry no timestamp without violating the type
contract. Downstream callsites were audited:

| Location | Required fix |
| --- | --- |
| `markdown_writer.ts` | Widen heading timestamp handling to accept `undefined`; avoid `"undefined"` in fingerprints/rendering. |
| `daemon_runtime.ts` | Guard fingerprint strings and timestamp-length checks for missing `timestamp`. |
| `provider_ingestion.ts` | Guard dedupe fingerprints for missing `timestamp`. |
| `daemon_runtime.ts`, `ingestion_runtime.ts`, `session_twin_mapper.ts` | Existing time readers already tolerate `undefined`; verify and leave intact if still true. |

## Implementation Plan

### 0. Keep `updatedAt` as-is

- [x] Keep `updatedAt` as the canonical daemon-ingest / session-modified time.
- [x] Remove stale references in this task and related tests/docs that imply an
  `updatedAt` rename is part of the work.

### 1. Widen the event contract

- [x] In [events.ts](shared/src/contracts/events.ts), change
  `ConversationEventBase` to:
  ```ts
  timestamp?: string;
  ```

### 2. Fix downstream callsites

- [x] In [markdown_writer.ts](apps/daemon/src/writer/markdown_writer.ts):
  - Widen `formatHeadingTimestamp` signature to `(timestamp: string |
    undefined)`.
  - Fix fingerprint templates to use `${event.timestamp ?? ""}`.
- [x] In [daemon_runtime.ts](apps/daemon/src/orchestrator/daemon_runtime.ts):
  - Fix fingerprint templates to use `${event.timestamp ?? ""}`.
  - Fix `.length > 0` guards to use `(candidate.timestamp?.length ?? 0) > 0`.
- [x] In
  [provider_ingestion.ts](apps/daemon/src/orchestrator/provider_ingestion.ts):
  - Fix fingerprint templates to use `${event.timestamp ?? ""}`.

### 3. Fix Codex parser synthetic timestamp

- [x] In [codex/parser.ts](apps/daemon/src/providers/codex/parser.ts), only
  set `timestamp` when `fromOffset > 0`:
  ```ts
  const timestamp = fromOffset > 0 ? new Date().toISOString() : undefined;
  ```
- [x] In `makeBase`, spread `timestamp` conditionally so it is omitted when
  undefined:
  ```ts
  ...(timestamp !== undefined ? { timestamp } : {}),
  ```

### 4. Remove the `lastMessageAt` status naming shim

- [x] In [status.ts](shared/src/contracts/status.ts), rename:
  - `ProviderStatus.lastMessageAt` → `lastEventAt`
  - `DaemonSessionStatus.lastMessageAt` → `lastEventAt`
- [x] In [status_projection.ts](shared/src/status_projection.ts), project
  `lastEventAt` directly instead of `lastMessageAt`.
- [x] In
  [daemon_runtime.ts](apps/daemon/src/orchestrator/daemon_runtime.ts), update
  provider aggregates and session projections to emit `lastEventAt`.
- [x] In [control_plane.ts](apps/daemon/src/orchestrator/control_plane.ts),
  update status-file validation to accept `lastEventAt` instead of
  `lastMessageAt`.
- [x] In [status.ts](apps/daemon/src/cli/commands/status.ts), update snapshot
  normalization and staleness checks to consume `lastEventAt`.
- [x] Update tests that still reference `lastMessageAt` in status objects or
  status render output.

### 5. Fix sort key to use `updatedAt` only

- [x] In [status_projection.ts](shared/src/status_projection.ts), rewrite
  `recencyKey` to use `updatedAt` only:
  ```ts
  function recencyKey(s: DaemonSessionStatus): number {
    const parsed = Date.parse(s.updatedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  ```
- [x] Update the JSDoc above `recencyKey` to reflect `updatedAt` semantics,
  not `lastMessageAt` fallback semantics.

### 6. Update status display

- [x] In [status.ts](apps/daemon/src/cli/commands/status.ts), change
  `renderSessionRow` so the header reflects the split clearly:
  - always show `updatedAt` as a legible local timestamp (for example
    `2026-03-01 12:34`)
  - optionally include a relative `modified X ago` segment
  - show `last event X ago` only when `lastEventAt` is present
  - omit the `last event` segment entirely when absent

### 7. Update Codex parser tests

- [x] In [codex-parser_test.ts](tests/codex-parser_test.ts), add a test
  verifying that events parsed with `fromOffset === 0` have no `timestamp`
  field (or `undefined`).
- [x] Add a test verifying that events parsed with `fromOffset > 0`
  (incremental) carry a defined `timestamp`.

### 8. Update status projection tests

- [x] In [status-projection_test.ts](tests/status-projection_test.ts), update
  tests whose names or fixtures reference `lastMessageAt` as the recency key.
  Rewrite them to verify `updatedAt` ordering.
- [x] Add a test confirming the fix: a session with absent `lastEventAt` and
  older `updatedAt` sorts after a session with newer `updatedAt`, regardless of
  `lastEventAt` presence on the newer session.

### 9. Update status render tests

- [x] In [improved-status_test.ts](tests/improved-status_test.ts), update the
  current "missing lastMessageAt renders as unknown" case so absent
  `lastEventAt` produces no `last event` segment at all.
- [x] Update any other tests asserting against the old `last message ${time}`
  header format to match the new `updatedAt` / `last event` split.

### 10. Final check

- [ ] Run `deno task check` to confirm no type errors.
- [ ] Run the full `deno task test` suite and confirm all tests pass.
