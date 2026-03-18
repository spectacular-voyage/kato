---
id: n4t7j5dnfoqakej20vduxi1
title: 2026 03 17 Web Commands Phase2
desc: ''
updated: 1773767962348
created: 1773767623447
---

## Goal

As an operator, I would like bounded recording, workspace, and summary
controls in the web client after the basic Session page command entry lands.

## Summary

- For Recordings Page:
  - show the latest recording state per output file rather than every recorded
    cycle
  - add per-output stop controls for engaged rows
  - add per-output `Re-start` controls for stopped rows
  - `Re-start` means reuse the same output path; creating a fresh recording or
    capture remains Sessions-page only
- For Workspaces Page:
  - add an optional operator-facing `displayName` distinct from alias
  - allow `displayName` to be set during initial workspace registration from
    both CLI and web registration entry points
  - add ability to view and edit per-workspace settings
  - include preferred username in that per-workspace settings surface even
    though it persists in the user config file
- On Sessions page:
  - show workspace selectors for `New capture` / `New recording` as
    `<alias> (<displayName>)` when a display name is present, with the display
    name truncated as needed
- On Summary page:
  - add display name/alias only on the workspace card

## Discussion

- keep alias as the command selector and filter selector; `displayName` is
  operator-facing only
- store `displayName` in registered workspace metadata rather than workspace
  config so it does not affect command resolution or runtime profile validation
- phase-2 per-workspace settings are intentionally narrow: `displayName` in
  registry metadata plus preferred username in user config
- defer all workspace-file settings beyond that narrow slice to
  [[task.2026.2026-03-17-web-commands-phase3]]
- new recordings/captures stay on Sessions; the Recordings page only stops an
  engaged row or `Re-start`s a stopped row on the same path
- the Recordings page is a per-output-file surface, not a cycle-history view;
  old cycles stay in persisted metadata but do not each get their own row
- only one active recording may target a given file at a time; starting or
  `Re-start`ing a recording first stops any currently engaged writer already
  using that path
- capture remains fresh-destination-only behavior; it should not append to or
  overwrite an existing file
- when a workspace UI label shows both selector and operator-facing label, use
  `<alias> (<displayName>)`; if there is no meaningful display name, show alias
  alone

### Recording Lifecycle Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| Stop engaged recording from Sessions or Recordings | Yes | No | No | Only rows backed by persisted workspace-output metadata are actionable |
| `Re-start` stopped recording from Recordings | Yes | No | No | Reuses the same path, opens a new cycle on the same workspace output, and fails fast if the file is missing or policy-denied |
| Start or `Re-start` recording onto a file already being recorded elsewhere | Yes | No | No | Stop the previously engaged writer first so only one active recording owns a file |
| Start a fresh recording or capture | Yes | Yes | Yes | Remains Sessions-page only; Recordings does not create new destinations |
| Recording row missing workspace metadata or `recordingCycleId` | No | Yes | No | Render as read-only; do not offer stop or `Re-start` |

## Open Issues

- none currently; deeper workspace-file settings and broader workspace-label
  rollout are deferred to [[task.2026.2026-03-17-web-commands-phase3]]

## Decisions

- Alias remains the command selector and filter selector.
- Use `displayName` as the operator-facing workspace label field.
- `displayName` is optional and falls back to alias when absent.
- `displayName` editing is phase-2 scope; alias rename is not.
- `displayName` is stored in registered workspace metadata, not workspace
  config.
- Phase-2 per-workspace settings should include preferred username even though
  that value persists in user config.
- All workspace-file settings beyond `displayName` and preferred username are
  deferred to [[task.2026.2026-03-17-web-commands-phase3]].
- The Recordings page uses `Re-start` for stopped rows.
- The Recordings page is a latest-state-per-output-file surface, not a
  recording-cycle history view.
- `Re-start` means reuse the same output path and open a new recording cycle on
  the same workspace output; it does not create a new destination.
- If the same-path `Re-start` target no longer passes write policy, fail fast
  with an error message.
- If the same-path `Re-start` target no longer exists, fail fast with an error
  message rather than recreating it.
- Starting or `Re-start`ing a recording stops any other active recording that
  is currently targeting the same file so file ownership stays exclusive.
- Creating a fresh recording or capture remains Sessions-page only.
- Capture keeps fresh-file semantics and should not reuse or overwrite an
  existing output file.
- Session-page workspace selectors should render as
  `<alias> (<displayName>)` when a display name is present, with the display
  name truncated as needed.
- In general, workspace UI labels should render as
  `<alias> (<displayName>)` when not just using alias alone.
- In phase 2, Summary workspace-label polish is limited to the workspace card.
- Manual twin suppression / twin-generation policy work is deferred to
  [[task.2026.2026-03-17-web-commands-phase3]].

## Contract Changes

- add optional `workspace.displayName` to registered workspace metadata and web
  loader/view-model types
- allow workspace registration entry points to accept optional `displayName`
  alongside alias/path without turning display-name-only updates into
  restart-required mutations
- add shared workspace label/view-model support for display-name fallback and
  `<alias> (<displayName>)` label formatting
- add per-workspace settings mutation surface for registry-backed
  `displayName` plus user-config-backed preferred username
- add Recordings-page mutation surface for `stop-recording` on engaged rows and
  `restart-recording` on stopped rows using existing workspace/path identity
- change the Recordings loader/view-model contract to latest-state-per-output
  rows rather than full recording-cycle expansion
- starting or `restart-recording` must enforce single-active-writer-per-file
  behavior by stopping conflicting engaged outputs before opening the target
- `restart-recording` failure responses should clearly distinguish write-policy
  rejection from missing-path refusal
- Summary page only needs workspace label fields for the workspace card in
  phase 2

## Testing

- route/loader tests for Recordings-page stop / `Re-start` lifecycle mutations
- mutation tests for same-path `Re-start` behavior and clear failure handling
  when a stopped row cannot be restarted
- regression tests for same-file exclusivity, including same-session conflicts
- validation tests for `displayName` and preferred-username editing across
  registry / user-config boundaries
- parser and mutation tests for registration-time `displayName` support in CLI
  and web-backed registration flows
- rendering tests for workspace label fallback and Sessions-page selector copy
- rendering tests should confirm `<alias> (<displayName>)` formatting and alias
  fallback
- manual smoke check for workspace-card labels and selector truncation

## Non-Goals

- Alias rename workflow; deferred to
  [[task.2026.2026-03-17-web-commands-phase3]]
- Manual twin suppression or runtime twin-policy editing; deferred to
  [[task.2026.2026-03-17-web-commands-phase3]]
- Editing workspace-file settings such as `defaultOutputDir`,
  `filenameTemplate`, `workspaceTimezone`, `markdownFrontmatter`, or
  `workspaceFeatureFlags`; deferred to
  [[task.2026.2026-03-17-web-commands-phase3]]
- Starting a fresh recording or capture from the Recordings page
- Basic Sessions page command entry

## Implementation Plan

- [x] Add `displayName` contract updates and shared workspace-label view-models
- [x] Define the Recordings-page stop / `Re-start` contract, including
      same-path failure behavior
- [x] Define the narrow per-workspace settings surface for `displayName` and
      preferred username
- [x] Implement Workspaces-page editing for `displayName` and preferred
      username, then propagate workspace labels through Sessions, Summary, and
      workspace-filter headings
- [x] Extend workspace registration entry points so CLI `workspace register`
      and the Workspaces-page register tile can set an initial `displayName`
- [x] Split concrete follow-up implementation tasks once the contracts above
      are locked
