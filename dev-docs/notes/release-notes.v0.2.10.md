---
id: tebh5kc9ddkxyndldmeu3x4c
title: 'Release Notes v0.2.10'
desc: >-
  Liveness/auth-expiry polish, remembered Sessions workspace defaults, and clearer split root test summaries.
updated: 1774296274927
created: 1774244150424
---

## Summary

`v0.2.10` is a focused polish release for operator feedback loops and routine web workflows. It makes daemon/web liveness state more explicit, treats expired web auth as a fail-closed condition across tabs, remembers the last used workspace in Sessions create flows, and makes split root test results easier to read.

## User-facing Changes

- stale daemon heartbeat now renders as `unresponsive` instead of continuing to look `running`, and `kato web status` reports a definitively dead web process as `stopped` while keeping the last heartbeat only as diagnostic detail
- the compact web header now uses that same liveness wording and no longer shows a separate `HEARTBEAT` row because heartbeat freshness is folded into daemon state
- live/API polling now treats `401` as an expired session, redirects the current tab to `/login`, and propagates that expiry across sibling tabs via `BroadcastChannel` with `localStorage` fallback
- Sessions-page `New capture` and `New recording` popovers now remember the last submitted workspace in browser storage and reuse it as the default next time unless the current page filter already pins a workspace
- remembered Sessions workspace defaults stay conservative: blank or stale stored ids are ignored, and the remembered value only updates after an actual create submission, not canceled popover browsing

### Upgrade notes

- if you were scraping human-readable CLI status text, update for the wording change: stale daemon heartbeat is now `unresponsive`, and `kato web status` now says `stopped` with optional `last heartbeat` diagnostics instead of `stale status`; for automation, prefer JSON output over text parsing
- expired web auth is now intentionally fail-closed across tabs; once one tab detects expiry, sibling tabs should converge on `/login` instead of keeping stale live views open
- Sessions create popovers now default to the last successfully used workspace for that browser unless a page-level workspace filter is active

## Developer-oriented Changes

- page-route auth behavior remains intentionally distinct from API behavior: page requests still redirect to `/login`, while API/live routes now fail with `401` instead of quietly continuing with stale rendered data
- `deno task test` and `deno task test:coverage` now run through `scripts/run-root-test-slices.ts` with structured per-slice summaries plus a combined summary, while keeping explicit `test:parallel-safe` and `test:env` entrypoints available
