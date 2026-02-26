---
id: ru04o3780vg0ell7chui1e5
title: 2026 02 26 Decent Frontmatter
desc: ''
updated: 1772124160537
created: 1772122600275
---

## Goal

Generate richer, Dendron-compatible YAML frontmatter for markdown recordings
created from scratch, while keeping current write behavior safe and predictable.

## User Story

As a Dendron user, I want kato to generate useful frontmatter automatically so
new recording/export files are immediately searchable and organized without
manual cleanup.

## Why This Matters

- Current frontmatter is minimal and loses useful context (session identity,
  participants, event-kind tags).
- Writer call sites currently pass `sessionId` as title, which is low-signal for
  note workflows.
- We already persist enough metadata (session IDs, recording IDs, snippets,
  models) to generate a stronger frontmatter contract.

## Scope (This Task)

1. Keep Dendron-compatible baseline fields (`id`, `title`, `desc`, `created`,
   `updated`).
2. Improve creation-time `id` and `title` generation (snippet-driven).
3. Add optional richer frontmatter fields:
   - `participants`
   - `sessionId`
   - `recordingIds`
   - `tags`
4. Add runtime config controls for frontmatter behavior.
5. Wire runtime/orchestrator/pipeline paths so writer receives the metadata it
   needs.
6. Update tests/docs.

## Non-Goals

- Rewriting legacy frontmatter across existing files.
- Introducing a second markdown dialect or breaking current body rendering.
- Changing JSONL export schema.

## Decisions To Lock

### 1) Baseline Frontmatter Contract (Dendron-Compatible)

For newly created markdown files, emit:

```yaml
---
id: <computed-id>
title: '<computed-title>'
desc: ''
created: <epoch-ms>
updated: <epoch-ms> # optional; controlled by config
participants: [user.djradon, codex.gpt-5.3-codex]
sessionId: <session-id>
recordingIds: [<recording-id-1>, <recording-id-2>]
tags: [provider.codex, kind.message.user, kind.message.assistant]
---
```

Rules:

- `created` is always emitted at creation time.
- `updated` is emitted only when `includeUpdatedInFrontmatter=true`; when
  emitted on creation, set `updated=created`.
- After creation, kato does not mutate `updated` on append/overwrite writes
  (Dendron or other tools may update it externally).
- `desc` remains blank by default.
- New fields are omitted if no value is available.
- Arrays are serialized inline (single-line YAML arrays).

### 2) Title and ID Generation

- Title source priority:
  1. stable session snippet (first user message snippet)
  2. provided title override from call site
  3. provider session ID
  4. output filename stem
- ID format target:
  - `slugified-<title-or-snippet>-<sessionShortId>`
  - where `sessionShortId = sessionId.slice(0, 8)`
- Fallback when no session ID is available:
  - keep existing compact random suffix behavior.

### 3) Participants Field

- Assistant participants:
  - collect unique values in `provider.model` format from assistant events with
    known model.
  - fallback to `provider.assistant` when model is missing.
- User participant:
  - include only when `addParticipantUsernameToFrontmatter` is enabled.
  - username resolution priority:
    1. `defaultParticipantUsername` config
    2. env username (`USER`/`USERNAME`) when available
    3. home-directory basename (best effort)
- Output format:
  - strings like `user.djradon`, `codex.gpt-5.3-codex`, `claude.claude-3.7-sonnet`.

### 4) Tags / Conversation Kinds

- Always include `provider.<provider>`.
- If `includeConversationKinds` is true, include observed
  `ConversationEvent.kind` values as `kind.<value>`.
- Maintain deterministic order and de-duplicate.
- On writes to existing files, tags are accretive only: add missing tags but do
  not remove any existing tags.

### 5) Recording + Session Identity Fields

- Always include `sessionId` when known.
- `recordingIds` should include all known recording IDs mapped to this
  destination and be refreshed when writing to existing files.
- `recordingIds` updates are additive: preserve existing values and add newly
  observed IDs.

### 6) Config Contract

Add a new optional runtime config section:

```yaml
markdownFrontmatter:
  includeFrontmatterInMarkdownRecordings: true
  includeUpdatedInFrontmatter: false
  addParticipantUsernameToFrontmatter: false
  defaultParticipantUsername: ""
  includeConversationKinds: false
```

Defaults:

- `includeFrontmatterInMarkdownRecordings`: `true` (preserve current behavior)
- `includeUpdatedInFrontmatter`: `false`
- `addParticipantUsernameToFrontmatter`: `false`
- `defaultParticipantUsername`: `""`
- `includeConversationKinds`: `false`

Validation:

- Unknown keys inside `markdownFrontmatter` are rejected.
- Types are strict (`boolean`/`string`) like existing config validation.

### 7) Existing File Behavior

- If file already has frontmatter:
  - preserve existing `id`, `title`, `desc`, `created`, and `updated`.
  - update `recordingIds` and `tags` in-place using additive merge rules.
  - never remove existing tags.
- This task upgrades creation-time quality and selectively refreshes mutable
  metadata fields (`recordingIds`, `tags`) on subsequent writes.

## Implementation Plan

1. Extend shared/runtime config contracts.

- `shared/src/contracts/config.ts`
  - add `RuntimeMarkdownFrontmatterConfig` and optional
    `markdownFrontmatter?: RuntimeMarkdownFrontmatterConfig` on `RuntimeConfig`.
- `apps/daemon/src/config/runtime_config.ts`
  - parse defaults + strict validation for `markdownFrontmatter`.
  - include it in clone/default config generation.

2. Extend writer frontmatter model.

- `apps/daemon/src/writer/frontmatter.ts`
  - expand renderer input to support:
    - `sessionId`
    - `recordingIds`
    - `participants`
    - `tags`
    - deterministic ID generation with optional session short ID.
- keep YAML-safe quoting and inline array rendering.
- add merge/update helpers for existing frontmatter so `recordingIds`/`tags` can
  be accretively refreshed.

3. Thread frontmatter metadata through write pipeline.

- `apps/daemon/src/writer/markdown_writer.ts`
  - accept richer frontmatter options.
  - respect `includeFrontmatterInMarkdownRecordings`.
  - preserve baseline fields on existing files while accretively updating
    `recordingIds` and `tags`.
- `apps/daemon/src/writer/recording_pipeline.ts`
  - carry frontmatter context from orchestrator to writer options.
- `apps/daemon/src/orchestrator/daemon_runtime.ts`
  - use snippet-based title (not raw `sessionId`).
  - provide session/recording/provider/event metadata for frontmatter fields.

4. Update docs and examples.

- `README.md`
  - runtime config example includes `markdownFrontmatter`.
  - frontmatter behavior note for markdown output.

5. Update tests.

- `tests/writer-markdown_test.ts`
  - creation path emits new fields when provided.
  - arrays are single-line.
  - ID format uses snippet + session short ID.
  - `includeFrontmatterInMarkdownRecordings=false` omits frontmatter.
  - `includeUpdatedInFrontmatter=false` omits `updated`.
  - append/overwrite to existing files accretively updates `recordingIds` and
    tags without removing existing tags.
- `tests/runtime-config_test.ts`
  - parse defaults for missing `markdownFrontmatter`.
  - reject unknown/invalid `markdownFrontmatter` keys/types.

## Testing Plan

- Unit:
  - frontmatter rendering contract (field presence/omission/order/quoting).
  - participant/tag derivation and dedupe.
  - existing-frontmatter merge behavior for accretive `recordingIds`/`tags`.
- Integration:
  - `record`, `capture`, and `export` create markdown with snippet-based title.
  - existing file writes refresh `recordingIds`/`tags` without touching baseline
    Dendron fields.
- Regression:
  - existing markdown writer tests continue to pass.
  - runtime config loading still fail-closed and backward-compatible.

## Acceptance Criteria

- New markdown files have Dendron-compatible fields plus richer metadata fields.
- `id` prefers `slugified-snippet-sessionShortId` when session ID is available.
- `title` uses conversation snippet instead of opaque session ID.
- `participants`, `sessionId`, `recordingIds`, and `tags` are emitted when data
  is available.
- `updated` is omitted by default and only emitted when
  `includeUpdatedInFrontmatter=true`.
- existing-file writes accretively update `recordingIds` and `tags` and never
  remove tags.
- Config flags control behavior exactly as specified.
- Docs/tests updated and passing.

## Risks And Mitigations

- Risk: username inference can be wrong.
  - Mitigation: username emission is opt-in and overrideable in config.
- Risk: frontmatter grows noisy with event-kind tags.
  - Mitigation: `includeConversationKinds` default is `false`.
- Risk: in-place frontmatter updates could clobber user formatting.
  - Mitigation: limit mutations to targeted keys (`recordingIds`, `tags`) and
    preserve other keys/values untouched.
- Risk: ID collisions across files from same session/snippet.
  - Mitigation: keep fallback random ID path when needed and retain current
    preserve behavior for existing files.
