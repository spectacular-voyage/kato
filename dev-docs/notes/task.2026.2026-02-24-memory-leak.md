---
id: t78zclylrptbtn05ityl4rm
title: 2026 02 24 Memory Leak
desc: ''
updated: 1772034557412
created: 1772003421990
---

## Problem

`heapUsed` climbs steadily (~7 MB/min observed) even with no conversational
activity or recording. Root cause: `sessionSnapshotStore.list()` deep-clones
every event in every session via `structuredClone(snapshot)` on each call, and
it is called far more frequently than expected.

## Root Cause

`InMemorySessionSnapshotStore.list()` calls `cloneSnapshot()` on every
snapshot, which calls `structuredClone(snapshot)` — deep-cloning the full
`events` array for every session on every call.

Call sites and frequency:

| Call site | Frequency | Uses events? |
|-----------|-----------|--------------|
| `processInChatRecordingUpdates()` (line ~363) | Every poll — **1 second** | Yes (recording control commands) |
| Heartbeat `toSessionStatuses()` (line ~875) | Every 5 seconds | Only for `extractSnippet` |
| Shutdown `toSessionStatuses()` (line ~947) | Once | Only for `extractSnippet` |

With 53 sessions × ~293 events = ~15,500 events deep-cloned every **1 second**
in the polling loop. V8 cannot GC fast enough; heap ratchets up continuously.

## Secondary Issue: Budget Never Fires

`daemonMaxMemoryMb: 200` compares against `snapshots.estimatedBytes` (~31 MB),
but actual `heapUsed` is ~410 MB. The estimator counts UTF-8 byte lengths of
content strings but ignores V8 object overhead (~200 bytes/object). The budget
enforcement is effectively disabled.

## Scope

### Fix 1: Eliminate event iteration from heartbeat path (low risk)

Cache `snippet` in `SessionSnapshotStatusMetadata` during `upsert()`.
`toSessionStatuses` reads `snap.metadata.snippet` instead of passing
`snap.events` to `projectSessionStatus`. Removes the only reason the heartbeat
needs events from `list()`.

Files:
- `apps/daemon/src/orchestrator/ingestion_runtime.ts` — add `snippet?` to
  `SessionSnapshotStatusMetadata`; compute in `upsert()` using `extractSnippet`
- `shared/src/status_projection.ts` — `SessionProjectionInput.events` becomes
  optional; `projectSessionStatus` prefers `session.snippet` over extracting
  from events
- `apps/daemon/src/orchestrator/daemon_runtime.ts` — pass
  `snap.metadata.snippet` in `toSessionStatuses`; stop passing `snap.events`
- `shared/src/mod.ts` — no change needed (extractSnippet remains exported for
  tests and potential future use)

### Fix 2: Eliminate full event clone in polling loop (higher impact)

`processInChatRecordingUpdates` calls `list()` every second to find sessions
with pending recording commands. It only needs sessions that have new user
message events since last seen. Replace the `list()` call with a targeted
lookup — either:

a) Use `sessionSnapshotStore.get(sessionId)` per session instead of `list()`
   for each provider runner's known sessions
b) Add a `listMetadataOnly()` method that returns snapshots without cloning
   events, and only fetch events via `get()` when a session actually needs
   processing

Files:
- `apps/daemon/src/orchestrator/daemon_runtime.ts` —
  `processInChatRecordingUpdates` refactor
- `apps/daemon/src/orchestrator/ingestion_runtime.ts` — optionally add
  `listMetadataOnly()` to `SessionSnapshotStore` interface

### Fix 3: Improve memory estimator (tracking accuracy)

Add per-object overhead to `estimateSnapshotBytes()` so the budget check
reflects actual V8 heap consumption and evictions actually trigger.

Files:
- `apps/daemon/src/orchestrator/ingestion_runtime.ts` —
  `estimateSnapshotBytes()` method

## Implementation Order

1. Fix 1 (snippet caching) — isolated, low risk, fixes heartbeat path
2. Fix 2 (polling loop) — higher impact, eliminates the dominant allocation source
3. Fix 3 (estimator) — makes budget enforcement meaningful

## Acceptance Criteria

- [x] `heapUsed` stabilizes under idle conditions (no conversational activity)
- [x] `evictions` fire when `daemonMaxMemoryMb` is exceeded under load
- [x] `deno task ci` passes

## Open Questions

- Should Fix 2 use option (a) or (b)?
  - Option (a): simpler, no interface change; requires knowing which sessions
    each runner owns
  - Option (b): cleaner abstraction; small interface addition
