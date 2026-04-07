---
id: x4p8m2n6q7r1s5t9u3v0w8yz
title: 2026 03 18 Preserve Web Recording Mutations
desc: ''
updated: 1773865200000
created: 1773865200000
---

## Goal

Prevent daemon runtime saves from wiping out freshly persisted web recording
mutations for the same session.

## Summary

- preserve newer disk-written `workspaceOutputs` when the daemon is about to
  save an older in-memory session metadata copy
- keep daemon-owned cursor/twin fields advancing without regressing recent web
  capture/recording state
- add a regression test that simulates a web capture landing between daemon
  metadata refresh and daemon save

## Discussion

- the Sessions-page symptom matches a race where the web action saves a new
  capture, then the daemon loop later saves an older copy of the same session
  metadata after updating command cursors or write cursors
- the bug is especially visible for active sessions because they are the most
  likely to be touched by both the web mutation path and the daemon loop in the
  same interval
- the fix should stay narrow and defensive; this is not a full cross-process
  locking redesign

## Open Issues

- none currently

## Decisions

- treat a newer on-disk `updatedAt` as evidence that an external writer
  changed the session metadata after the daemon loaded its copy
- preserve the newer disk `workspaceOutputs` in that case, while still keeping
  daemon-updated cursor/twin fields
- allow daemon-only outputs absent from the newer disk copy to be appended
  during merge rather than discarded

## Contract Changes

- no wire-contract changes
- daemon save behavior becomes merge-aware for concurrent web mutations on the
  same session metadata file

## Testing

- add a daemon runtime regression test where `listSessionMetadata()` returns an
  older copy first and a newer web-mutated copy before save
- run focused daemon runtime tests plus the web recording/session action tests

## Non-Goals

- introducing filesystem locks between daemon and web
- redesigning the whole metadata persistence model
- implementing the larger async capture hydration flow yet

## Implementation Plan

- [x] Add a regression task covering daemon overwrite of newer web recording
      metadata
- [x] Merge newer on-disk session metadata before daemon save when appropriate
- [x] Run focused daemon and web tests and record the results

Focused verification:

- `deno test --allow-read --allow-write=.test-tmp --allow-run --allow-env=KATO_LOGGING_OPERATIONAL_LEVEL,KATO_LOGGING_AUDIT_LEVEL,HOME,USERPROFILE,KATO_RUNTIME_DIR,KATO_DAEMON_STATUS_PATH,KATO_DAEMON_CONTROL_PATH,KATO_CLAUDE_SESSION_ROOTS,KATO_CODEX_SESSION_ROOTS,KATO_GEMINI_SESSION_ROOTS,KATO_DAEMON_MAX_MEMORY_MB,KATO_CONFIG_PATH,KATO_ALLOWED_WRITE_ROOT,KATO_ALLOWED_WRITE_ROOTS_JSON,KATO_WEB_PASSWORD --filter "runDaemonRuntimeLoop preserves newer web-written workspace outputs when saving stale session metadata" tests/daemon-runtime_test.ts`
- `deno test --allow-read --allow-write=.test-tmp --allow-run --allow-env=KATO_LOGGING_OPERATIONAL_LEVEL,KATO_LOGGING_AUDIT_LEVEL,HOME,USERPROFILE,KATO_RUNTIME_DIR,KATO_DAEMON_STATUS_PATH,KATO_DAEMON_CONTROL_PATH,KATO_CLAUDE_SESSION_ROOTS,KATO_CODEX_SESSION_ROOTS,KATO_GEMINI_SESSION_ROOTS,KATO_DAEMON_MAX_MEMORY_MB,KATO_CONFIG_PATH,KATO_ALLOWED_WRITE_ROOT,KATO_ALLOWED_WRITE_ROOTS_JSON,KATO_WEB_PASSWORD tests/web-activity-loader_test.ts tests/web-session-actions_test.ts tests/web-live-routes_test.ts`
