---
id: l52kqfdduulps8khjp1d7r6
title: 2026 05 28 Persona Support
desc: ''
updated: 1781187417804
created: 1780029060020
---

## Goal

- Support output-scoped persona/participant metadata for captures and
  recordings.
- If the first meaningful user line for a capture/recording starts with a
  configured persona prefix like `jimbo:`, Kato can use `jimbo` as the
  output persona label for frontmatter, `{username}` filename templates, and
  eligible turn headings.
- Split assistant model provenance out of `participants` so frontmatter
  participants remain human/persona labels, while model identifiers live in a
  dedicated `models` field.
- Build on the shared session/output metadata layer in
  [[task.2026.2026-06-11-session-output-metadata]].

## Summary

- Current code already has most of the lower-level plumbing:
  - `{username}` is available to `filenameTemplate` and `defaultOutputDir`.
  - markdown frontmatter already supports `participants`; existing `tags`
    support is handled in [[task.2026.2026-06-11-output-tagging]].
  - `MarkdownSpeakerNames.user` can make user turn headings use a configured
    username.
  - recording pipeline currently derives assistant model labels like
    `codex.gpt-5.3-codex` and stores them in `participants`.
- Recommended first implementation slice:
  - use the shared output metadata container from
    [[task.2026.2026-06-11-session-output-metadata]],
  - introduce a persona metadata resolver,
  - parse configured `persona-name:` line prefixes into an output-scoped
    persona override,
  - move assistant model identifiers to a plural `models` frontmatter field,
  - keep command path arguments unchanged.
- Recommended second slice:
  - add shared persona definitions to workspace config,
  - add personal persona definitions to user config,
  - add a web pre-edit flow for New Capture/New Recording,
  - persist resolved output metadata with workspace output state so future
    appends and re-arms keep the same metadata.
- Tagging is split into [[task.2026.2026-06-11-output-tagging]]. The output
  metadata persistence shape should come from
  [[task.2026.2026-06-11-session-output-metadata]] so persona metadata, tags,
  and writer-policy overrides do not become three unrelated mechanisms.
- Shared workspace persona editing should build on
  [[task.2026.2026-06-11-workspace-config-editing]] rather than adding another
  custom mutation surface. Personal persona editing belongs on `/settings` and
  in user-level CLI commands.

Current model handling:

- Provider parsers populate `ConversationEvent.model` when source transcripts
  expose it, but provider behavior is not uniform today.
- Claude and Gemini read model metadata from each assistant/model message, so
  those providers can represent a mid-conversation model change if the source
  transcript records one.
- Codex currently stores the first `turn_context.model` it sees and reuses it
  for later assistant events, so Codex mid-conversation model switches are not
  currently detected.
- Markdown assistant message headings currently use the assistant event's
  model if present, falling back to the configured assistant speaker name or
  `Assistant`.
- Tool-call headings use the latest assistant model seen by the writer, and
  keep that model for later tool calls when intermediate assistant events omit
  a model.
- Recording frontmatter currently derives model-like participant entries such
  as `codex.gpt-5.3-codex` from assistant events. Appends accretively merge
  those values into existing frontmatter, so mid-recording model changes can
  accumulate over time.
- There is no separate "model switch" detector today. Kato reacts to the
  model field present on each assistant event. Consecutive assistant events
  with different models may not visibly create separate markdown headings if
  the writer suppresses a repeated assistant heading.

## Discussion

- Do not overload command arguments with persona metadata. Command arguments
  remain filesystem destinations.
- The persona extraction point should be capture-boundary aware:
  - For in-chat recording/capture, inspect the first non-empty, non-control
    user-content line in the command segment. If the command line itself is
    the only line, fall back to the first captured user line in the snapshot.
  - For web-created capture/recording, inspect the first user message in the
    session history unless the pre-edit form supplies an explicit override.
  - Never inspect assistant/tool/system content for persona prefixes.
- Suggested persona grammar:
  - line starts with `persona-name:` where `persona-name` is a configured
    workspace persona key;
  - persona keys use letters, numbers, dot, underscore, or hyphen;
  - store the configured canonical persona name, not arbitrary text from the
    prompt;
  - normalize with the existing participant username validation rules;
  - do not treat a later inline `persona-name:` occurrence as metadata.
- Workspace-config gating is important. Without it, ordinary prose labels like
  `note:`, `todo:`, or `summary:` would be easy false positives.
- Persona detection should use both shared workspace personas and personal
  user-level personas:
  - workspace personas live in shared `.kato-workspace-config.yaml` and are
    appropriate for project/team vocabulary;
  - user personas live in `kato-user-config.yaml` and are appropriate for
    private aliases, recurring collaborators, or personal model-persona
    shorthand;
  - personal personas should not mutate shared workspace config.
- The current `participantUsername` naming is slightly awkward for persona
  support. If `jimbo:` means "the assistant/persona I am addressing" rather
  than "the human speaker", routing it through the same setting that labels
  user turns can produce incorrect headings. Prefer an output metadata shape
  that can distinguish:
  - human/user participant label,
  - assistant/persona display label,
  - assistant model provenance.
- Model provenance should be plural. A capture can include multiple assistant
  models over time or across appended recording cycles, so a scalar `model`
  field is too lossy.
- Heading behavior should be conditional:
  - if no persona is detected, keep current model-only assistant headings;
  - if a persona is detected, render assistant/tool headings as
    `persona_model_timestamp`, for example `jimbo_gpt-5.5_2026-05-11_1623_16`;
  - if a persona is detected but no model is available, render
    `persona_timestamp`.
- Persona prefixes should probably be stripped from the recorded user content
  once they are recognized as metadata. For `jimbo: test this`, the written
  user message would be `test this`.
- Frontmatter should remain accretive for append flows. Existing files with
  old model-derived `participants` should not be rewritten in place unless a
  later migration task explicitly takes that on.
- Web pre-edit should be output-scoped. Editing the New Capture/New Recording
  popover should not mutate `kato-user-config.yaml` or the workspace config
  unless the user performs a separate explicit settings action.
- Like [[task.2026.2026-05-11-per-output-writer-controls]], persisted output
  metadata should be authoritative for live Kato behavior. The shared
  persistence/mutation substrate is covered by
  [[task.2026.2026-06-11-session-output-metadata]]. Markdown
  frontmatter is useful descriptive metadata, but it should not become the
  source of truth for active recordings or future re-arms.

## Open Issues

- Should persona keys be case-sensitive? Recommendation: match
  case-insensitively, then store the canonical configured key/display name.
- Should a persona prefix name the assistant/persona only, or should it also
  replace the user-facing `{username}` token? Recommendation: use it for
  `{username}` because that matches the desired filename behavior, but keep the
  internal metadata fields distinct.
- Should an explicit persona prefix bypass
  `excludeMeFromParticipantList`? Recommendation: yes, because an explicit
  output persona is not the same thing as automatically adding the user's
  persistent personal username.
- Should the `persona-name:` prefix be removed from written markdown?
  Recommendation: strip only the prefix and preserve the rest of the line.
- Should persona metadata live in a shared `outputMetadata` container also
  used by [[task.2026.2026-06-11-output-tagging]], or should personas get a
  narrower field on `workspaceOutputs[]`? Recommendation: shared container,
  because the per-output writer-controls task already establishes the pattern
  of keeping output-specific choices close to the output state.
- Should user-level personas be global only, per-workspace only, or both?
  Recommendation: both, with per-workspace user personas winning over global
  user personas for detection/display.

## Decisions

- Command path arguments remain filesystem paths; persona prefixes are parsed
  from user message content, not from path arguments.
- Persona auto-detection is workspace-config-gated. A line like `jimbo: test
  this` only becomes persona metadata when `jimbo` is a defined workspace or
  user persona.
- Support shared workspace personas and personal user-level personas. Do not
  store personal persona definitions in shared workspace config.
- Store assistant model provenance in a dedicated plural frontmatter field
  named `models`, rather than in `participants`.
- Depend on [[task.2026.2026-06-11-session-output-metadata]] for the
  persisted output metadata container and generic mutation path.
- Treat frontmatter `participants` as human/persona labels only. If a persona
  is detected, list the persona there instead of the model name.
- Keep persona-derived metadata output-scoped; do not persist it to user config
  as a new default username.
- Headings include both persona and model only when a persona was detected.
  Without a persona, keep the current model-only assistant heading behavior.
- Tag defaults, tag suggestions, and post-start tag edits are out of scope for
  this task and are covered by [[task.2026.2026-06-11-output-tagging]].
- Do not migrate existing markdown files in place as part of the first
  implementation.

Superseded decisions from the earlier sketch:

- Mention-style `@name` detection is superseded by configured
  `persona-name:` prefix detection.
- The proposed `assistantModels` field name is superseded by `models`.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| In-chat record starts with configured `jimbo:` persona prefix | Yes | Yes | Yes | Both flows should persist the resolved persona and use it for frontmatter, filename tokens, and future appends. |
| In-chat capture starts with configured `jimbo:` persona prefix | Yes | Yes | Yes | Snapshot title/snippet extraction should use content after stripping the persona prefix. |
| In-chat record/capture starts with unconfigured `note:` prefix | Yes | Yes | Yes | Treat as normal user content; no persona metadata. |
| Assistant model changes during an active recording | Yes | Yes | Yes | Append new model to `models` frontmatter and use the event model in headings when a heading is emitted. |
| Output is re-armed after daemon restart | Yes | Not applicable | Yes | Persisted persona metadata should survive and continue to shape frontmatter, filename tokens, and headings. |

## Contract Changes

- `MarkdownRenderOptions`
  - add `frontmatterModels?: string[]`;
  - continue using existing `frontmatterParticipants?: string[]`;
  - leave existing `frontmatterTags?: string[]` behavior unchanged in this
    task.
- `renderFrontmatter` / `mergeAccretiveFrontmatterFields`
  - render and accretively merge `models`;
  - keep `participants`, `tags`, Kato ids, and `conversationEventKinds`
    behavior stable.
- `RecordingOutputOverrides`
  - keep or replace `participantUsername?: string` for resolved output-scoped
    labels after naming is settled;
  - add `personaName?: string` or an equivalent field distinct from the human
    user speaker name;
- `RecordingPipeline`
  - stop adding provider/model identifiers to `frontmatterParticipants`;
  - derive sorted model labels from assistant events and pass them as
    `frontmatterModels`;
- `SessionWorkspaceOutputStateV1`
  - use the shared `outputMetadata` container from
    [[task.2026.2026-06-11-session-output-metadata]];
  - persona support owns the meaning of `personaName` and
    `participantUsername`, but not the generic persistence/mutation mechanism.
- Workspace config
  - add optional persona definitions, for example
    `personas: { jimbo: { displayName?: string } }`;
  - validate unknown keys fail-closed, matching current workspace config
    behavior.
- User config
  - add optional user-level persona definitions, likely requiring a
    `UserConfig` schema migration;
  - support global personas and optionally per-workspace persona overrides;
  - keep personal persona libraries out of shared workspace files.
- CLI/Web management
  - add CLI commands for shared workspace personas and user-level personas;
  - expose shared workspace persona editing through the workspace edit surface;
  - extend `/settings` to edit personal persona names/libraries rather than
    `/workspaces`.
- Web session actions
  - accept optional output metadata from New Capture/New Recording pre-edit;
  - coordinate title, filename slug, and any optional filename/path override with [[task.2026.2026-06-28-output-filename-title-overrides]] rather than defining those controls inside persona support.
- Filename rendering
  - resolve `{username}` from output persona metadata first, then existing
    workspace/default username behavior, then `unknown-user`.
- Markdown heading rendering
  - if persona metadata is present for an output, combine persona and model in
    assistant/tool headings;
  - otherwise preserve current model-only assistant/tool heading behavior.

## Testing

- Persona parser/resolver tests:
  - extracts `jimbo:` from the first meaningful user line only when `jimbo` is
    configured in workspace or user personas;
  - ignores unconfigured prefixes and later inline occurrences;
  - applies the chosen workspace/user/global precedence rules;
  - rejects empty/invalid/control-character usernames;
  - does not treat command path arguments as persona metadata;
  - strips the recognized prefix from recorded content if that behavior is
    accepted.
- Workspace path tests:
  - `{username}` uses the output-scoped persona override;
  - default behavior still falls back through workspace username, default
    username, and `unknown-user`.
- Writer tests:
  - new markdown renders `participants` and `models`;
  - append flow accretively merges `models`;
  - existing model-like `participants` are preserved but not newly generated.
- Recording pipeline tests:
  - assistant model identifiers move from `frontmatterParticipants` to
    `frontmatterModels`;
  - participant/persona override precedence is deterministic.
- Daemon runtime tests:
  - in-chat capture/record extracts configured `jimbo:` from the command
    segment;
  - persona prefix stripping, if implemented, does not disturb command
    cursor boundaries;
  - persisted workspace output metadata survives future appends;
  - mid-recording model changes append to `models` frontmatter.
- Web action tests:
  - New Capture/New Recording form metadata reaches filename rendering,
    frontmatter, and persisted output state;
  - explicit pre-edit values override extracted personas;
  - `/settings` can add, update, and remove user-level persona names.
- Workspace registry tests:
  - persona definitions parse, normalize, dedupe, and reject invalid schema
    shapes.
- User config tests:
  - user-level persona definitions parse, normalize, dedupe, and reject invalid
    schema shapes;
  - migration/compatibility behavior is explicit.
- Validation:
  - run focused tests while implementing;
  - run `deno task check` for contract changes;
  - run `deno task ci` before PR.

## Non-Goals

- Provider-side persona switching or prompt injection.
- Retroactively rewriting existing markdown files to remove model identifiers
  from `participants`.
- Network-backed persona lookup.
- Changing source provider transcripts or twin event history.
- Replacing the existing user config workflow for persistent personal
  username settings.

## Implementation Plan

- [ ] Land [[task.2026.2026-06-11-session-output-metadata]] or enough of its
      shared output metadata contract to avoid adding persona-specific
      persistence plumbing.
- [ ] Add workspace-config persona definitions.
- [ ] Add user-config persona definitions and migration behavior.
- [ ] Extend `/settings` with user-level persona name/library management.
- [ ] Add CLI management for personal persona definitions.
- [ ] Add shared workspace persona management through the workspace config edit
      surface once [[task.2026.2026-06-11-workspace-config-editing]] exists.
- [ ] Add a small output metadata resolver module for persona-prefix
      extraction, precedence, and normalization.
- [ ] Add failing unit tests for configured `jimbo:` persona extraction and
      `{username}` template precedence.
- [ ] Add `models` support to frontmatter rendering and accretive
      merging.
- [ ] Update `RecordingPipeline` so assistant model identifiers move out of
      `participants` and into `models`.
- [ ] Update markdown heading rendering so detected persona outputs render
      persona-plus-model headings while non-persona outputs keep current
      model-only headings.
- [ ] Persist resolved persona metadata through the shared output metadata
      container and use it when appending to active persisted outputs.
- [ ] Wire persona extraction into persistent in-chat record/capture flows.
- [ ] Wire persona extraction into live/session-state in-chat record/capture
      flows.
- [ ] Add web New Capture/New Recording pre-edit fields for persona/participant, coordinating title and filename controls with [[task.2026.2026-06-28-output-filename-title-overrides]].
- [ ] Update Sessions/Recordings UI view models as needed to show persisted
      output metadata without crowding the rows.
- [ ] Update developer docs and release notes once behavior is implemented.
- [ ] Run focused tests, then `deno task check`, then `deno task ci`.
