---
id: hn7t9bp0x9wkhvtcgw4255u
title: 2026 02 24 Memory Management
desc: ""
updated: 1771976234475
created: 1771971777228
---

# Daemon Memory Management (Prereq for Improved Status)

## Goal

Make daemon memory behavior explicit, bounded, and observable so:

- capture can retain long histories (`maxEventsPerSession` no longer tiny)
- status can report reliable memory/performance numbers
- runtime cannot grow unbounded due to session snapshots

This task is a **prerequisite** for:

- [task.2026.2026-02-23-improved-status](./task.2026.2026-02-23-improved-status.md)

## Non-Goals

- Persisting full normalized event history to disk.
- Replacing provider raw files as source data.
- Building full OpenTelemetry exporters/instrumentation baseline.
- Implementing idle/time-based eviction.

## Locked Decisions

- Keep `InMemorySessionSnapshotStore` as canonical runtime state.
- Budget control is global daemon budget, not snapshot-only budget:
  - `daemonMaxMemoryMb` in `RuntimeConfig`
  - default: `200` MB
- Status must include both:
  - process memory (`Deno.memoryUsage()` fields: `rss`, `heapTotal`, `heapUsed`,
    `external`)
  - snapshot-store memory/accounting metrics
- Idle eviction is **deferred** (not in this task).
- Eviction policy should be deterministic (LRU by last upsert/update time).
- Over-budget handling:
  - evict stale/old sessions first
  - if only one session remains and daemon is still over budget, daemon exits
    with a clear error (fail-closed)

## Scope Checklist

### 1) Runtime Config + Contracts

- [x] Add `daemonMaxMemoryMb: number` to `RuntimeConfig` contract.
- [x] Add parser/validator/default wiring in daemon config loader.
- [x] Enforce positive safe integer; fail-closed on invalid values.
- [x] Add env override support if desired (`KATO_DAEMON_MAX_MEMORY_MB`), with
      clear precedence documentation.

### 2) Snapshot Retention + Budget Enforcement

- [x] Raise default `maxEventsPerSession` from `200` to `10000`.
- [x] Add snapshot memory estimator inside `InMemorySessionSnapshotStore`
      (events + metadata).
- [x] Track running totals:
  - [x] `estimatedSnapshotBytes`
  - [x] `retainedEventCount`
  - [x] `sessionCount`
  - [x] eviction counters (`evictionsTotal`, `bytesReclaimedTotal`,
        `evictionsByReason`)
- [x] On upsert, enforce budget with LRU eviction until within budget.
- [x] If still over budget with one session left, emit final diagnostic and
      terminate daemon with explicit message.

### 3) Status Contract (Prereq for Improved Status)

- [x] Extend `DaemonStatusSnapshot` with memory/perf section (additive change):
  - [x] `memory.daemonMaxMemoryBytes`
  - [x] `memory.process.{rss,heapTotal,heapUsed,external}`
  - [x] `memory.snapshots.{estimatedBytes,sessionCount,eventCount}`
  - [x] `memory.snapshots.evictions{...}`
  - [x] `memory.snapshots.overBudget`
- [x] Populate these fields in daemon heartbeat/status projection.
- [x] Ensure `kato status --json` exposes this data without requiring
      improved-status text UX changes.

### 4) Observability + Logging

- [x] Add operational events for:
  - [x] memory sample / summary updates
  - [x] eviction actions
  - [x] over-budget shutdown path
- [ ] Keep OpenTelemetry/Sentry integration out-of-scope here; document hook
      points only.

### 5) Tests

- [x] Config tests:
  - [x] accepts valid `daemonMaxMemoryMb`
  - [x] rejects zero/negative/non-integer values
- [ ] Store tests:
  - [ ] enforces `maxEventsPerSession=10000` default
  - [x] deterministic LRU eviction under pressure
  - [x] counters/estimated-bytes update correctly
  - [x] over-budget single-session path triggers fail-closed behavior
- [x] Runtime/status tests:
  - [x] status snapshot contains memory section
  - [x] process memory fields are populated
  - [x] eviction/over-budget events are logged

## Acceptance Criteria

- `daemonMaxMemoryMb` is enforced at runtime with deterministic eviction.
- Snapshot retention default is `10000` events per session.
- `kato status --json` includes process + snapshot memory telemetry needed by
  improved-status/web.
- Daemon emits clear operational logs for evictions and over-budget shutdown.
- Test suite covers config, store behavior, and runtime status exposure.

## Open Questions

1. Keep default at `200MB` or increase to `256MB`?
2. Sample process memory on heartbeat only, or on every ingestion poll?
