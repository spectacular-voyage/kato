---
id: 7q7q0w0yz3u4t7q8j5msy6rp
title: 2026 03 18 Recordings Row Polish
desc: ''
updated: 1773856602000
created: 1773856602000
---

## Goal

Make Recordings rows easier to scan by separating file/session/workspace
details onto distinct lines and tightening the idle-state copy.

## Summary

- move the Recordings row metadata into four left-column lines:
  `File`, timestamps, `Workspace`, and `Session`
- reduce filename emphasis so long paths do not compete with state/actions
- make both the session title and short id link back to the Sessions page
- replace the idle row wording with `armed for recording` and use `disarm`
  for the idle stop action label
- label stopped-row re-engagement as `re-arm` instead of `re-start`
- sort Recordings rows by recency instead of grouping by state first

## Discussion

- the previous top-line layout mixed workspace alias and filename into one
  wrapping line, which squeezed the right-side state column and caused status
  copy to wrap awkwardly
- splitting metadata across labeled lines should make long filenames less
  disruptive without hiding any information
- `armed for recording` reads more naturally in-row than `armed for recordings`
  while still signaling that the row is engaged but not actively writing
- pure recency ordering should feel more honest than pinning active/stale/stopped
  buckets ahead of newer rows

## Open Issues

- none currently

## Decisions

- keep the page scoped to per-file rows and only polish the row presentation
- use `armed for recording` for the engaged-idle state on the Recordings page
- use `disarm` only for engaged-idle rows; actively writing rows keep `stop`
- use `re-arm` for stopped-row re-engagement copy while keeping the underlying
  restart action name unchanged
- sort Recordings rows by recency using `lastWriteAt`, then `stoppedAt`, then
  `startedAt` as fallback

## Contract Changes

- no backend contract changes
- Recordings-page rendering now presents file/timestamp/workspace/session on
  separate labeled lines
- ready-state Recordings rows now label the idle engaged state as
  `armed for recording`
- stopped-row Recordings controls now say `re-arm`
- Recordings rows now sort by recency instead of activity-state buckets

## Testing

- add a rendering test for the Recordings island covering the new line labels,
  session links, and idle `disarm` copy
- run focused web tests covering Recordings rendering and existing
  session-recording view-model helpers
- `deno test tests/web-sessions-live_test.ts`
- `deno test tests/web-activity-loader_test.ts`
- `deno test --config apps/web/deno.json apps/web/tests/recordings_live_test.tsx`

## Non-Goals

- changing Sessions-page or Workspaces-page recording copy
- changing the underlying stop/restart action names sent to the backend

## Implementation Plan

- [x] Restructure the Recordings row markup into labeled lines and link the
      session title
- [x] Update Recordings-page copy/CSS for the smaller file line and idle
      `disarm` state
- [x] Sort Recordings rows by recency rather than state grouping
- [x] Add focused rendering coverage and run the relevant tests
