---
id: kijkk7ll23lsry5229wlj2o
title: 2026 03 04 Username Features
desc: ''
updated: 1772758742764
created: 1772632731040
---

## Goal

Support username-aware output generation so workspace exports can include
`{username}` in generated filenames and default output directories, optionally
use username in user message headings, and emit plain usernames in frontmatter
participants.

## Summary

- Add `{username}` token support in workspace `filenameTemplate`.
- Add token interpolation support in workspace `defaultOutputDir` (including
  `{username}`).
- Add workspace toggle to use username in user message headings.
- Change frontmatter user participant format from `user.<username>` to
  `<username>`.
- Use a clean-break approach with no legacy compatibility logic.

## Discussion

Current behavior does not support `{username}` in filename templating, and
frontmatter currently prefixes user participants with `user.`. This task
standardizes username usage across output surfaces while keeping behavior
explicit and deterministic.

Decisions:
- Username source for filenames/directories/headings:
  `workspaceUsernames[workspaceId]` -> `defaultUsername` -> `"unknown-user"`.
- This source policy ignores `excludeMeFromParticipantList`; that flag remains
  frontmatter-specific.
- Filename/path interpolation sanitization uses existing filename-safe slug
  rules (lowercase, `[a-z0-9._-]` normalization).
- Heading username behavior is configurable in workspace config, default
  `false`.
- No legacy support or migration logic is added.

## Contract Changes

Workspace config:
- `filenameTemplate` now supports `{username}`.
- `defaultOutputDir` now supports token interpolation, including `{username}`.
- `markdownFrontmatter.addParticipantUsernameToHeadings: boolean` is added with
  default `false`.

Frontmatter behavior:
- User participant entry is emitted as `<username>` (no `user.` prefix).
- Assistant participants remain `provider.model` or `provider.assistant`.

## Testing

- Validate `{username}` is accepted in `filenameTemplate`.
- Validate unsupported tokens are still rejected.
- Verify `{username}` interpolation in generated filename and interpolated
  `defaultOutputDir`.
- Verify username fallback chain resolves to `unknown-user` when no user
  mapping/default exists.
- Verify heading behavior:
  - toggle `true` -> `# <resolved-username>_<timestamp>`
  - toggle `false` -> `# User_<timestamp>`
- Verify frontmatter participants emit plain username for user entries.
- Verify no legacy-specific normalization/compatibility behavior is added.

## Non-Goals

- No migration tooling for existing markdown/frontmatter.
- No compatibility transforms for legacy `user.<username>` participant entries.
- No `{username}` interpolation in explicit user-provided command path
  arguments.

## Implementation Plan

- [ ] Update workspace config token validation to allow `{username}` in
  `filenameTemplate`.
- [ ] Implement token interpolation for `defaultOutputDir` with `{username}`
  support.
- [ ] Thread resolved username into workspace generated-path rendering.
- [ ] Add `markdownFrontmatter.addParticipantUsernameToHeadings` to workspace
  config parse/default shape.
- [ ] Wire heading rendering to use resolved username when heading toggle is
  enabled.
- [ ] Update frontmatter participant generation to emit plain username entries.
- [ ] Add tests for token validation, interpolation, fallback behavior, heading
  toggle behavior, and participant formatting.
- [ ] Update README and related notes to document new token support, heading
  toggle, and participant output format.