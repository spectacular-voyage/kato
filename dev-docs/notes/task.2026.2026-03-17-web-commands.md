---
id: x7ta7m4ble1z6785j71c73f
title: 2026 03 17 Web Commands
desc: ""
updated: 1773777010765
created: 1773763652587
---

## Goal

As a user, I would like to trigger the core workspace-scoped recording controls
from the web client.

## Summary

- From the Sessions page:
  - I would like to be able to trigger "New capture" and "New recording"
    - clicking either action button opens a small workspace-chooser popover
    - the chooser copy explains the difference: "from start" vs
      "moving forward"
    - `New capture` creates a fresh recording file from the full session history and
      keeps that file engaged for future writes
    - `New recording` creates a fresh recording file immediately, including
      frontmatter when enabled, and starts appending conversation content on
      the next event
  - list any engaged recordings for the session in small font, one per line, in
    the form `<workspace alias>: <filename>`
    - workspace alias links to the workspace page
    - filename links to the corresponding recording on the Recordings page
    - each engaged recording includes an inline `[stop]` control
    - the recordings heading includes a `[stop all]` control for the session

## Discussion

- keep this phase focused on Session page command entry, not deeper
  recording/workspace lifecycle management
- in code terms, the persisted field is `desiredState`, while the web activity
  rows currently use `engaged-active` / `engaged-stale` for recordings that are
  still on
- for UI copy, prefer plain-language labels over internal state names:
  `recording`, `ready to record`, and `stopped`

## Open Issues

- none for phase 1

## Decisions

- Leave `Export` out of phase 1
- Leave explicit path entry out of phase 1
- The Sessions page actions are `New capture` and `New recording`
- Both Sessions page actions create a fresh destination path rather than
  reusing the previously engaged workspace output
- `New recording` touches its fresh destination immediately so the new file is
  visible before the next conversation event arrives
- Existing engaged recordings are listed on the Sessions page, but not directly
  controlled there except for stop controls
- Stop controls on the Sessions page only apply to engaged recordings
- Keep internal state naming as-is, but map UI labels as:
  `engaged-active` -> `recording`
  `engaged-stale` -> `ready to record`
  `stopped` -> `stopped`
- Recording deep links use `recordingCycleId` when present, with a stable
  hashed row-key fallback for synthesized rows

## Contract Changes

- likely new web mutation surface for Session page `New capture` / `New
  recording` controls
- new web mutation surface for Session page `stop-recording` / `stop-all-recordings`
  controls
- Sessions page data/rendering will need engaged recording summary rows with
  workspace and recording links
- Sessions page engaged recording rows include inline stop controls and a
  stop-all heading control
- UI copy for recording state should use the operator-facing labels above,
  rather than exposing `engaged-*` terminology directly
- The Recordings page uses stable anchors so filename links can target a
  specific recording row

## Testing

- route/loader tests for `New capture` / `New recording` mutations and the
  resulting engaged recording list state
- mutation tests for per-recording stop and stop-all behavior on engaged
  recordings
- rendering tests should confirm the UI labels `recording`, `ready to record`,
  and `stopped` instead of internal `engaged-*` terms
- manual smoke check for selector, workspace link, and recording link flows

## Non-Goals

- `Export` and explicit path entry in phase 1
- Recording-row lifecycle controls on the Recordings page
- Resume/start controls or other direct manipulation of stopped recordings on
  the Sessions page
- Workspace display names, alias editing, and per-workspace settings editing
- Maintenance-page twin-generation controls
- Summary-page workspace labeling polish
- These move to `task.2026.2026-03-17-web-commands-phase2`

## Implementation Plan

- [x] Define the mutation surface for Session page `New capture` / `New
      recording` controls
- [x] Define how engaged recordings are rendered and linked from the Sessions
      page
- [x] Implement the UI and route wiring
- [x] Add per-recording stop and session-level stop-all controls on the
      Sessions page
- [x] Add tests for the new mutation, linking, and loader behavior
- [x] Do a manual browser smoke pass for selector and deep-link flows
