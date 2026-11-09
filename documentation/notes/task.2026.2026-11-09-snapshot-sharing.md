---
id: hktye3ugj073dg3slqh4wxc
title: Snapshot Sharing
desc: Make each session update cost proportional to what arrived, not to the snapshot's size, by sharing immutable events in the in-memory snapshot store.
updated: 1794236363372
created: 1794236363372
---

## Goal

A session update should cost roughly the size of the new events. Long conversations with twins on should not keep the daemon busy.

## Summary

Found after installing v0.2.16 from npm on galactica. The daemon did not settle after start: sampled every 30 s from 11 to 21 minutes after start, it used 35–48% of a core, rising as more sessions were hydrated (20 to 25 snapshots, 94k to 127k events). The heap swung between 0.2 and 1 GB and RSS sat at 1.0–1.5 GB. The same parser measured about 12% and 350 MB before twins were on for Claude.

The startup cost was as documented (one full read per active Codex rollout, about 2 GB here, plus twin hydration of each newly active session). What stayed was per-update work that scaled with the snapshot:

- `InMemorySessionSnapshotStore.get()` deep-cloned every event (`structuredClone`), as did `upsert()` on the way in and on the way out.
- `upsert()` sized the snapshot with `JSON.stringify` of the whole snapshot.
- `mergeEvents` and the daemon runtime rebuilt a signature string for every existing event, including `JSON.stringify` of tool inputs.
- The runtime pass and the recording pass each called `get()` again.

With twins on, Claude snapshots are hydrated from the twin to the full 10,000 events instead of holding only content after the cursor, so these costs became visible on every long conversation. Separately, every `saveSessionMetadata` rewrote the 1.2 MB `daemon-control.json` (2,312 entries, sorted with `localeCompare`), about once per second, even though the entry rarely changes.

## Measurements

Benchmark on a real 10,000-event Claude twin (18 MB of event JSON), `origin/main` vs this branch:

| Operation | Before | After |
|---|---|---|
| `get()` | 32 ms | 0.0 ms |
| `get()` + `upsert()` with one new event | 273 ms | 0.5 ms |
| Ingest update: `get()` + `mergeEvents` (one new event) + `upsert()` | 261 ms | 2.3 ms |

## Decisions

See [[dev.decision-log]] "Snapshot Store Shares Sealed Events".

- Stored events are sealed: copied once, deep-frozen, registered in a `WeakSet` (`apps/daemon/src/orchestrator/sealed_events.ts`). Already sealed events pass through `upsert()` by reference; the caller's own objects are never frozen.
- `get()`, `list()`, and `upsert()` return a fresh events array, cursor, and metadata around the shared events.
- The size estimate is the envelope's JSON size plus each event's memoized size plus separators, identical to the previous full `JSON.stringify`.
- Merge and runtime signatures are memoized in `WeakMap`s only for sealed events.
- `saveSessionMetadata` uses `ensureDaemonControlEntry`, so the index is rewritten only when the entry differs. Nothing reads the index's top-level `updatedAt`.

## Open Issues

- Twin hydration (`readTwinEvents(metadata, 1)`) still reads and maps the whole twin on a session's first update after start or after eviction. A tail-window read would need the snippet to come from metadata rather than the full event stream.

## Implementation Plan

- [x] Add sealed-event helpers (`sealEvent`, `isSealedEvent`, `memoizeForSealedEvent`).
- [x] Share sealed events in `InMemorySessionSnapshotStore`; shallow-copy snapshots for callers; incremental size estimate.
- [x] Memoize `mergeEvents` and runtime event signatures for sealed events.
- [x] Skip `daemon-control.json` rewrites when the session's entry is unchanged.
- [x] Tests: isolation contract (mutating a stored event throws; array, metadata, and cursor are per-call copies), caller objects are copied and not frozen, stored events are shared by reference, size estimate equals the snapshot's JSON size.
- [x] `deno task ci`: 976 tests passed.
- [ ] Release and verify on galactica (CPU and RSS after the startup catch-up settles).
