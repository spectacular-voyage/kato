---
id: 20260611-output-tagging
title: 2026 06 11 Output Tagging
desc: ''
updated: 1781187417804
created: 1781187417804
---

## Goal

- Add first-class output tagging for workspace recordings and captures.
- Let workspace defaults, web-created captures, in-chat captures, and
  already-started recordings write stable markdown frontmatter `tags`.
- Let users add or edit tags after recording has started.
- Support both shared workspace tag libraries and personal user-level tag
  libraries.
- Keep tagging separate from persona/model support in
  [[task.2026.2026-05-28-persona-support]].

## Summary

- Markdown frontmatter already supports `tags`, and append flows can
  accretively merge incoming tags.
- What is missing is a product contract around where tags come from, how they
  persist, and how users edit them after output creation.
- This task should follow the source-of-truth model from
  [[task.2026.2026-05-11-per-output-writer-controls]]:
  - persisted output metadata drives live Kato behavior;
  - markdown frontmatter records descriptive output metadata;
  - frontmatter is not the authoritative config store;
  - stopped outputs can still be edited for future re-arm/restart.
- Workspace tag library editing should build on
  [[task.2026.2026-06-11-workspace-config-editing]].
- Personal tag library editing belongs in user settings and user-level CLI
  commands, not in the shared workspace editor.

## Discussion

- Tags have a different lifecycle from personas:
  - personas influence heading and filename rendering;
  - tags mostly describe the saved output and may evolve during or after a
    recording.
- Tagging should distinguish defaults from suggestions:
  - shared workspace default tags are automatically written to outputs;
  - shared workspace tag suggestions power UI autocomplete for the workspace;
  - user-level tag libraries power personal autocomplete across workspaces;
  - output-specific tags are persisted on the output and merge with defaults.
- User-level tags need extra care because they are personal but output files
  may live in shared workspaces. Recommendation:
  - user-level tags are suggestions by default;
  - user-level default tags, if added, must be explicitly enabled and clearly
    presented as tags that will be written into output files;
  - shared workspace defaults remain the only automatic default in the first
    slice.
- Post-start edits should not require conversation activity. Updating output
  tags should merge or rewrite markdown frontmatter immediately when the file
  is markdown and frontmatter is present, but the persisted output metadata
  remains authoritative either way.
- First-slice tag semantics should be simple:
  - workspace defaults always apply;
  - per-output tags are additive;
  - removing workspace defaults from one output is out of scope unless a clear
    use case appears.
- Tag normalization should use a predictable local rule:
  - trim whitespace;
  - reject empty strings and ASCII control characters;
  - dedupe case-sensitively unless the UI later chooses a display-normalized
    style;
  - keep user spelling rather than slugifying unless frontmatter safety
    requires quoting.
- In-chat tag mutation is useful but should not block the web-first slice. If
  included, it should be a Kato control command and should not be written as
  conversation prose.

## Open Issues

- Should users be able to suppress a workspace default tag for one output?
  Recommendation: no for the first slice; keep defaults additive.
- Should user-level tags ever be automatic defaults? Recommendation: not in the
  first slice; keep personal libraries as suggestions unless the user
  explicitly selects tags for an output.
- Should tags be case-sensitive? Recommendation: preserve spelling and dedupe
  exact normalized strings for now.
- Should the initial UI live on both Sessions and Recordings pages, or only
  Recordings? Recommendation: put editing where output rows already live most
  naturally, then expose compact affordances elsewhere later.
- Should in-chat tag editing be included in this task, or deferred after the
  web mutation path exists?
- Should persona definitions from [[task.2026.2026-05-28-persona-support]]
  eventually contribute suggested/default tags? Recommendation: defer until
  both tasks have their core contracts implemented.

## Decisions

- Split output tagging from persona/model support.
- Store per-output tag choices in persisted session metadata near the output
  state.
- Support shared workspace tag libraries and personal user-level tag libraries.
- Treat markdown frontmatter `tags` as descriptive output metadata, not the
  source of truth.
- Workspace default tags are additive and always apply to generated markdown
  output.
- Workspace tag suggestions are UI-only and do not write unless selected or
  promoted to default tags.
- User-level tag libraries are suggestions by default and do not write unless
  selected for an output.
- Web post-start tag edits are in scope.
- In-chat post-start tag edits are optional for the first implementation slice.
- Do not rewrite historical body content when tags change; only frontmatter may
  be updated.

## Contract Changes

- Workspace config
  - add optional `defaultTags?: string[]`;
  - add optional `tagSuggestions?: string[]`;
  - validate unknown keys fail-closed, matching current workspace config
    behavior.
- User config
  - add optional user-level tag library fields, likely requiring a `UserConfig`
    schema migration;
  - support global tag suggestions and optionally per-workspace personal tag
    suggestions;
  - do not automatically write user-level tags unless a later explicit default
    mechanism is added.
- `SessionWorkspaceOutputStateV1`
  - add optional persisted output metadata, for example
    `outputMetadata?: { tags?: string[] }`;
  - if persona support also adds `outputMetadata`, use one shared container
    rather than competing fields.
- Effective output tags resolve as:
  - workspace default tags from the current workspace profile, when available;
  - otherwise any persisted workspace-default snapshot needed for re-arm;
  - plus persisted per-output tags;
  - deduped in stable order.
- Tag suggestions shown in UI resolve as:
  - workspace tag suggestions;
  - user global tag library;
  - user per-workspace tag library;
  - existing output tags;
  - deduped in stable order.
- Recording/web action inputs
  - accept optional per-output tags when creating a new capture or recording;
  - pass effective tags to markdown writer options.
- Markdown writer/pipeline
  - keep existing `frontmatterTags?: string[]` render behavior;
  - add or expose a path to merge tags into existing frontmatter without
    appending conversation events.
- Web mutation handlers
  - update per-output tags on selected `workspaceOutputs[]` entries;
  - save session metadata;
  - best-effort update markdown frontmatter immediately when applicable.
- CLI/Web management
  - add CLI commands for shared workspace tag libraries and user-level tag
    libraries;
  - expose shared workspace tag libraries through the workspace edit surface;
  - expose personal tag libraries through user settings rather than
    `/workspaces`.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| New web recording with selected tags | Yes | Not applicable | Yes | Persist output tags and write effective tags to the new markdown frontmatter. |
| New in-chat recording with workspace default tags | Yes | Yes | Yes | Defaults should apply even without explicit output tags. |
| New web recording with user-level suggested tags not selected | Yes | Not applicable | Yes | Suggestions alone must not write personal tags to output files. |
| Active output tag edit from web | Yes | Not applicable | Yes | Persist metadata and update frontmatter immediately when possible. |
| Stopped output tag edit from web | Yes | Not applicable | Yes | Tags should apply when output is re-armed/restarted. |
| Workspace default tags change after output creation | Yes | Yes | Mostly | Future effective tags should use current workspace defaults when the workspace exists; persisted per-output tags remain. |
| Markdown frontmatter disabled or unavailable | Yes | Yes | Yes | Runtime behavior comes from metadata; frontmatter update can be skipped. |
| In-chat tag mutation command | Yes | Yes | Yes | Only applies if included; command should mutate metadata/frontmatter without being recorded as prose. |

## Testing

- Workspace registry tests:
  - parse `defaultTags` and `tagSuggestions`;
  - normalize and dedupe tags;
  - reject invalid schema shapes and non-string tag values.
- User config tests:
  - parse user-level tag libraries;
  - normalize and dedupe tags;
  - verify suggestions do not become automatic defaults.
- Contract/session-state tests:
  - accept metadata with and without `outputMetadata.tags`;
  - reject malformed tag metadata.
- Effective tag resolver tests:
  - merge workspace defaults and per-output tags in stable order;
  - preserve output tags when workspace defaults change.
- Suggestion resolver tests:
  - merge workspace suggestions, user suggestions, and output tags;
  - avoid writing suggestion-only tags.
- Recording pipeline/writer tests:
  - new markdown renders effective tags;
  - appends accretively merge tags;
  - tag-only frontmatter mutation updates an existing markdown file.
- Web action tests:
  - new capture/recording accepts selected tags;
  - active and stopped output tag edits persist;
  - frontmatter updates immediately when markdown is available.
- Runtime tests:
  - active persisted appends keep effective tags;
  - re-armed output keeps per-output tags.
- Validation:
  - run focused tests first;
  - run `deno task check` for contract changes;
  - run `deno task ci` before PR.

## Non-Goals

- No persona detection or model frontmatter changes; see
  [[task.2026.2026-05-28-persona-support]].
- No historical body rewrite.
- No automatic hashtag extraction from arbitrary message content.
- No network-backed tag lookup.
- No import-from-frontmatter behavior.
- No full taxonomy manager in the first slice.

## Implementation Plan

- [ ] Add workspace config fields for `defaultTags` and `tagSuggestions`.
- [ ] Add user config fields for personal tag libraries and migration behavior.
- [ ] Add CLI/user-settings management for personal tag libraries.
- [ ] Add shared workspace tag library management through the workspace config
      edit surface once [[task.2026.2026-06-11-workspace-config-editing]]
      exists.
- [ ] Add shared tag validation/normalization helpers.
- [ ] Add persisted per-output tag metadata to session contracts and
      validation.
- [ ] Add an effective tag resolver for workspace defaults plus output tags.
- [ ] Add a tag suggestion resolver for workspace and user-level libraries.
- [ ] Wire effective tags into web-created capture/recording actions.
- [ ] Wire effective tags into daemon in-chat capture/record flows.
- [ ] Add a writer/pipeline helper for tag-only markdown frontmatter mutation.
- [ ] Add web mutation handling for active and stopped output tag edits.
- [ ] Project tag fields into Sessions and Recordings row data.
- [ ] Add compact tag editing UI with workspace suggestions.
- [ ] Decide whether to include an in-chat tag mutation command; implement it
      if included.
- [ ] Add focused registry, contract, writer, runtime, loader, and web tests.
- [ ] Update developer/user documentation after behavior is implemented.
