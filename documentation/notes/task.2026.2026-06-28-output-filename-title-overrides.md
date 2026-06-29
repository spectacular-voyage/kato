---
id: 20260628-output-filename-title-overrides
title: 2026 06 28 Output Filename And Title Overrides
desc: ''
updated: 1782688387000
created: 1782688387000
---

## Goal

- Let users set a useful output title and filename slug in the existing Sessions-page New Capture/New Recording workspace chooser popovers, especially when the conversation's first meaningful line is not a good filename seed.
- Keep this task focused on creation-time choices; post-start title editing and file renaming are separate workflows.
- Define the separate explicit path/rename behavior needed when a user really wants to change the generated filename or destination after output creation.

## Summary

- Kato's default `filenameTemplate` commonly includes `{snippetSlug}`, and that slug currently comes from the session snippet extracted from conversation content.
- The existing session/output metadata foundation already supports `displayTitle`, and the current contract intentionally says title edits do not rename `currentResolvedPath`.
- Adjacent task notes mention New Capture/New Recording pre-edit fields for tags, personas, and an optional destination filename/path, but there is no dedicated task that defines custom snippet slugs or filename overrides.
- This task fills that gap by separating three related but different things: display title, template slug override, and explicit destination override.
- The natural first UI is the Sessions-page New Capture/New Recording popover that already chooses the workspace and remembers the last submitted workspace.

## Discussion

- A display title is descriptive metadata. It can be shown in Kato Web and synced to markdown frontmatter `title`, but it should not imply a filesystem move.
- A custom snippet slug is a template input. If a workspace template is `{timestampHumane}-{snippetSlug}-{provider}.md`, setting `filenameSlug` to `better-name` should produce the same normal generated path shape with only the slug portion customized.
- A full filename/path override is a destination choice. It bypasses more of the template and must go through the same path policy and collision handling as in-chat command path arguments.
- The first web slice should enlarge the existing compact creation popover flow: workspace selection, title, filename snippet/preview, and later tags or persona/participant where enabled.
- The title and snippet fields should both exist, but they should not feel like duplicate chores. The title is the human-facing label and frontmatter title; the snippet is the filename-template input.
- Changing the title should update the filename snippet while the snippet field is still pristine/auto-derived. Once the user manually edits the snippet, further title changes should leave the snippet alone.
- The snippet field should offer a clear way to return to title-derived behavior after manual customization.
- The UI should make the preview concrete before submission. Users should see the resolved filename or a close approximation before Kato creates the file.
- If the workspace `filenameTemplate` does not include `{snippetSlug}`, a slug override has no effect. The UI should either hide the slug field or show that the current template ignores it.
- For already-created outputs, a path rename/retarget should be a separate action with explicit wording, collision checks, and an audit trail in persisted output state. Do not expand this task into post-start title editing UI.
- In-chat commands already accept explicit path arguments; adding flags such as `--title` or `--slug` should wait until command parsing has a clear options grammar.

## Open Issues

- What should the persisted field be called? Recommendation: add `filenameSlug?: string` to `SessionOutputMetadataV1`, treating it as a user-selected `{snippetSlug}` override rather than a general path.
- Should the first implementation include full filename/path override, or only custom `{snippetSlug}`? Recommendation: implement custom slug first and keep full destination override as an advanced follow-up unless persona/tagging work needs it immediately.
- Should post-start filename rename move the file on disk, start a new destination, or only retarget future appends? Recommendation: require a dedicated retarget/rename design before implementation; do not overload title edit.
- Should custom slugs be available for in-chat control commands? Recommendation: defer until command options are designed; path arguments already cover the expert workaround.

## Decisions

- Treat display title, filename slug override, and full destination override as separate concepts.
- Use `displayTitle` for the creation-time product-facing title and markdown frontmatter `title`.
- Add a creation-time filename slug override for web-created captures and recordings.
- Put the first-slice controls in the existing Sessions New Capture/New Recording workspace chooser popovers.
- Expose both title and snippet controls, with title-derived snippet behavior until the snippet is manually customized.
- Resolve `{snippetSlug}` from output metadata first when an explicit slug override exists, then fall back to the extracted session snippet.
- Do not add post-start title editing UI in this task.
- Do not silently rename or move existing output files from title edits or metadata edits.
- Keep all filename/path values under existing workspace destination policy, collision handling, and allowed-write-root validation.

## Contract Changes

- `SessionOutputMetadataV1`
  - add optional `filenameSlug?: string`;
  - validate as a non-empty string after normalization when present;
  - treat it as output metadata because it describes how this output's destination was selected.
- Filename rendering
  - let `renderWorkspaceFilename` accept output metadata or an explicit snippet-slug override;
  - when `filenameSlug` is present, slugify/sanitize it with the same filename slug rules used for extracted snippets;
  - if normalization collapses to an empty/dot segment, fall back to the normal conversation fallback rather than creating an unsafe path.
- Web session actions
  - accept optional creation metadata for `displayTitle`, `filenameSlug`, and later tags/persona fields;
  - persist the metadata onto the created workspace output;
  - use the effective metadata when resolving the initial destination.
- Web UI
  - extend the existing New Capture/New Recording workspace chooser popovers with creation metadata controls;
  - track whether the snippet field is auto-derived from title or manually customized;
  - update auto-derived snippet previews when the title changes;
  - show a resolved filename preview when the selected workspace and template are available;
  - keep full path override behind an explicit advanced affordance if included.
- Existing output edits
  - keep post-start title editing out of this task, even though the metadata layer can support it;
  - reserve path changes for a separate explicit rename/retarget mutation that updates `currentDestination`, `currentResolvedPath`, and related persisted state only after path-policy validation succeeds.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| New web capture with custom title only | Yes | Not applicable | Yes | Persist `displayTitle`, sync frontmatter title, and use normal snippet-derived filename unless the slug is also set. |
| New web recording with custom slug | Yes | Not applicable | Yes | Persist `filenameSlug` and use it for `{snippetSlug}` during initial destination resolution. |
| New web recording with title that seeds slug | Yes | Not applicable | Yes | Persist only the confirmed values; auto-derived UI state should not create hidden metadata surprises. |
| Workspace template omits `{snippetSlug}` | Yes | Not applicable | Yes | Persisting a slug is optional; filename preview should show that the template ignores it. |
| User changes title before manually editing snippet | Yes | Not applicable | Yes | Update the derived snippet and filename preview from the new title. |
| User changes title after manually editing snippet | Yes | Not applicable | Yes | Preserve the custom snippet and only update `displayTitle`. |
| User edits recording title after file exists | Yes | Not applicable | Yes | Out of scope for this task; existing metadata helpers may support it separately, but this task should not add that UI. |
| User wants to rename an existing output file | Yes | Not applicable | Yes | Use a future explicit rename/retarget action, not the title edit path. |
| Custom slug collides with an existing destination | Yes | Not applicable | Yes | Reuse existing unique-destination retry/collision behavior and surface clear web errors when retries fail. |
| In-chat `::record` with explicit path | Yes | Yes | Yes | Existing path argument behavior remains the expert escape hatch until command flags are designed. |

## Testing

- Contract tests:
  - accept session/output metadata with and without `filenameSlug`;
  - reject malformed or normalization-empty slug values if validation owns normalization;
  - preserve compatibility for existing metadata files.
- Workspace path tests:
  - render `{snippetSlug}` from `filenameSlug` when present;
  - fall back to extracted snippet when no override exists;
  - fall back safely when the override normalizes to an empty/dot segment;
  - preserve existing timestamp, provider, username, and collision behavior.
- Web action tests:
  - new capture accepts `displayTitle` and `filenameSlug`;
  - new recording accepts `displayTitle` and `filenameSlug`;
  - created workspace output persists the metadata;
  - frontmatter title uses `displayTitle` when provided;
  - filename preview/action validation handles templates that omit `{snippetSlug}`.
- UI/view-model tests:
  - popover view model exposes workspace filename-template support for slug preview;
  - title edits update the auto-derived snippet while the snippet is pristine;
  - manual snippet edits stop title changes from overwriting the snippet;
  - existing Sessions/Recordings rows prefer `displayTitle` for labels without hiding the actual file path.
- Validation:
  - run focused path/action/contract tests first;
  - run `deno task check` for contract changes;
  - run `deno task ci` before PR.

## Non-Goals

- No AI-generated title or summary; see [[product-ideas]] for that broader idea.
- No post-start title editing UI in this task.
- No implicit filesystem rename from a title edit.
- No broad file browser or arbitrary destination picker in the first slice.
- No in-chat command option grammar for `--title` or `--slug` in the first slice.
- No historical body rewrite when title or slug metadata changes.
- No import-from-frontmatter behavior.

## Implementation Plan

- [x] Confirm field naming and first-slice scope: `displayTitle` plus `filenameSlug`, with full path override deferred unless needed.
- [x] Extend `SessionOutputMetadataV1` and validation for optional `filenameSlug`.
- [x] Add focused contract tests for `filenameSlug`.
- [x] Extend workspace filename rendering to accept a metadata/custom slug source.
- [x] Add workspace path tests for custom slug rendering and unsafe slug fallback.
- [x] Extend web capture/recording actions to accept creation metadata.
- [x] Persist creation metadata onto new workspace outputs.
- [x] Ensure markdown frontmatter title uses `displayTitle` for new outputs.
- [x] Project filename-template/slug-preview data into Sessions view models.
- [x] Extend the existing Sessions New Capture/New Recording workspace chooser popovers with title and filename snippet controls.
- [x] Add popover dirty-state behavior so title changes update the snippet until the snippet is manually customized.
- [x] Add a reset affordance for returning the snippet to title-derived behavior.
- [x] Keep tag/persona controls coordinated with [[task.2026.2026-06-11-output-tagging]] and [[task.2026.2026-05-28-persona-support]].
- [x] Add web action and UI tests for custom title/slug creation.
- [x] Decide whether to add an explicit existing-output rename/retarget task after the creation-time slug path lands.
- [x] Update developer and user documentation after behavior is implemented.
- [x] Run focused tests, `deno task check`, and the non-audit CI gates.
- [x] Re-run full `deno task ci` after the current Vite audit advisory is resolved.
