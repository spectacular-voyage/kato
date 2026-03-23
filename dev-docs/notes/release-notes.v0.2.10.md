---
id: tebh5kc9ddkxyndldmeu3x4c
title: 'Release Notes v0.2.10'
desc: >-
  Liveness/auth-expiry polish, remembered Sessions workspace defaults, and
  clearer split root test summaries.
updated: 1774244150424
created: 1774244150424
---

`v0.2.10` is a focused polish release: it tightens how Kato reports
daemon/web liveness, makes expired web auth fail closed instead of leaving
stale live data on screen, smooths out repeated Sessions-page create actions,
and makes the split root test flow easier to read and debug.

Primary changes:

- changed daemon/web liveness reporting so stale daemon heartbeat now renders
  as `unresponsive` instead of still looking `running`, and `kato web status`
  now reports a definitively dead web process as `stopped` while keeping the
  last heartbeat only as diagnostic detail
- updated the compact web header to match that liveness wording and removed the
  separate `HEARTBEAT` row now that heartbeat freshness is folded into daemon
  state
- changed web auth-expiry handling so live/API polling treats `401` as an
  expired session, redirects the current tab to `/login`, and propagates that
  expiry across sibling tabs via `BroadcastChannel` with `localStorage`
  fallback
- kept page-route auth behavior distinct from API behavior: page requests still
  redirect to `/login`, while API/live routes now fail with `401` instead of
  quietly continuing with stale rendered data
- made the Sessions-page `New capture` and `New recording` popovers remember
  the last submitted workspace in browser storage and reuse it as the default
  next time, unless the current page filter already pins a workspace
- kept the remembered Sessions workspace behavior conservative by ignoring
  blank/stale stored ids and only updating the remembered default on actual
  create submission, not on canceled popover browsing
- improved the split root test workflow so `deno task test` and
  `deno task test:coverage` now run through `scripts/run-root-test-slices.ts`
  with structured per-slice summaries plus a combined summary, while keeping
  explicit `test:parallel-safe` and `test:env` entrypoints available

Upgrade notes:

- if you were scraping human-readable CLI status text, update for the wording
  change: stale daemon heartbeat is now `unresponsive`, and `kato web status`
  now says `stopped` with optional `last heartbeat` diagnostics instead of
  `stale status`; for automation, prefer JSON output over text parsing
- expired web auth is now intentionally fail-closed across tabs; once one tab
  detects expiry, sibling tabs should converge on `/login` instead of keeping
  stale live views open
- Sessions create popovers now default to the last successfully used workspace
  for that browser unless a page-level workspace filter is active
