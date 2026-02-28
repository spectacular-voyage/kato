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
   historical events. The session twin mapper already knows this (comment at
   `session_twin_mapper.ts:29`: "Codex parser timestamps are synthetic for
   backprocessing; omit") and drops them when writing the twin, but the
   in-memory snapshot store still reads the raw parser `timestamp` via
   `readLastEventAt`, so `lastEventAt`/`lastMessageAt` is still poisoned.
   Synthetic timestamps should only be set for incremental parses
   (`fromOffset > 0`), where parse time ≈ actual event time.

2. **Sort order bug**: `recencyKey` in `status_projection.ts` prefers
   `lastMessageAt` for sorting, with `updatedAt` as fallback. Sessions whose
   `lastMessageAt` is absent (not-yet-ingested sessions, or Codex sessions
   after the fix below) but have a recent `updatedAt` can bubble above sessions
   with older but real message timestamps.

## Root Cause

- `codex/parser.ts:198` — `timestamp` set unconditionally at parse-entry
  regardless of `fromOffset`.
- `status_projection.ts:135` — `recencyKey` uses `s.lastMessageAt ??
  s.updatedAt`, so a recent `updatedAt` with absent `lastMessageAt` can
  override sessions that have a real but older `lastMessageAt`.

## Goals

- Codex events parsed retrospectively (`fromOffset === 0`) have no `timestamp`.
- Codex events parsed incrementally (`fromOffset > 0`) retain synthetic
  timestamp (close to real event time). **Known limitation**: after a daemon
  restart with a backlog of file changes, the first incremental parse
  (`fromOffset > 0`) can still include events created hours or days prior.
  In that case the synthetic timestamp will still be inaccurate. This is
  accepted — Codex source files contain no per-event timestamps, so no better
  option exists.
- All sessions sort by `updatedAt` exclusively — always present, always
  reflects actual daemon processing activity.
- Status display shows `updatedAt` as "modified X ago" always, and
  `lastMessageAt` as "last message X ago" only when present; the "last
  message" segment is omitted (not shown as "unknown") when absent.

## Contract Change: `ConversationEvent.timestamp` becomes optional

Making `timestamp` optional in `ConversationEventBase` is required to allow
Codex retrospective events to carry no timestamp without violating the type
contract. Downstream callsites were audited:

| Location | Issue | Required fix |
|---|---|---|
| `markdown_writer.ts:60` | `formatHeadingTimestamp(timestamp: string)` won't accept `undefined` | Widen param to `string \| undefined` |
| `markdown_writer.ts:134` | `${event.timestamp}` → string `"undefined"` if absent | `?? ""` |
| `daemon_runtime.ts:168` | Same fingerprint corruption | `?? ""` |
| `daemon_runtime.ts:696–698` | `.length > 0` on possibly-`undefined` | `?.length ?? 0` |
| `provider_ingestion.ts:602` | Same fingerprint corruption | `?? ""` |
| `daemon_runtime.ts:1547` | `readTimeMs(event.timestamp)` | Already `string \| undefined` ✓ |
| `ingestion_runtime.ts:153` | `events[i]?.timestamp` | Already optional-chained ✓ |
| `session_twin_mapper.ts:36` | `normalizeText(event.timestamp)` | `normalizeText` returns `""` for non-strings ✓ |

## Implementation Plan

### 1. Widen contract

- [ ] In [events.ts](shared/src/contracts/events.ts), change
  `ConversationEventBase`:
  ```ts
  timestamp?: string;
  ```

### 2. Fix downstream callsites

- [ ] In [markdown_writer.ts](apps/daemon/src/writer/markdown_writer.ts):
  - Widen `formatHeadingTimestamp` signature to `(timestamp: string |
    undefined)`.
  - Fix fingerprint template: `${event.timestamp ?? ""}`.
- [ ] In [daemon_runtime.ts](apps/daemon/src/orchestrator/daemon_runtime.ts):
  - Fix fingerprint template at line 168: `${event.timestamp ?? ""}`.
  - Fix `.length > 0` guards at lines 696–698:
    `(candidate.timestamp?.length ?? 0) > 0`.
- [ ] In [provider_ingestion.ts](apps/daemon/src/orchestrator/provider_ingestion.ts):
  - Fix fingerprint template at line 602: `${event.timestamp ?? ""}`.

### 3. Fix Codex parser synthetic timestamp

- [ ] In [codex/parser.ts](apps/daemon/src/providers/codex/parser.ts), change
  line 198: only set `timestamp` when `fromOffset > 0`:
  ```ts
  const timestamp = fromOffset > 0 ? new Date().toISOString() : undefined;
  ```
- [ ] In `makeBase`, spread `timestamp` conditionally so it is omitted when
  undefined:
  ```ts
  ...(timestamp !== undefined ? { timestamp } : {}),
  ```

### 4. Fix sort key to use `updatedAt`

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

### 5. Update status display

- [ ] In [status.ts](apps/daemon/src/cli/commands/status.ts), change
  `renderSessionRow` to always show `updatedAt` as "modified X ago" and
  show "last message X ago" only when `lastMessageAt` is present:
  ```ts
  const modified = formatRelativeTime(s.updatedAt, now);
  const lastMsg = s.lastMessageAt
    ? `  ·  last message ${formatRelativeTime(s.lastMessageAt, now)}`
    : "";
  const header = `${marker} ${s.provider}: ${label} (${identity})  ·  modified ${modified}${lastMsg}`;
  ```

### 6. Update Codex parser tests

- [ ] In [codex-parser_test.ts](tests/codex-parser_test.ts), add a test
  verifying that events parsed with `fromOffset === 0` have no `timestamp`
  field (or `undefined`).
- [ ] Add a test verifying that events parsed with `fromOffset > 0`
  (incremental) carry a defined `timestamp`.

### 7. Update status projection tests

- [ ] In [status-projection_test.ts](tests/status-projection_test.ts), update
  tests whose names reference "uses lastMessageAt over lastWriteAt" — these
  tested the old sort preference. Rewrite them to verify `updatedAt` ordering.
- [ ] Add a test confirming the fix: a session with absent `lastMessageAt` and
  **older** `updatedAt` sorts **after** a session with newer `updatedAt` and
  present `lastMessageAt`. (Previously the absent-`lastMessageAt` session
  would float incorrectly above sessions with older but real timestamps due
  to the `?? updatedAt` fallback.)

### 8. Update status render tests

- [ ] In [improved-status_test.ts](tests/improved-status_test.ts), update the
  test at line 158 ("missing lastMessageAt renders as unknown") — absent
  `lastMessageAt` should now produce no "last message" segment at all.
- [ ] Update any other tests asserting against the old `last message ${time}`
  header format to match the new `modified ${time}` format.

### 9. Final check

- [ ] Run `deno task check` to confirm no type errors.
- [ ] Run `deno task test` and confirm all tests pass.
