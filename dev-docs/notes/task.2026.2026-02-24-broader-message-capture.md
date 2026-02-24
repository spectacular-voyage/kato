---
id: 935m43z3ky96juqvoqg784l
title: 2026 02 24 Broader Message Capture
desc: ''
updated: 1771962989570
created: 1771962097749
---
# Event-Native Conversation Schema With First-Class Decisions

## Summary
Refactor conversation capture to an event-native model now (no backward-compat requirement), so decisions, commentary, tool activity, and provider metadata are captured as typed records instead of being squeezed into message text. Keep markdown as the default export view, add NDJSON (`jsonl`) as the first structured export format, and make provider-specific “system/info” visibility flag-controlled at export/render time.

## Public API / Contract Changes
1. Replace `Message`-centric canonical contracts with event-centric contracts in `shared/src/contracts`.
2. Add `ConversationEvent` and `ConversationEventKind`:
3. `message.user`
4. `message.assistant`
5. `message.system`
6. `tool.call`
7. `tool.result`
8. `thinking`
9. `decision`
10. `provider.info`
11. Add `DecisionPayload`:
12. `decisionId`, `decisionKey`, `summary`, `status`, `decidedBy`, `basisEventIds`, `metadata`.
13. Add `conversationSchemaVersion: 2` in runtime metadata contract.
14. Keep markdown export as CLI default; add `--format ndjson` (and explicit `--format markdown`).
15. Add feature flag `captureIncludeSystemEvents` controlling rendering/export inclusion of `message.system` and `provider.info`.

## Canonical Event Shape
1. Base fields:
2. `eventId`, `provider`, `sessionId`, `timestamp`, `kind`, `turnId?`, `source`.
3. `source` includes provider-native identity fields (`providerEventType`, `providerEventId?`, `rawCursor?`).
4. Payload fields by kind:
5. `message.*`: `role`, `content`, `model?`, `phase?` (`commentary|final|other`).
6. `tool.call`: `toolCallId`, `name`, `description?`, `input?`.
7. `tool.result`: `toolCallId`, `result`.
8. `thinking`: `content`.
9. `decision`: `decisionId`, `decisionKey`, `summary`, `status` (`proposed|accepted|rejected|superseded`), `decidedBy`, `basisEventIds`, `metadata`.
10. `provider.info`: `content`, `subtype?`, `level?`.

## Parser/Provider Rules
1. Codex parser:
2. Capture `response_item.message` for both `phase: commentary` and `phase: final_answer`.
3. Capture `request_user_input` as:
4. `tool.call` event for questionnaire prompt.
5. `tool.result` event for raw tool output.
6. `message.user` event synthesized from chosen answers.
7. `decision` event per answered decision question (`status=accepted`, `decidedBy=user`).
8. Keep `event_msg.agent_message`/`task_complete` only as fallback when structured response items are absent.
9. Claude parser:
10. Emit `message.user`, `message.assistant`, `thinking`, `tool.call`, `tool.result`.
11. Map Claude `type: system` to `provider.info` events.
12. Gemini mapping contract (foundation only, no runner implementation in this task):
13. `user` -> `message.user` (prefer `displayContent`, fallback normalized `content`).
14. `gemini` -> `message.assistant` + `thinking` + `tool.call`/`tool.result`.
15. `info` -> `provider.info`.

## Runtime/Storage Refactor
1. Replace `RuntimeSessionSnapshot.messages` with `RuntimeSessionSnapshot.events`.
2. Change ingestion parser interface to return `{ event, cursor }` where cursor is provider-native (`byte-offset`, `item-index`, etc.).
3. Replace message dedupe signature with event dedupe signature including `kind` + canonicalized payload + timestamp/source identifiers.
4. Update in-chat command detection to read only `message.user` events from snapshots.
5. Update recording pipeline inputs from `Message[]` to `ConversationEvent[]`.
6. Build markdown rendering as a projection from events, not from canonical storage objects.

## Export / Writer
1. Add NDJSON writer that emits one canonical `ConversationEvent` JSON object per line.
2. Add `export --format ndjson|markdown`.
3. Keep default `export` behavior as markdown.
4. Markdown renderer rules:
5. Include `tool.*` and `thinking` details as collapsible sections.
6. Include `decision` events as explicit “Decision” blocks.
7. Include `message.system`/`provider.info` only when `captureIncludeSystemEvents=true`.

## CLI / Config
1. Extend CLI parser to accept `kato export <session-id> [--output <path>] [--format markdown|ndjson]`.
2. Extend runtime config feature flags with `captureIncludeSystemEvents`.
3. Wire feature flag evaluation through daemon runtime and writer/export paths.

## Tests
1. Contract tests:
2. Validate event schema, decision payload shape, and `conversationSchemaVersion: 2`.
3. Codex parser tests:
4. Commentary capture.
5. Questionnaire answer capture as `message.user` + `decision`.
6. Fallback behavior without duplication.
7. Claude parser tests:
8. `provider.info` emission from system events.
9. Thinking/tool linkage remains intact.
10. Ingestion/runtime tests:
11. Event dedupe correctness across revised signatures.
12. In-chat command detection still works via `message.user` events.
13. Export tests:
14. Markdown default unchanged for normal workflow.
15. NDJSON format emits typed events including decision events.
16. Feature flag tests:
17. System/info visibility toggles rendering/export inclusion, not ingestion fidelity.

## Rollout Sequence
1. Land schema/contracts + snapshot store refactor.
2. Migrate Codex parser to event output including decision events.
3. Migrate Claude parser to event output.
4. Migrate runtime command detection + recording pipeline to event inputs.
5. Add NDJSON writer and export format flag.
6. Update docs and task notes.
7. Start Gemini provider task using this event model directly.

## Assumptions And Defaults
1. Backward compatibility with old message-only internal schema is not required.
2. Canonical storage is event-native, not message-native.
3. Decisions are first-class events.
4. Structured export priority is NDJSON (`jsonl`).
5. Markdown remains the default human-facing export format.
6. Non-dialogue provider events are captured canonically and shown conditionally via feature flag.
7. Gemini runner implementation remains a separate follow-on task, built on this schema.
