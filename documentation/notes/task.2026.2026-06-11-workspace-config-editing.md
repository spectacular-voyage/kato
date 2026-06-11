---
id: 20260611-workspace-config-editing
title: 2026 06 11 Workspace Config Editing
desc: ''
updated: 1781187417804
created: 1781187417804
---

## Goal

- Add a Workspaces-page editing surface for shared workspace config values.
- Provide a reusable foundation for later workspace tag libraries in
  [[task.2026.2026-06-11-output-tagging]] and shared workspace personas in
  [[task.2026.2026-05-28-persona-support]].
- Start with existing `.kato-workspace-config.yaml` values rather than new
  metadata libraries.

## Summary

- `/workspaces` currently supports registration, display-label editing,
  unregistering, and per-workspace preferred username editing.
- Workspace config itself is still file-edited. That is fine for developers but
  awkward once Kato Web becomes the guided workflow surface.
- Add an `Edit` button per workspace that opens a dedicated edit page or
  compact popover for shared workspace config.
- Initial editable fields should be limited to existing, well-understood
  config:
  - `defaultOutputDir`
  - `filenameTemplate`
  - `workspaceTimezone`
  - markdown frontmatter toggles
  - writer feature flags, including `writerUseDendronStyleWikilinks` and
    `writerRelativizeLocalLinks`
- This task intentionally does not implement tag libraries or persona
  libraries, but it should leave room for those sections to be added later.

## Discussion

- Shared workspace config is different from user config:
  - `.kato-workspace-config.yaml` may live in a repo and be shared;
  - `kato-user-config.yaml` is personal;
  - a web editing surface should make that distinction visible.
- "Wikilink scope" is currently shown as diagnostics derived from
  `dendron.yml` and the resolved output directory. The directly editable knobs
  are the related writer flags and output-location settings, not the derived
  scope itself.
- The first UI should be conservative. Prefer a dedicated edit page if the
  number of controls makes the current Workspaces row too dense.
- The mutation should preserve unknown-free config validation. Workspace config
  currently fails closed on unknown keys; the editor should write only the
  supported schema.
- To avoid destroying hand-written formatting or comments, consider whether
  the first implementation should:
  - rewrite the whole YAML in Kato's canonical format; or
  - parse and patch known fields while preserving unrelated formatting.
  The current config loader only returns normalized overrides, so whole-file
  canonical rewrite is simpler but more intrusive.
- This edit surface should eventually become the place to edit shared
  workspace tag libraries and shared workspace personas. Personal tag and
  persona libraries belong in user settings instead.

## Open Issues

- Should the first UI be a separate `/workspaces/:id/edit` route or an inline
  popover/details panel on `/workspaces`?
- Should the editor perform whole-file canonical rewrites, or preserve
  comments/formatting where possible?
- Which fields should be in the first slice? Recommendation: output directory,
  filename template, timezone, Dendron/relative-link flags, and frontmatter
  include toggles.
- Should editing be disabled when the workspace config file is invalid, or
  should the editor offer a repair/scaffold flow?

## Decisions

- Add a per-workspace `Edit` action to `/workspaces`.
- Edit shared `.kato-workspace-config.yaml` values only.
- Keep user-level settings, personal personas, and personal tag libraries out
  of this shared workspace editor.
- Treat derived wikilink scope as read-only diagnostics; edit the flags and
  output-location inputs that affect it.
- Use existing workspace config validation and path/template validation.
- Do not implement tag library or persona library editing in the first slice,
  but reserve UI structure for it.

## Contract Changes

- Add workspace config mutation helpers that:
  - load current workspace config overrides;
  - apply validated edits;
  - write the updated config atomically;
  - return the resolved/normalized config for display.
- Add web route/action support for editing workspace config:
  - selector/workspace id;
  - default output directory;
  - filename template;
  - workspace timezone;
  - markdown frontmatter toggles;
  - writer feature flags.
- Add loader fields for the edit UI:
  - raw/effective config values;
  - validation errors;
  - derived Dendron/wikilink diagnostics.
- Keep existing registration/display-name/user-username mutations intact.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| Edit filename template from web | Yes | Not applicable | Yes | Future generated destinations use the edited shared config. Existing outputs keep their persisted path. |
| Edit Dendron wikilink flag | Yes | Not applicable | Yes | Future writes use the new flag; existing markdown body rewrite behavior only happens on future append. |
| Edit workspace timezone | Yes | Not applicable | Yes | Future filename/headings use the new timezone; existing outputs are not renamed. |
| Invalid edit submitted | Yes | Not applicable | Yes | Reject and preserve existing config. |
| Workspace config currently invalid | Yes | Not applicable | Yes | Initial slice may show error instead of offering repair. |

## Testing

- Workspace config mutation tests:
  - update each first-slice field;
  - preserve omitted optional fields as inherited defaults where intended;
  - reject invalid filename/default-output tokens;
  - reject invalid timezone values;
  - reject non-boolean flags.
- Web action tests:
  - successful edit redirects with notice;
  - invalid edit redirects with error and preserves config;
  - CSRF/action plumbing remains intact.
- Loader/view-model tests:
  - expose raw/effective editable values;
  - expose derived wikilink diagnostics;
  - handle invalid workspace config without crashing the page.
- Validation:
  - run focused tests first;
  - run `deno task check` for contract changes;
  - run `deno task ci` before PR.

## Non-Goals

- No tag library editing in the first slice; see
  [[task.2026.2026-06-11-output-tagging]].
- No persona library editing in the first slice; see
  [[task.2026.2026-05-28-persona-support]].
- No user-level settings editor.
- No historical output rewrite or filename migration.
- No broad workspace registry redesign.

## Implementation Plan

- [ ] Add workspace config mutation helper(s) with focused tests.
- [ ] Add loader support for editable workspace config values.
- [ ] Add an `Edit` action from each Workspaces row.
- [ ] Add a dedicated edit page or compact popover for first-slice fields.
- [ ] Wire POST handling for workspace config edits.
- [ ] Preserve existing register/display-name/username/unregister behavior.
- [ ] Add validation and web action tests.
- [ ] Update workspaces loader/view-model tests.
- [ ] Update developer/user documentation after behavior is implemented.
