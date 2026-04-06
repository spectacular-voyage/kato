---
id: i8w2t0g1iinhml0ibdb0boa
title: 2026 02 22 Ingestion and Export
desc: ''
updated: 1771828154014
created: 1771813219323
---

## Goal

Implement provider ingestion plus export end-to-end so
`kato export <session-id>` writes real session content with correct provider
identity.

## Current State

- Provider parsers exist (`claude`, `codex`), but runtime ingestion/session
  state is not fully wired.
- Runtime export path supports loader hooks (`loadSessionSnapshot` and fallback
  `loadSessionMessages`).
- `status.providers` is currently not populated from live provider/session
  state.

## Scope

- In scope:
  - local provider ingestion loop
  - in-memory session snapshot state for export/status
  - export path wired to real session snapshots
  - provider identity propagation into export/audit
  - tests and smoke-runbook updates
- Out of scope:
  - cloud/remote ingestion
  - service-manager integration
  - major parser redesign

## Implementation Plan

### Phase 1: Ingestion Runtime Contract

- [x] Define ingestion runtime interfaces in `apps/daemon/src/orchestrator`:
  - `SessionSnapshotStore` (upsert/list/get by session id)
  - `ProviderIngestionRunner` (start/stop/poll contract)
- [x] Define normalized runtime snapshot shape:
  - provider
  - sessionId
  - latest cursor/offset
  - message list or bounded message window
  - metadata for status aggregation
- [x] Decide retention policy for in-memory snapshots (MVP-safe cap + eviction
      rule).

### Phase 2: Provider Ingestion Loop Wiring

- [x] Implement watcher/poller orchestration using existing debounce utility.
- [x] Wire Claude and Codex parser outputs into session snapshot store.
- [x] Track provider cursors per provider/session and resume from last processed
      position.
- [x] Add operational/audit logs for ingestion start, parse errors, cursor
      updates, and dropped events.

### Phase 3: Export Integration

- [x] Use session snapshot store to implement `loadSessionSnapshot(sessionId)`
      in daemon runtime.
- [x] Make export runtime prefer `loadSessionSnapshot` as canonical path.
- [x] Ensure `provider` passed to recording/export pipeline is real provider
      (not `"unknown"`).
- [x] Keep fallback behavior explicit when a session is missing:
  - log structured warning
  - return clear command/runtime feedback
  - do not write partial/empty export silently.

### Phase 4: Status Integration

- [x] Populate `status.providers` from live session snapshot store:
  - provider name
  - active session count
  - last message timestamp (if available)
- [x] Add stale handling and reset semantics for provider status values.

### Phase 5: Test And Verification

- [x] Unit tests:
  - [x] ingestion store upsert/get/list semantics
  - [x] cursor resume and duplicate-suppression behavior
  - [x] provider-aware export resolution
- [x] Runtime tests:
  - [x] queued export request writes expected output from session snapshot
  - [x] status shows non-zero provider counts after ingestion events
  - [x] missing session export fails clearly and safely
- [x] Update `dev.testing.md` smoke runbook with provider-ingestion + real
      export scenario.

### Phase 6: Documentation Updates

- [x] update all documentation, especially:
  - [x] [[dev.general-guidance]]
  - [x] [[dev.codebase-overview]]
  - [x] [[dev.decision-log]]
  - [x] [[dev.todo]]

## Acceptance Criteria

- `kato export <session-id>` exports real content for ingested sessions.
- Export audit/operational events include real provider identity for ingested
  sessions.
- `kato status` provider counts reflect ingested provider/session activity.
- `deno task test` and `deno task ci` pass with new coverage.

## Known MVP Limitations

- Provider cursors are in-memory only in MVP. After daemon restart, ingestion
  resumes from offset `0` and reparses session files before dedupe suppresses
  already-seen messages.

## Risks And Mitigations

- Risk: unbounded memory growth from session snapshots.
  - Mitigation: fixed caps per session and total session count with
    deterministic eviction.
- Risk: duplicated exports from ingestion replay.
  - Mitigation: cursor persistence semantics and parser dedupe guard tests.
- Risk: parser edge-case regressions.
  - Mitigation: preserve existing fixture tests and add ingestion-layer
    regression fixtures.
