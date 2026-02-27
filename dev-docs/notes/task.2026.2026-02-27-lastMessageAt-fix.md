---
id: difxpbo3om08c4jm1l7ft2o
title: 2026-02-27-lastMessageAt-fix
desc: ''
updated: 1772211556025
created: 1772211556025
---

# Fix Codex Synthetic Timestamp and Session Sort Order

## Summary

Two related bugs:

1. **Codex synthetic timestamp**: `parseCodexEvents` unconditionally sets
   `timestamp = new Date().toISOString()` for every event, regardless of
   whether ingestion is real-time or retrospective. For full-file parses
   (`fromOffset === 0`), this produces fake "right now" timestamps on
   historical events. Synthetic timestamps should only be set for incremental
   parses (`fromOffset > 0`), where parse time ≈ actual event time.

2. **Sort order bug**: `recencyKey` in `status_projection.ts` prefers
   `lastMessageAt` for sorting, with `updatedAt` as fallback. Sessions whose
   `lastMessageAt` is absent (not-yet-ingested sessions, Codex sessions after
   the fix) but have a recent `updatedAt` bubble to the top, appearing before
   sessions with real message timestamps.

## Root Cause

- `apps/daemon/src/providers/codex/parser.ts:198` — `timestamp` set
  unconditionally at parse-entry regardless of `fromOffset`.
- `shared/src/status_projection.ts:135` — `recencyKey` uses
  `s.lastMessageAt ?? s.updatedAt`, allowing a recent `updatedAt` to override
  absent `lastMessageAt` and sort those sessions first.

## Goal

- Codex events parsed retrospectively (`fromOffset === 0`) have no `timestamp`.
- Codex events parsed incrementally (`fromOffset > 0`) retain synthetic
  timestamp (close to real event time).
- All sessions sort by `updatedAt` exclusively — always present, always
  reflects actual daemon processing activity.
- Status display shows `updatedAt` as "modified X ago" and `lastMessageAt`
  as "last message X ago" when present; the "last message" field is omitted
  (not shown as "unknown") when absent.

## Implementation Plan

### 1. Fix Codex parser synthetic timestamp

- [ ] In [codex/parser.ts](apps/daemon/src/providers/codex/parser.ts), change
  line 198: only set `timestamp` when `fromOffset > 0`.
  ```ts
  const timestamp = fromOffset > 0 ? new Date().toISOString() : undefined;
  ```
- [ ] In `makeBase`, spread `timestamp` conditionally so it is omitted when
  undefined:
  ```ts
  ...(timestamp !== undefined ? { timestamp } : {}),
  ```

### 2. Fix sort key to use `updatedAt`

- [ ] In [status_projection.ts](shared/src/status_projection.ts), rewrite
  `recencyKey` to use `updatedAt` only:
  ```ts
  function recencyKey(s: DaemonSessionStatus): number {
    const parsed = Date.parse(s.updatedAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  ```
- [ ] Update the JSDoc comment above `recencyKey` to reflect `updatedAt`
  semantics.

### 3. Update status display

- [ ] In [status.ts](apps/daemon/src/cli/commands/status.ts), change
  `renderSessionRow` to always show `updatedAt` as "modified X ago" and show
  "last message X ago" only when `lastMessageAt` is present:
  ```ts
  const modified = formatRelativeTime(s.updatedAt, now);
  const lastMsg = s.lastMessageAt
    ? `  ·  last message ${formatRelativeTime(s.lastMessageAt, now)}`
    : "";
  const header = `${marker} ${s.provider}: ${label} (${identity})  ·  modified ${modified}${lastMsg}`;
  ```

### 4. Update Codex parser tests

- [ ] In [codex-parser_test.ts](tests/codex-parser_test.ts), add a test
  verifying that events parsed with `fromOffset === 0` have no `timestamp`
  field.
- [ ] Add a test verifying that events parsed with `fromOffset > 0` (i.e.
  incremental) carry a `timestamp`.

### 5. Update status projection tests

- [ ] In [status-projection_test.ts](tests/status-projection_test.ts), update
  tests whose names reference "uses lastMessageAt over lastWriteAt" — these
  were testing the old sort preference. Rewrite them to verify `updatedAt`
  ordering.
- [ ] Add a test: session with absent `lastMessageAt` but recent `updatedAt`
  sorts after a session with older `updatedAt` (i.e. no longer floats to top).

### 6. Update status render tests

- [ ] In [improved-status_test.ts](tests/improved-status_test.ts), update the
  test at line 158 ("missing lastMessageAt renders as unknown") — after this
  change, absent `lastMessageAt` should produce no "last message" segment, not
  the string "unknown".
- [ ] Update any other tests that assert against the old `last message
  ${time}` header format to match the new `modified ${time}` format.

### 7. Final check

- [ ] Run `deno task test` and confirm all tests pass.
- [ ] Run `deno task check` to confirm no type errors.
