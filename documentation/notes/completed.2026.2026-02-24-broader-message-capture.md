---
id: 935m43z3ky96juqvoqg784l
title: 2026 02 24 Broader Message Capture
desc: ''
updated: 1771962989570
created: 1771962097749
---
# Event-Native Conversation Schema With First-Class Decisions

## Summary

Refactor conversation capture to an event-native model now (no backward-compat requirement), so decisions, commentary, tool activity, and provider metadata are captured as typed records instead of being squeezed into message text.

Keep markdown as the default export view, add JSONL as the first structured export format, and make provider-specific system/info visibility flag-controlled at export/render time.

## Feedback Incorporated (Gemini Review)

1. Schema v2 startup behavior is explicitly fail-closed with actionable remediation.
2. Event dedupe signature explicitly includes `kind`, with cross-kind collision tests.
3. Structured export terminology and CLI format key use `jsonl` for repo consistency.
4. New raw parser fixtures must live under `tests/fixtures/` (not inline blobs).
5. New feature flag `captureIncludeSystemEvents` is explicitly wired into:
   - `shared/src/contracts/config.ts` (`RuntimeFeatureFlags`)
   - `apps/daemon/src/config/runtime_config.ts` (known/validated feature keys)
   - `apps/daemon/src/feature_flags/openfeature.ts` (defaults + evaluation)

## Rollout Sequence

- [x] Land schema/contracts + snapshot store refactor.
- [x] Migrate Codex parser to event output including decision events.
- [x] Migrate Claude parser to event output.
- [x] Migrate runtime command detection + recording pipeline to event inputs.
- [x] Add JSONL writer and export format flag.
- [x] Update docs and task notes.
- [ ] Start Gemini provider task using this event model directly.

## Public API / Contract Changes

- [x] Replace `Message`-centric canonical contracts with event-centric contracts in `shared/src/contracts`.
- [x] Add `ConversationEvent` and `ConversationEventKind`: `message.user`, `message.assistant`, `message.system`, `tool.call`, `tool.result`, `thinking`, `decision`, `provider.info`.
- [x] Add `DecisionPayload`: `decisionId`, `decisionKey`, `summary`, `status`, `decidedBy`, `basisEventIds`, `metadata`.
- [x] Add `conversationSchemaVersion: 2` in runtime metadata contract.
- [x] Keep markdown export as CLI default; add `--format jsonl` (and explicit `--format markdown`).
- [x] Add feature flag `captureIncludeSystemEvents` controlling rendering/export inclusion of `message.system` and `provider.info`.

## Canonical Event Shape

- [x] Base fields: `eventId`, `provider`, `sessionId`, `timestamp`, `kind`, `turnId?`, `source`.
- [x] `source` includes provider-native identity fields (`providerEventType`, `providerEventId?`, `rawCursor?`).
- [x] Payload fields by kind:
  - `message.*`: `role`, `content`, `model?`, `phase?` (`commentary|final|other`).
  - `tool.call`: `toolCallId`, `name`, `description?`, `input?`.
  - `tool.result`: `toolCallId`, `result`.
  - `thinking`: `content`.
  - `decision`: `decisionId`, `decisionKey`, `summary`, `status` (`proposed|accepted|rejected|superseded`), `decidedBy`, `basisEventIds`, `metadata`.
  - `provider.info`: `content`, `subtype?`, `level?`.

## Parser/Provider Rules

- [x] Codex parser:
  - [x] Capture `response_item.message` for both `phase: commentary` and `phase: final_answer`.
  - [x] Capture `request_user_input` as: `tool.call` + `tool.result` + `message.user` + `decision` events.
  - [x] Keep `event_msg.agent_message`/`task_complete` only as fallback when structured response items are absent.
- [x] Claude parser:
  - [x] Emit `message.user`, `message.assistant`, `thinking`, `tool.call`, `tool.result`.
  - [x] Map Claude `type: system` to `provider.info` events.
- [ ] Gemini mapping contract (foundation only, no runner implementation in this task):
  - `user` → `message.user` (prefer `displayContent`, fallback normalized `content`).
  - `gemini` → `message.assistant` + `thinking` + `tool.call`/`tool.result`.
  - `info` → `provider.info`.

## Schema v2 Startup Behavior

- [ ] Session/event snapshot loaders are fail-closed on incompatible schema.
  - *Note: In-memory snapshot store doesn't persist; fail-closed check deferred until persistence is added.*
- [x] `conversationSchemaVersion: 2` field stamped on every `RuntimeSessionSnapshot`.

## Runtime/Storage Refactor

- [x] Replace `RuntimeSessionSnapshot.messages` with `RuntimeSessionSnapshot.events`.
- [x] Change ingestion parser interface to return `{ event, cursor }` where cursor is provider-native.
- [x] Replace message dedupe signature with event dedupe signature including `kind`, canonicalized payload, and timestamp/source identifiers.
- [x] Explicitly prevent cross-kind dedupe collisions.
- [x] Update in-chat command detection to read only `message.user` events from snapshots.
- [x] Update recording pipeline inputs from `Message[]` to `ConversationEvent[]`.
- [x] Build markdown rendering as a projection from events, not from canonical storage objects.

## Export / Writer

- [x] Add JSONL writer that emits one canonical `ConversationEvent` JSON object per line.
- [x] Add `export --format jsonl|markdown`.
- [x] Keep default `export` behavior as markdown.
- [x] Markdown renderer rules:
  - [x] Include `tool.*` and `thinking` details as collapsible sections.
  - [x] Include `decision` events as explicit "Decision" blocks.
  - [x] Include `message.system`/`provider.info` only when `captureIncludeSystemEvents=true`.
  - [x] Queue-based tool result lookup supports same-`toolCallId` revisions.

## CLI / Config

- [x] Extend CLI parser to accept `kato export <session-id> [--output <path>] [--format markdown|jsonl]`.
- [x] Extend runtime config feature flags with `captureIncludeSystemEvents`.
- [x] Wire feature flag evaluation through daemon runtime and writer/export paths.

## Tests

- [x] Contract tests: validate event schema and `conversationSchemaVersion: 2`.
- [x] Codex parser tests: commentary capture, tool events, thinking, resume semantics.
- [x] Claude parser tests: `provider.info` emission, thinking/tool linkage, resume semantics.
- [x] Ingestion/runtime tests: event dedupe, `message.user`-only command detection.
- [x] Export tests: markdown default, JSONL format.
- [x] Feature flag tests: `captureIncludeSystemEvents` wired and evaluated.
- [ ] Questionnaire→decision fixture: add `request_user_input` fixture under `tests/fixtures/`.
- [ ] Cross-kind collision tests: explicit test asserting same-content/timestamp events of different kinds don't dedupe.

## Assumptions And Defaults

1. Backward compatibility with old message-only internal schema is not required.
2. Canonical storage is event-native, not message-native.
3. Decisions are first-class events.
4. Structured export priority is JSONL.
5. Markdown remains the default human-facing export format.
6. Non-dialogue provider events are captured canonically and shown conditionally via feature flag.
7. Gemini runner implementation remains a separate follow-on task, built on this schema.
