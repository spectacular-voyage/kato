---
id: qh0x9b9p1j3k6m4r8c2v7n5t
title: 2026 03 18 Capture Active State And Latency
desc: ''
updated: 1773863400000
created: 1773863400000
---

## Goal

Make Sessions-page `New Capture` show up immediately as an actively writing
recording on the Recordings page, and trim avoidable latency from the synchronous
capture action.

## Summary

- classify engaged recording rows from recording-write recency rather than
  session staleness alone
- keep stale engaged rows for old idle outputs, but treat freshly written
  captures as `recording`
- remove redundant capture preflight work and parallelize independent config
  reads in the web capture action

## Discussion

- the current loader assumes an engaged row is stale whenever the session lacks
  a fresh live daemon status row, which is too pessimistic for a capture that
  was just created via the web action and has already written bytes
- `new-capture` also performs work on the hot path that does not need to be
  serialized, plus an existence pre-check before a writer call that already
  enforces create-new semantics
- this should stay a bounded fix; it is not a redesign of async capture
  workflows or daemon/web mutation coordination

## Open Issues

- none currently

## Decisions

- engaged recording row state should prefer `lastWriteAt` recency over session
  stale/fresh status
- when recording recency cannot be derived, fall back to the existing
  session-staleness behavior rather than inventing a new state
- capture creation remains synchronous for now; optimize the current path
  instead of backgrounding it

## Contract Changes

- no wire-contract changes
- Sessions/Recordings/Workspaces page engaged-row state becomes a
  recording-recency classification instead of a pure session-staleness proxy

## Testing

- add loader coverage for a recent persisted active output without a live row
- keep stale persisted active-output coverage to prove old idle rows still show
  as `armed for recording`
- run focused web action and activity-loader tests

## Non-Goals

- redesigning capture to be asynchronous
- changing capture output format or file naming
- changing daemon status stale semantics for sessions themselves

## Implementation Plan

- [x] Add regression coverage for recent persisted active captures with no live
      session status
- [x] Derive engaged recording row state from recording recency in the loader
- [x] Remove redundant capture preflight work and parallelize independent setup
      in the Sessions-page capture action
- [x] Run the focused test suite and record the results

Focused verification:

- `deno test --allow-read --allow-write=.test-tmp --allow-run --allow-env=KATO_LOGGING_OPERATIONAL_LEVEL,KATO_LOGGING_AUDIT_LEVEL,HOME,USERPROFILE,KATO_RUNTIME_DIR,KATO_DAEMON_STATUS_PATH,KATO_DAEMON_CONTROL_PATH,KATO_CLAUDE_SESSION_ROOTS,KATO_CODEX_SESSION_ROOTS,KATO_GEMINI_SESSION_ROOTS,KATO_DAEMON_MAX_MEMORY_MB,KATO_CONFIG_PATH,KATO_ALLOWED_WRITE_ROOT,KATO_ALLOWED_WRITE_ROOTS_JSON,KATO_WEB_PASSWORD tests/web-activity-loader_test.ts tests/web-session-actions_test.ts tests/web-live-routes_test.ts`
- `deno test --config apps/web/deno.json apps/web/tests/recordings_live_test.tsx`
