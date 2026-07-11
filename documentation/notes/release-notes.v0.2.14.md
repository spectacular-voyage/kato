---
id: 4agyihw42eypnbkvzay7slmk
title: 'Release Notes v0.2.14'
desc: Workspace config editing, output tagging, automatic recording, and grouped session trees.
updated: 1782740766561
created: 1782740766561
---

## Summary

`v0.2.14` adds shared workspace config editing and first-class output tagging to Kato Web. Registered workspaces now have an `Edit` action that opens a dedicated editor for `.kato-workspace-config.yaml` fields: output directory, filename template, workspace timezone, shared default tags, shared tag suggestions, automatic recording, markdown frontmatter toggles, and writer feature flags including relative local links and Dendron wikilinks. The editor uses the same workspace config schema that powers daemon/runtime behavior, so invalid values are rejected before writes happen.

This release also wires tags into the output metadata model: workspace defaults, session defaults, and direct per-output tags resolve into stable markdown frontmatter tags, while personal tag libraries remain suggestions unless selected for an output.

Registered workspaces can now opt into automatic recording for Claude conversations whose provider-reported working directory is inside the workspace root. Automatic recording defaults off, reuses Kato's normal workspace recording state and destination rules, and does not replace an existing output.

The Sessions page now groups provider-declared Claude and Codex sub-conversations beneath expandable parents that default closed. The `Grouped` / `Hidden` control preserves the existing bookmarkable URL behavior; `Hidden` excludes recognized sub-conversations from Sessions rows and totals.

Sessions rows now also show `Twin <size>` for recognized persisted Kato history or `Twin absent` when no usable twin size is available.

## User-facing Changes

- The Workspaces page now includes an `Edit` action for each registered workspace.
- The new workspace config editor can update `defaultOutputDir`, `filenameTemplate`, `workspaceTimezone`, `defaultTags`, `tagSuggestions`, and `autoRecordConversations`.
- Markdown frontmatter settings can now be toggled from Kato Web, including frontmatter inclusion, `updated`, participant username fields/headings, session ids, workspace ids, recording ids, and event kinds.
- Workspace writer flags can now be toggled from Kato Web, including commentary, thinking, tool calls/results, decision prompt/options/selection, italicized user messages, relative local links, and Dendron wikilinks.
- The editor shows the workspace root, config path, and read-only Dendron/wikilink diagnostics for the effective default output location.
- Server-rendered web forms now emit editable field values in browser-native markup, so workspace config, Settings, and Maintenance fields are populated before any client-side code runs.
- Invalid workspace configs are shown as errors instead of crashing the page.
- Registered workspaces can opt into automatic recording for Claude conversations whose provider-reported working directory is inside the workspace root. The setting defaults off; Codex and Gemini still require manual recording or capture. On first attachment, Kato writes the available conversation context and continues recording future events.
- The Sessions page `New capture` and `New recording` popovers now accept direct output tags alongside title and filename snippet overrides.
- The Sessions page `New capture` and `New recording` popovers now stay within the viewport when opened near the bottom of the page.
- Claude workflow and sub-agent sessions can now recover snippets from sidechain-marked entries when the source file is itself a recognized sub-agent transcript, avoiding misleading `snippet unavailable` rows without changing top-level sidechain deduplication.
- The Sessions toolbar now has `Grouped` and `Hidden` sub-conversation controls. `Grouped` is the inclusive default with expandable parents closed initially; `Hidden` uses the bookmarkable `subagents=hide` query and remains selected through live refreshes and Sessions actions.
- Parent disclosures summarize descendant count, active-descendant and active-recording counts, and available descendant Twin bytes. Expanded children retain their own activity, recording actions, and individual Twin sizes.
- Child links expand their ancestor chain automatically, open branches survive live refreshes, and Sessions actions return to the acted-on child.
- Recognized children with unavailable or cyclic parents remain accessible under `Unlinked sub-conversations`. When only a child matches an activity or workspace filter, its ancestors appear as uncounted context rows. `Hidden` affects the Sessions inventory only; Recordings and Maintenance remain complete.
- Each Sessions row now shows `Twin <size>` using 1024-based byte units, or `Twin absent` when Kato has no recognized persisted twin history. The indicator is a rough measure of Kato's JSONL history and can be partial when persistence began after the provider conversation started; twin paths, state, troubleshooting, and cleanup remain in Maintenance.
- The Recordings page now shows effective output tags and can edit direct per-output tags for active or stopped outputs; markdown frontmatter is updated best-effort without rewriting the body.
- The Settings page can edit personal global tag suggestions and per-workspace personal tag suggestions. Personal suggestions do not write into output files unless selected or typed for an output.
- User documentation now explains which settings are shared workspace config versus personal user config.

### Upgrade notes

- Saving from the Kato Web workspace config editor rewrites `.kato-workspace-config.yaml` in Kato's canonical YAML shape. This keeps validation simple and schema-owned, but it can remove hand-written comments or custom formatting from that file.
- Existing output files are not renamed or migrated when workspace config changes. Future recordings, captures, and appends use the current effective workspace settings.
- Workspaces with currently invalid config, including unsupported keys, must be repaired before the web editor can save them.
- Existing user config files without `tagLibraries` load with empty personal tag libraries; saving user settings may write the new `tagLibraries` section.
- Existing workspace configs remain opted out of automatic recording because `autoRecordConversations` defaults to `false`.
- On the first daemon discovery after upgrade, existing Codex child metadata is enriched with provider-declared immediate-parent ids when the rollout source remains available and contains valid parent metadata. This does not replay transcripts or change session activity timestamps.
- Reload Kato Web tabs that were already open during the upgrade. Live polling refreshes session data, but the tab keeps its previously loaded interface bundle until navigation or reload.
- Tags are normalized by trimming whitespace, rejecting empty/control-character entries, and stable-deduping case-sensitively while preserving spelling.
- Persona libraries are not part of this release and remain planned follow-up work.

## Developer-oriented Changes

- Runtime workspace config mutation now flows through `updateWorkspaceConfig()`, which loads the registered workspace, validates edits with the existing workspace config parser, writes atomically, and returns normalized/effective config values for display.
- Workspace config serialization now has schema-owned helpers for canonical YAML output and effective value resolution.
- Workspace config now includes schema-backed `defaultTags` and `tagSuggestions`; user config now includes optional `tagLibraries.globalSuggestions` and `tagLibraries.workspaceSuggestions`.
- Shared tag helpers validate/normalize tags and resolve suggestions across workspace libraries, personal libraries, and existing output tags.
- `resolveEffectiveOutputMetadata()` now accepts workspace default tags and resolves tag order as session defaults, workspace defaults, then direct output tags.
- Workspace config/profile contracts now include `autoRecordConversations`. Claude events can project `source.workingDirectory`, session metadata persists the inferred working directory, and the daemon reuses normal workspace output state to attach eligible sessions before append processing.
- Kato Web adds `loadWorkspaceConfigEditPageData()` and `handleWorkspaceConfigEditPost()` for the `/workspaces/:workspaceId/edit` route.
- Kato Web routes and loaders now carry tag suggestions to Sessions/Recordings, persist direct per-output tags via `runSessionOutputMetadataUpdateAction()`, and replace existing markdown frontmatter tags on tag edits.
- Sessions relationships derive Claude parents from their exact `subagents` source layout and Codex immediate parents from `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`; they never infer from snippets, timing, or ids, and provider source paths remain server-only.
- Schema-v1 session metadata gains optional `parentProviderSessionId`. Codex discovery performs a metadata-only backfill for existing rows without marking historical sessions dirty or replaying their transcripts.
- The Sessions loader resolves provider parent ids to Kato session ids, recursively retains filtered ancestors as uncounted structural context, excludes both Claude and Codex children under `subagents=hide`, and fails open into an unlinked group for missing/cyclic parents.
- `apps/web/src/session_tree.ts` builds recursive branches, orders parent groups by their best matching subtree row, calculates descendant activity/Twin summaries, detects cycles, and resolves ancestor chains for fragment links.
- The Sessions island renders explicit accessible disclosure buttons, keeps expansion state outside two-second poll data, keeps controlled child-list elements available for accessibility while omitting collapsed child rows from the DOM, and preserves child anchors through POST redirects.
- Sessions rows now carry optional path-free `twinSizeBytes`, derived from the twin-file stat already used during persisted-metadata normalization. The implementation reuses that result rather than adding another per-session filesystem lookup to each live poll, and no shared or persisted session contract changes are required.
- Summary memory values and Sessions twin sizes now share one deterministic formatter with 1024-based `B`, `KB`, `MB`, `GB`, and `TB` units.
- The recording pipeline now accepts `frontmatterTags` through `RecordingOutputOverrides`, so web-created outputs and daemon in-chat workspace outputs can write effective tags at creation/append time.
- Claude parsing and replay enable sidechain events only for exact sub-agent source paths across live ingestion, persisted ingestion, source replay, and snippet recovery.
- Focused tests cover successful edits, partial programmatic edits that preserve inherited defaults, invalid edits that preserve the existing file, invalid config page data, redirect behavior, and Dendron wikilink diagnostics.
- Focused auto-recording tests cover workspace config parsing/serialization, Claude working-directory extraction, conservative workspace matching, snapshot attachment, existing-output preservation, and non-Claude exclusion.
- Additional focused tests cover workspace/user tag config parsing, effective tag resolution, suggestion merging, creation-time tag writes, recordings-page tag edits, and metadata-only frontmatter tag replacement.
- Focused Sessions tests cover query defaults, route composition, POSIX/Windows Claude parent paths, explicit and nested Codex parents, metadata-only backfill, hidden-mode provider coverage, filtered ancestor context/totals, missing parents/cycles, recursive ordering, toolbar state, collapsed markup, path-free live API data, and action-form preservation.
- Focused twin-size tests cover byte-format thresholds, logical persisted-history projection, missing/orphan/growing twins, path-free live-API data, filter composition, and rendered `Twin <size>` / `Twin absent` states.
- Developer docs now record the canonical-rewrite decision and document the new web route/helper ownership.
- Internal planning notes now mark the implemented web-first tagging slice and leave CLI tag-library management plus in-chat tag mutation as follow-up work.
