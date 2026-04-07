---
id: lcj7e4ach0pbi9u5aqyak0a
title: 2026 03 17 Web Commands Phase3
desc: ''
updated: 1773788600855
created: 1773788600855
---

## Goal

As an operator, I would like follow-up web command controls that were deferred
from [[task.2026.2026-03-17-web-commands-phase2]] because they change selector
behavior, session-control policy, or the command-entry model.

## Summary

- revisit alias rename only if unregister/re-register proves too clumsy
- revisit workspace-file settings editing beyond `displayName` and preferred
  username
- design manual per-session twin suppression / re-enable controls if we still
  want them
- revisit any future Recordings-page actions that would create a fresh
  destination rather than `Re-start` the same path
- revisit any runtime/config editing surfaces that do not fit cleanly into the
  phase-2 workspace settings model

## Discussion

- alias rename changes command/filter selectors and may need restart messaging,
  so it is intentionally separated from `displayName`
- deeper workspace-file settings editing touches workspace config validation and
  should stay separate from the lighter phase-2 registry/user-config slice
- manual twin suppression is session control state, not generic Maintenance
  cleanup, and should be designed as such if it comes back
- fresh-start actions on the Recordings page would overlap with the Sessions
  page and should only land if we explicitly want two entry points for that
  action model

## Open Issues

- Is alias rename worth a first-class workflow, or is unregister/re-register
  sufficient in practice?
- Which workspace-file settings should eventually be editable from the web:
  `defaultOutputDir`, `filenameTemplate`, `workspaceTimezone`,
  `markdownFrontmatter`, `workspaceFeatureFlags`, or only a subset?
- If per-session twin suppression exists, where is it stored and how does it
  interact with provider/global auto-generation?
- Do we ever want the Recordings page to create a new destination, or should
  Sessions remain the sole entry point for fresh record/capture actions?
- Should broader Summary/session/recording surfaces adopt workspace labels
  beyond the phase-2 workspace card?

## Decisions

- [[task.2026.2026-03-17-web-commands-phase2]] owns `displayName`,
  per-workspace settings, and Recordings-page same-path `Re-start`.
- Phase 3 owns deferred alias/twin-policy/new-destination work.
- Phase 2 only covers `displayName`, preferred username, and workspace-card
  label polish; broader workspace-file editing and broader label rollout are
  phase-3 questions.

## Contract Changes

- session-level twin-suppression metadata if we later add it
- alias-rename mutation surface and restart messaging if we later add it
- workspace-config mutation surface for deferred workspace-file settings if we
  later add it
- any future Recordings-page fresh-start surface if we later add it
- broader workspace-label fields on Summary/session/recording surfaces if we
  later add them

## Testing

- mutation tests for alias rename and restart warnings if implemented
- validation tests for any deferred workspace-file settings editing if
  implemented
- state-machine tests for session-level twin suppression if implemented
- route/UX tests for any future Recordings-page fresh-start controls
- rendering tests for any broader workspace-label rollout if implemented

## Non-Goals

- re-specifying or diluting the phase-2 decisions in
  [[task.2026.2026-03-17-web-commands-phase2]]

## Implementation Plan

- [ ] Re-evaluate whether alias rename is worth dedicated UI beyond
      unregister/re-register
- [ ] Decide which workspace-file settings, if any, should get a web editing
      surface after phase 2
- [ ] Design per-session twin suppression if it is still desired after phase 2
- [ ] Design any post-phase-2 recording actions that create a fresh
      destination
