---
id: p7c4p0l8f7a2u6v1e5k9m3qd
title: 2026 03 18 Persist Recording Last Write
desc: ''
updated: 1773856602000
created: 1773856602000
---

## Goal

Persist per-recording-cycle `lastWriteAt` timestamps so the Recordings page can
sort and explain recency without depending on live daemon status.

## Summary

- add optional `lastWriteAt` to persisted recording-cycle metadata
- initialize cycle `lastWriteAt` when a cycle opens and refresh it whenever a
  write succeeds
- project persisted active recordings from per-cycle `lastWriteAt` instead of
  session-level `updatedAt` when available
- use persisted `lastWriteAt` in Recordings rows so recency survives daemon
  restarts and stale/live gaps

## Discussion

- today live daemon recording status carries `lastWriteAt`, but persisted
  workspace-output cycle history only stores start/stop metadata
- that mismatch makes Recordings recency dependent on whether a matching live
  daemon recording row is present
- keeping `lastWriteAt` on each cycle is cleaner than storing it only at the
  output-file level because a single file can be reused across multiple cycles
- the field should remain optional so older metadata stays valid

## Open Issues

- none currently

## Decisions

- persist `lastWriteAt` on `SessionWorkspaceRecordingCycleV1`
- keep the field optional for backward compatibility
- initialize `lastWriteAt` when a cycle opens to match current live recording
  semantics, then update it after successful writes
- keep Recordings recency as `lastWriteAt`, then `stoppedAt`, then `startedAt`
  fallback rather than reducing everything to a single synthetic timestamp

## Contract Changes

- add optional `recordingCycles[].lastWriteAt` to persisted session metadata
- active-recording projection should prefer persisted cycle `lastWriteAt` when
  reconstructing active recordings from metadata
- Recordings loader rows should carry persisted cycle `lastWriteAt` even when
  no live recording status is available

## Testing

- contract validation tests for optional `lastWriteAt`
- workspace-output helper tests for open/update/close cycle timestamps
- projection tests confirming persisted active recordings expose cycle
  `lastWriteAt`
- loader tests confirming Recordings rows sort by recency from persisted cycle
  timestamps
- `deno test --allow-read --allow-write=.test-tmp --allow-run --allow-env=KATO_LOGGING_OPERATIONAL_LEVEL,KATO_LOGGING_AUDIT_LEVEL,HOME,USERPROFILE,KATO_RUNTIME_DIR,KATO_DAEMON_STATUS_PATH,KATO_DAEMON_CONTROL_PATH,KATO_CLAUDE_SESSION_ROOTS,KATO_CODEX_SESSION_ROOTS,KATO_GEMINI_SESSION_ROOTS,KATO_DAEMON_MAX_MEMORY_MB,KATO_CONFIG_PATH,KATO_ALLOWED_WRITE_ROOT,KATO_ALLOWED_WRITE_ROOTS_JSON,KATO_WEB_PASSWORD tests/session-contracts_test.ts tests/session-state-store_test.ts tests/daemon-workspace-output-state_test.ts tests/daemon-status-projection_test.ts tests/web-activity-loader_test.ts tests/web-sessions-live_test.ts tests/web-session-actions_test.ts`
- `deno test --allow-read --allow-write=.test-tmp --allow-run --allow-env=KATO_LOGGING_OPERATIONAL_LEVEL,KATO_LOGGING_AUDIT_LEVEL,HOME,USERPROFILE,KATO_RUNTIME_DIR,KATO_DAEMON_STATUS_PATH,KATO_DAEMON_CONTROL_PATH,KATO_CLAUDE_SESSION_ROOTS,KATO_CODEX_SESSION_ROOTS,KATO_GEMINI_SESSION_ROOTS,KATO_DAEMON_MAX_MEMORY_MB,KATO_CONFIG_PATH,KATO_ALLOWED_WRITE_ROOT,KATO_ALLOWED_WRITE_ROOTS_JSON,KATO_WEB_PASSWORD --filter "runDaemonRuntimeLoop persistent in-chat keeps active destination appends when first-seen stale commands are skipped" tests/daemon-runtime_test.ts`
- `deno test --config apps/web/deno.json apps/web/tests/recordings_live_test.tsx`

## Non-Goals

- renaming Recordings-page timestamp labels in this task
- changing session-level recency sorting rules

## Implementation Plan

- [x] Extend the persisted recording-cycle contract with optional `lastWriteAt`
- [x] Add helper support for initializing and updating cycle `lastWriteAt`
- [x] Persist cycle `lastWriteAt` from daemon and web recording write paths
- [x] Consume persisted cycle `lastWriteAt` in active-recording projection and
      Recordings rows
- [x] Add focused regression tests for contracts, helpers, projection, and
      loader ordering
