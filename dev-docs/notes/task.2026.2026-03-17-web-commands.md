---
id: x7ta7m4ble1z6785j71c73f
title: 2026 03 17 Web Commands
desc: ''
updated: 1773767962348
created: 1773763652587
---

## Goal

As a user, I would like to trigger the core workspace-scoped recording controls
from the web client.

## Summary

- From the Sessions page:
  - I would like to be able to "Start Capture" and "Start Recording"
    - if we go with link-buttons, a mouseover pops up a tooltip explaining the
      difference: "from start" vs "moving forward"
    - we'll need to be able to select a workspace, so maybe clicking on the
      Start* buttons pops up a selector menu
  - add a stop link button, greyed out if no recordings are happening, but with
    the same selection mechanism as start, plus an optional "All"
    - probably if only one recording, no pop-up necessary; just stop it


## Discussion

- keep this phase focused on Session page command entry, not deeper
  recording/workspace lifecycle management
- export support and explicit path entry might still fit here, but only if we
  decide they are required for phase-1 parity

## Open Issues

- Do we need `Export` in phase 1, or can that wait for a follow-up?
- Are pathless workspace-default actions enough for phase 1, or do we need
  explicit path entry?

## Decisions

## Contract Changes

- likely new web mutation surface for Session page recording controls

## Testing

- route/loader tests for session command mutations and resulting live page state
- manual smoke check for selector and button flows

## Non-Goals

- Recording-row lifecycle controls on the Recordings page
- Workspace display names, alias editing, and per-workspace settings editing
- Maintenance-page twin-generation controls
- Summary-page workspace labeling polish
- These move to `task.2026.2026-03-17-web-commands-phase2`

## Implementation Plan

- [ ] Finalize phase-1 scope: start capture/record/stop and whether export/path
      entry are in
- [ ] Define the mutation surface for Session page controls
- [ ] Implement the UI and route wiring
- [ ] Add tests plus a manual smoke pass
