---
id: 4agyihw42eypnbkvzay7slmk
title: 'Release Notes v0.2.14'
desc: Shared workspace config editing in Kato Web, with schema-backed validation and canonical workspace YAML writes.
updated: 1782740766561
created: 1782740766561
---

## Summary

`v0.2.14` adds shared workspace config editing to Kato Web. Registered workspaces now have an `Edit` action that opens a dedicated editor for existing `.kato-workspace-config.yaml` fields: output directory, filename template, workspace timezone, markdown frontmatter toggles, and writer feature flags including relative local links and Dendron wikilinks. The editor uses the same workspace config schema that powers daemon/runtime behavior, so invalid values are rejected before writes happen.

## User-facing Changes

- The Workspaces page now includes an `Edit` action for each registered workspace.
- The new workspace config editor can update `defaultOutputDir`, `filenameTemplate`, and `workspaceTimezone`.
- Markdown frontmatter settings can now be toggled from Kato Web, including frontmatter inclusion, `updated`, participant username fields/headings, session ids, workspace ids, recording ids, and event kinds.
- Workspace writer flags can now be toggled from Kato Web, including commentary, thinking, tool calls/results, decision prompt/options/selection, italicized user messages, relative local links, and Dendron wikilinks.
- The editor shows the workspace root, config path, and read-only Dendron/wikilink diagnostics for the effective default output location.
- Invalid workspace configs are shown as errors instead of crashing the page.
- User documentation now explains which settings are shared workspace config versus personal user config.

### Upgrade notes

- Saving from the Kato Web workspace config editor rewrites `.kato-workspace-config.yaml` in Kato's canonical YAML shape. This keeps validation simple and schema-owned, but it can remove hand-written comments or custom formatting from that file.
- Existing output files are not renamed or migrated when workspace config changes. Future recordings, captures, and appends use the current effective workspace settings.
- Workspaces with currently invalid config, including unsupported keys, must be repaired before the web editor can save them.
- Shared tag libraries and persona libraries are not part of this release; those remain planned follow-up work.

## Developer-oriented Changes

- Runtime workspace config mutation now flows through `updateWorkspaceConfig()`, which loads the registered workspace, validates edits with the existing workspace config parser, writes atomically, and returns normalized/effective config values for display.
- Workspace config serialization now has schema-owned helpers for canonical YAML output and effective value resolution.
- Kato Web adds `loadWorkspaceConfigEditPageData()` and `handleWorkspaceConfigEditPost()` for the `/workspaces/:workspaceId/edit` route.
- Focused tests cover successful edits, partial programmatic edits that preserve inherited defaults, invalid edits that preserve the existing file, invalid config page data, redirect behavior, and Dendron wikilink diagnostics.
- Developer docs now record the canonical-rewrite decision and document the new web route/helper ownership.
- Internal planning notes now point at the completed creation-time title/filename override task in the developer archive.
