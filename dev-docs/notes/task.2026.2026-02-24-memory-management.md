---
id: hn7t9bp0x9wkhvtcgw4255u
title: 2026 02 24 Memory Management
desc: ''
updated: 1771971777228
created: 1771971777228
---

# Session Snapshot Memory Management

## Goal

Keep event-rich in-memory session snapshots as the primary runtime state (for
capture correctness and low-latency command handling), while adding explicit
memory controls and observability.

This task is the implementation follow-on for the status note item:
- performance data like memory use, maybe with OpenTelemetry
  ([task.2026.2026-02-23-improved-status](./task.2026.2026-02-23-improved-status.md))

## Why This Matters

- `maxEventsPerSession: 200` is too small for real sessions and causes
  `::capture` to miss earlier conversation content.
- Raising retention without memory controls risks unbounded growth.
- Operators need first-class visibility into memory pressure and evictions.

## Scope (This Task)

1. Increase default snapshot event retention substantially.
2. Add runtime-configurable memory budget for in-memory session snapshots.
3. Add idle-eviction config setting, wired as **no-op** for now.
4. Expose memory/perf snapshot stats in status and structured logs.
5. Define telemetry integration path (OpenTelemetry optional, not required).

## Non-Goals

- Persisting full normalized event history to disk.
- Replacing provider raw files as source data.
- Adding network exporters as a baseline requirement.

## Requirements

### 1) Retention Defaults

- Raise default `maxEventsPerSession` from `200` to `10000`.
- Keep `maxSessions` bounded (current default may remain initially).
- Ensure command behavior remains: capture should include history from the
  beginning of retained session state through the command event.

### 2) Memory Budget Setting

Add a runtime config setting for snapshot memory budget:
- `snapshotMaxMemoryMb` (required positive integer, defaults to a safe value)

Behavior:
- Track estimated bytes used by in-memory session snapshots.
- On upsert, if over budget, evict least-recently-updated sessions until
  within budget.
- Emit structured operational + audit records on each eviction with reason and
  bytes reclaimed.

### 3) Idle Eviction Setting (No-Op in This Task)

Add a runtime config setting:
- `snapshotSessionEvictionIdleMs` (nullable number)

Task requirement:
- fully wire it through contracts, config validation, defaults, and status
  projection,
- but do not enforce time-based eviction yet.

Status/logging should clearly indicate this setting is present but inactive.

### 4) Status + Performance Data

Extend status snapshot with memory management fields (or equivalent nested
object), including:
- estimated snapshot memory bytes
- configured memory budget bytes
- current in-memory session count
- total retained event count
- eviction counters (by reason)
- process memory (`rss`, `heapUsed`, `heapTotal`) where available

This aligns with improved-status work and should be reusable by CLI/web.

### 5) Telemetry Strategy

OpenTelemetry is optional and may be overkill for MVP.

For this task:
- required: local status + structured logs as source of truth
- optional (behind flag/adaptor): emit equivalent counters/gauges to OTel
  metrics API if integrated later
- document a bridge path for Sentry performance ingestion (without making
  Sentry a hard runtime dependency)

## Proposed Config Additions

Candidate `RuntimeConfig` fields:

- `snapshotMaxMemoryMb: number`
- `snapshotSessionEvictionIdleMs: number | null` (no-op in this task)

Optional follow-up (if we decide to externalize current retention values):
- `snapshotMaxEventsPerSession: number`
- `snapshotMaxSessions: number`

## Architecture Notes

- Keep `InMemorySessionSnapshotStore` as canonical runtime state.
- Add memory accounting inside snapshot store (or a wrapped manager), not in
  ad hoc runtime code.
- Eviction policy should be deterministic (LRU by last upsert/update time).
- Do not block ingestion when under memory pressure; prefer bounded eviction
  with explicit logs.

## Implementation Steps

1. Contracts/config
- Extend `shared/src/contracts/config.ts` with new settings.
- Extend runtime config parser/validation/defaulting.
- Add fixtures/tests for invalid and valid values.

2. Snapshot store
- Raise default event retention to `10000`.
- Add budget accounting + LRU eviction loop.
- Add instrumentation counters (`evictions`, `bytesReclaimed`, etc.).

3. Runtime + status
- Surface memory stats/counters in daemon status snapshot.
- Include memory management summary in `kato status --json`.

4. Observability
- Add structured operational/audit events for memory pressure and eviction.
- Document optional OTel/Sentry integration hook points.

5. Docs
- Update `dev.codebase-overview` snapshot/retention sections.
- Update `dev.testing` with memory-pressure test guidance.

## Testing Plan

- Unit tests: memory budget validation and deterministic eviction behavior.
- Store tests:
  - over-budget upsert evicts oldest sessions
  - retention still caps events per session
  - session metadata remains consistent after eviction
- Runtime tests:
  - status includes memory metrics/counters
  - eviction events are logged with expected reason/details
- Config tests:
  - `snapshotMaxMemoryMb` must be positive integer
  - `snapshotSessionEvictionIdleMs` accepts `null` or positive integer
  - idle setting is wired but does not trigger eviction in this task

## Acceptance Criteria

- Default per-session retained event window is `10000`.
- Memory budget setting is configurable and enforced via eviction.
- Idle eviction setting exists and is visible in status/config as no-op.
- `kato status --json` exposes memory/performance data needed for ops.
- Structured logs provide auditable eviction events.
- CI passes with tests/docs updated.

## Open Questions

1. What should default `snapshotMaxMemoryMb` be for MVP (e.g. 256 vs 512)?
2. Should single oversized sessions be truncated before cross-session eviction?
3. Should process memory fields be sampled on heartbeat only or every poll?
4. Do we add OTel in this task behind a feature flag, or defer entirely?
