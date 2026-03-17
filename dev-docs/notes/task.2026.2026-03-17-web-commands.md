---
id: x7ta7m4ble1z6785j71c73f
title: 2026 03 17 Web Commands
desc: ''
updated: 1773770713331
created: 1773763652587
---

## Goal

As a user, I would like to trigger the core workspace-scoped recording controls
from the web client.

## Summary

- From the Sessions page:
  - I would like to be able to trigger "New capture" and "New recording"
    - if we go with link-buttons, a mouseover pops up a tooltip explaining the
      difference: "from start" vs "moving forward"
    - we'll need to be able to select a workspace, so maybe clicking on the
      action buttons pops up a selector menu
  - list any engaged recordings for the session in small font, one per line, in
    the form `<workspace alias>: <filename>`
    - workspace alias links to the workspace page
    - filename links to the corresponding recording on the Recordings page
  - existing recordings are read-only from the Sessions page in this phase


## Discussion

- keep this phase focused on Session page command entry, not deeper
  recording/workspace lifecycle management
- in code terms, the persisted field is `desiredState`, while the web activity
  rows currently use `engaged-active` / `engaged-stale` for recordings that are
  still on
- for UI copy, prefer plain-language labels over internal state names:
  `recording`, `ready to record`, and `stopped`

## Open Issues

- Do we need stable recording-row anchors or a different URL shape so the
  Sessions page can link to a specific recording on the Recordings page?

## Decisions

- Leave `Export` out of phase 1
- Leave explicit path entry out of phase 1
- The Sessions page actions are `New capture` and `New recording`
- Existing engaged recordings are listed on the Sessions page, but not directly
  controlled there
- Keep internal state naming as-is, but map UI labels as:
  `engaged-active` -> `recording`
  `engaged-stale` -> `ready to record`
  `stopped` -> `stopped`

## Contract Changes

- likely new web mutation surface for Session page `New capture` / `New
  recording` controls
- Sessions page data/rendering will need engaged recording summary rows with
  workspace and recording links
- UI copy for recording state should use the operator-facing labels above,
  rather than exposing `engaged-*` terminology directly
- The Recordings page may need stable anchors or other deep-link support if we
  want filename links to target a specific recording row

## Testing

- route/loader tests for `New capture` / `New recording` mutations and the
  resulting engaged recording list state
- rendering tests should confirm the UI labels `recording`, `ready to record`,
  and `stopped` instead of internal `engaged-*` terms
- manual smoke check for selector, workspace link, and recording link flows

## Non-Goals

- Stop controls or other direct manipulation of existing recordings on the
  Sessions page
- `Export` and explicit path entry in phase 1
- Recording-row lifecycle controls on the Recordings page
- Workspace display names, alias editing, and per-workspace settings editing
- Maintenance-page twin-generation controls
- Summary-page workspace labeling polish
- These move to `task.2026.2026-03-17-web-commands-phase2`

## Implementation Plan

- [ ] Define the mutation surface for Session page `New capture` / `New
      recording` controls
- [ ] Define how engaged recordings are rendered and linked from the Sessions
      page
- [ ] Implement the UI and route wiring
- [ ] Add tests plus a manual smoke pass
