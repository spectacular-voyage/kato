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
  - add per-recording stop controls for engaged rows
  - add per-recording `Re-start` controls for stopped rows
  - `Re-start` means reuse the same output path; creating a fresh recording or
    capture remains Sessions-page only
- For Workspaces Page:
  - add an optional operator-facing `displayName` distinct from alias
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
- when a workspace UI label shows both selector and operator-facing label, use
  `<alias> (<displayName>)`; if there is no meaningful display name, show alias
  alone

### Recording Lifecycle Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| Stop engaged recording from Sessions or Recordings | Yes | No | No | Only rows backed by persisted workspace-output metadata are actionable |
| `Re-start` stopped recording from Recordings | Yes | No | No | Reuses the same path and opens a new cycle on the same workspace output |
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
- `Re-start` means reuse the same output path and open a new recording cycle on
  the same workspace output; it does not create a new destination.
- If the same-path `Re-start` target no longer passes write policy, fail fast
  with an error message.
- If the same-path `Re-start` target no longer exists, fail fast with an error
  message rather than recreating it.
- Creating a fresh recording or capture remains Sessions-page only.
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
- add shared workspace label/view-model support for display-name fallback and
  `<alias> (<displayName>)` label formatting
- add per-workspace settings mutation surface for registry-backed
  `displayName` plus user-config-backed preferred username
- add Recordings-page mutation surface for `stop-recording` on engaged rows and
  `restart-recording` on stopped rows using existing workspace/path identity
- `restart-recording` failure responses should clearly distinguish write-policy
  rejection from missing-path refusal
- Summary page only needs workspace label fields for the workspace card in
  phase 2

## Testing

- route/loader tests for Recordings-page stop / `Re-start` lifecycle mutations
- mutation tests for same-path `Re-start` behavior and clear failure handling
  when a stopped row cannot be restarted
- validation tests for `displayName` and preferred-username editing across
  registry / user-config boundaries
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

- [ ] Add `displayName` contract updates and shared workspace-label view-models
- [ ] Define the Recordings-page stop / `Re-start` contract, including
      same-path failure behavior
- [ ] Define the narrow per-workspace settings surface for `displayName` and
      preferred username
- [ ] Split concrete follow-up implementation tasks once the contracts above
      are locked
