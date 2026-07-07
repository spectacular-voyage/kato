---
id: 4agyihw42eypnbkvzay7slmk
title: 'Release Notes v0.2.14'
desc: Shared workspace config editing and first-class output tagging in Kato Web.
updated: 1782740766561
created: 1782740766561
---

## Summary

`v0.2.14` adds shared workspace config editing and first-class output tagging to Kato Web. Registered workspaces now have an `Edit` action that opens a dedicated editor for `.kato-workspace-config.yaml` fields: output directory, filename template, workspace timezone, shared default tags, shared tag suggestions, markdown frontmatter toggles, and writer feature flags including relative local links and Dendron wikilinks. The editor uses the same workspace config schema that powers daemon/runtime behavior, so invalid values are rejected before writes happen.

This release also wires tags into the output metadata model: workspace defaults, session defaults, and direct per-output tags resolve into stable markdown frontmatter tags, while personal tag libraries remain suggestions unless selected for an output.

## User-facing Changes

- The Workspaces page now includes an `Edit` action for each registered workspace.
- The new workspace config editor can update `defaultOutputDir`, `filenameTemplate`, `workspaceTimezone`, `defaultTags`, and `tagSuggestions`.
- Markdown frontmatter settings can now be toggled from Kato Web, including frontmatter inclusion, `updated`, participant username fields/headings, session ids, workspace ids, recording ids, and event kinds.
- Workspace writer flags can now be toggled from Kato Web, including commentary, thinking, tool calls/results, decision prompt/options/selection, italicized user messages, relative local links, and Dendron wikilinks.
- The editor shows the workspace root, config path, and read-only Dendron/wikilink diagnostics for the effective default output location.
- Server-rendered web forms now emit editable field values in browser-native markup, so workspace config, Settings, and Maintenance fields are populated before any client-side code runs.
- Invalid workspace configs are shown as errors instead of crashing the page.
- The Sessions page `New capture` and `New recording` popovers now accept direct output tags alongside title and filename snippet overrides.
- The Sessions page `New capture` and `New recording` popovers now stay within the viewport when opened near the bottom of the page.
- The Recordings page now shows effective output tags and can edit direct per-output tags for active or stopped outputs; markdown frontmatter is updated best-effort without rewriting the body.
- The Settings page can edit personal global tag suggestions and per-workspace personal tag suggestions. Personal suggestions do not write into output files unless selected or typed for an output.
- User documentation now explains which settings are shared workspace config versus personal user config.

### Upgrade notes

- Saving from the Kato Web workspace config editor rewrites `.kato-workspace-config.yaml` in Kato's canonical YAML shape. This keeps validation simple and schema-owned, but it can remove hand-written comments or custom formatting from that file.
- Existing output files are not renamed or migrated when workspace config changes. Future recordings, captures, and appends use the current effective workspace settings.
- Workspaces with currently invalid config, including unsupported keys, must be repaired before the web editor can save them.
- Existing user config files without `tagLibraries` load with empty personal tag libraries; saving user settings may write the new `tagLibraries` section.
- Tags are normalized by trimming whitespace, rejecting empty/control-character entries, and stable-deduping case-sensitively while preserving spelling.
- Persona libraries are not part of this release and remain planned follow-up work.

## Developer-oriented Changes

- Runtime workspace config mutation now flows through `updateWorkspaceConfig()`, which loads the registered workspace, validates edits with the existing workspace config parser, writes atomically, and returns normalized/effective config values for display.
- Workspace config serialization now has schema-owned helpers for canonical YAML output and effective value resolution.
- Workspace config now includes schema-backed `defaultTags` and `tagSuggestions`; user config now includes optional `tagLibraries.globalSuggestions` and `tagLibraries.workspaceSuggestions`.
- Shared tag helpers validate/normalize tags and resolve suggestions across workspace libraries, personal libraries, and existing output tags.
- `resolveEffectiveOutputMetadata()` now accepts workspace default tags and resolves tag order as session defaults, workspace defaults, then direct output tags.
- Kato Web adds `loadWorkspaceConfigEditPageData()` and `handleWorkspaceConfigEditPost()` for the `/workspaces/:workspaceId/edit` route.
- Kato Web routes and loaders now carry tag suggestions to Sessions/Recordings, persist direct per-output tags via `runSessionOutputMetadataUpdateAction()`, and replace existing markdown frontmatter tags on tag edits.
- The recording pipeline now accepts `frontmatterTags` through `RecordingOutputOverrides`, so web-created outputs and daemon in-chat workspace outputs can write effective tags at creation/append time.
- Focused tests cover successful edits, partial programmatic edits that preserve inherited defaults, invalid edits that preserve the existing file, invalid config page data, redirect behavior, and Dendron wikilink diagnostics.
- Additional focused tests cover workspace/user tag config parsing, effective tag resolution, suggestion merging, creation-time tag writes, recordings-page tag edits, and metadata-only frontmatter tag replacement.
- Developer docs now record the canonical-rewrite decision and document the new web route/helper ownership.
- Internal planning notes now mark the implemented web-first tagging slice and leave CLI tag-library management plus in-chat tag mutation as follow-up work.
