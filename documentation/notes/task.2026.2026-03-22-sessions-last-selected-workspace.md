---
id: 7m9q2vk4p3w8x1n6r5t0ybz
title: 2026 03 22 Sessions Last Selected Workspace
desc: ''
updated: 1774242282542
created: 1774242282542
---

## Goal

On the Sessions page, `New capture` and `New recording` should remember the
last workspace used and preselect it the next time the popover opens.

## Summary

- keep the existing workspace option ordering unchanged
- treat this as a browser-side operator preference, not a new server or
  runtime setting
- let an explicit `/sessions?workspace=...` filter win over any remembered
  preference

## Discussion

- The current popover already owns a single shared `selectedWorkspace` state,
  so this should stay a small Sessions-island change rather than a loader or
  action redesign.
- Persist the remembered value as `workspaceId`, not alias or display name, so
  label edits do not break the preference.
- I do not want to persist every transient dropdown change. If an operator
  opens the popover, experiments with a different workspace, and cancels, the
  default should not silently drift. Remember the workspace when the operator
  actually starts `New capture` or `New recording`, not on mere browsing.
- If the remembered `workspaceId` is no longer present in the current
  workspace options, fall back cleanly to the existing default selection
  logic.
- This roadmap item already exists in [[roadmap]] and fits as a small follow-up
  to [[ka.completed.2026.2026-03-17-web-commands-phase2]].

## Open Issues

- none currently; if we later want cross-device or shared-user persistence,
  that should be treated as a separate feature rather than quietly expanding
  this browser-local preference

## Decisions

- Keep workspace ordering unchanged.
- Remember the last submitted create-action workspace, not every canceled
  dropdown change.
- Share one remembered default across both `New capture` and `New recording`.
- Store the preference client-side in browser `localStorage`.
- Persist `workspaceId`, not alias or display name.
- Keep selection precedence as: explicit page workspace filter, then
  remembered workspace when it still exists in the current options, then the
  existing first-option fallback.

## Contract Changes

- no server-side or runtime contract change
- keep the existing `workspaceSelector` POST field and workspace-option order
  unchanged
- add a browser-only persisted preference key for the Sessions create-popover
  workspace default

## Testing

- add unit coverage for default-selection resolution and invalid remembered-id
  fallback
- add focused coverage for browser-storage read/write helpers if that logic is
  extracted
- manually verify popover reopen, full reload, explicit workspace-filter
  pages, and removed-workspace fallback

## Non-Goals

- reordering or promoting the remembered workspace in the dropdown
- introducing a server-backed user preference for this selection
- changing record/capture mutation semantics or workspace-resolution rules on
  the backend

## Implementation Plan

- [x] Add or extract a pure helper for Sessions workspace default resolution.
- [x] Add failure-tolerant browser storage helpers for the remembered
      `workspaceId`.
- [x] Rehydrate the popover selection from explicit filter, remembered
      workspace, and existing fallback logic without changing option order.
- [x] Persist the selected workspace when `New capture` and `New recording`
      are submitted.
- [x] Add regression tests for precedence and stale remembered-value fallback.
- [ ] Manually verify reload, reopen, filtered-page, and removed-workspace
      behavior.
