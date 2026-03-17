---
id: n4t7j5dnfoqakej20vduxi1
title: 2026 03 17 Web Commands Phase2
desc: ''
updated: 1773767962348
created: 1773767623447
---

## Goal

As an operator, I would like deeper recording, workspace, maintenance, and
summary controls in the web client after the basic Session page command entry
lands.

## Summary

- For Recordings Page:
  - add per-recording stop/start controls
  - define whether this is driven by "intended recording state" and what restart
    means for a stopped output
- For Workspaces Page:
  - add an optional operator-facing workspace name distinct from alias
  - add alias rename workflow if we still want it
  - add ability to view and edit per-workspace settings
- For Maintenance Page:
  - if still desired, add controls for twin-generation policy or suppression,
    with clear warnings about any active recordings
- On Summary page:
  - add workspace name/alias where active-session and recording context is
    currently hard to read

## Discussion

- keep alias as the command selector unless we explicitly decide otherwise;
  treat "name" as a display label by default
- per-workspace settings scope needs to be enumerated before implementation
- maintenance controls may belong in settings/config rather than the current
  maintenance action model

## Open Issues

- What does "Start" mean for a stopped recording: resume the same destination,
  create a new one, or prompt?
- Which workspace settings are editable here: `defaultOutputDir`,
  `filenameTemplate`, `workspaceTimezone`, frontmatter flags, feature flags,
  username mapping, or only some of those?
- Does "stop twin generation" mean provider/workspace config, or per-session
  suppression?

## Decisions

## Contract Changes

- `workspace.name` if we introduce a distinct display label
- workspace mutation responses may need restart-required metadata
- recording mutation surface may need explicit intended-state fields

## Testing

- route/loader tests for recording lifecycle mutations
- mutation tests for alias rename and restart-required flows
- validation tests for workspace settings editing
- manual smoke check for summary context and warnings

## Non-Goals

- Basic Sessions page command entry

## Implementation Plan

- [ ] Define the phase-2 contracts for recording lifecycle, workspace
      metadata/settings, and maintenance controls
- [ ] Split concrete follow-up implementation tasks once the contracts are
      decided
