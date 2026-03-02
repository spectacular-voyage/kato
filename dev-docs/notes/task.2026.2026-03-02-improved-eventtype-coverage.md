---
id: p4w97s9wnrwnyvimlwhre6k
title: 2026 03 02 Improved Eventtype Coverage
desc: ''
updated: 1772483147269
created: 1772483142383
---

# Plan: Clean Questionnaire Rendering in Captured Markdown

## Summary
Adjust markdown rendering so questionnaire-style decisions are concise and non-duplicative:
1. Remove empty `Tool-request_user_input` (and equivalent questionnaire tool) headings.
2. Keep two decision blocks (`proposed` and `accepted`), but avoid repeating `## Prompt` and `## Options` in the accepted block when they were already rendered in the proposed block.

This targets the behavior seen in [conv.2026.2026-03-02_1209-for-the-output-of-tool-calls-i-m-currently-seeing-codex.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-03-02_1209-for-the-output-of-tool-calls-i-m-currently-seeing-codex.md).

## Implementation Changes
1. Update questionnaire tool-call rendering in [markdown_writer.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/writer/markdown_writer.ts).
- Add logic to identify questionnaire tool calls (`request_user_input`, `AskUserQuestion`).
- Suppress rendering of questionnaire tool-call headings when:
  - The tool call has no meaningful body text (`description` empty), and
  - Corresponding questionnaire decision events are present in the same render pass.
- Keep existing rendering behavior for non-questionnaire tool calls.

2. Update questionnaire decision dedupe behavior in [markdown_writer.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/writer/markdown_writer.ts).
- Extend the existing questionnaire context map to track whether prompt/options were already rendered for a decision context key.
- For `proposed` questionnaire decisions:
  - Render `## Prompt` and `## Options` normally (subject to feature flags).
  - Mark prompt/options as rendered for that context key.
- For `accepted` questionnaire decisions:
  - If prompt/options were already rendered earlier for that context key in the same render pass, render only `## User Selection`.
  - If no prior rendered context exists, render prompt/options/selection as today (subject to feature flags).
- Keep current key matching strategy (`decisionKey`, `providerQuestionId`, normalized prompt text).

3. Keep parser behavior unchanged.
- No provider parser changes are required in:
  - [codex/parser.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/providers/codex/parser.ts)
  - [claude/parser.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/providers/claude/parser.ts)

## Tests and Scenarios
1. Add a regression test in [writer-markdown_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/writer-markdown_test.ts):
- Input: `tool.call` = `request_user_input` + matching proposed/accepted questionnaire decisions.
- Assert: no `# ..._Tool-request_user_input` section is rendered.

2. Add a regression test for duplicate suppression:
- Input: proposed + accepted questionnaire decisions with same decision context.
- Assert:
  - Proposed block contains `## Prompt` and `## Options`.
  - Accepted block contains `## User Selection`.
  - Prompt/options appear only once in the rendered output.

3. Keep/adjust accepted-only test:
- Input: accepted questionnaire decision without prior proposed context.
- Assert: accepted block still includes prompt/options/selection (no regression).

4. Run targeted test file:
- `deno test -A tests/writer-markdown_test.ts`

## API/Interface Impact
- No public API/type changes.
- Behavior-only change in markdown rendering output.

## Assumptions and Defaults
- Scope is rendering only; no ingestion/parser changes.
- Prompt/options dedupe is per render pass (single `renderEventsToMarkdown` call), which matches capture generation and current writer architecture.
- Selected default behavior from your choices:
  - Two decision blocks are retained.
  - Accepted block omits repeated prompt/options.
  - Empty questionnaire tool-call heading is hidden when decision blocks exist.

---

# Expansion: User Response Capture Completeness

## Why this is added
We want to guarantee that all user responses are captured reliably, including plain user messages and questionnaire selections, without depending on timing quirks around `::capture-k`.

## Observed state
- The "PLEASE IMPLEMENT THIS PLAN" message is present in [conv.2026.2026-03-02_1209-for-the-output-of-tool-calls-i-m-currently-seeing-codex.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-03-02_1209-for-the-output-of-tool-calls-i-m-currently-seeing-codex.md) at `:1587`.
- The follow-up message is also present in the same file at `:1653`.
- This suggests we may be seeing a capture-window/timing issue in some runs rather than a permanent parse failure, but we should still harden event-type coverage and tests.

## Additional implementation scope
1. Add explicit user-message coverage checks in Codex ingestion/parser paths.
- Validate handling of `event_msg.user_message` payloads end to end.
- Validate `stripIdePreamble(...)` behavior does not erase legitimate user content.
- Validate long multi-line user messages are preserved.

2. Add explicit questionnaire answer coverage checks.
- Keep structured decision synthesis for `request_user_input` outputs.
- Ensure we preserve free-form answer text fallback as `message.user` when structured parsing fails.
- Ensure accepted decisions always keep selected answer text (`## User Selection`) in markdown output.

3. Add capture-timing resilience checks.
- Add a daemon/runtime test where a user message arrives immediately before `::capture-<alias>` and assert the message is included in captured output.
- Add a daemon/runtime test where a capture is triggered during rapid successive updates and assert no user message loss across appends.

## Additional test scenarios
1. Parser-level tests (`tests/codex-parser_test.ts`)
- `event_msg.user_message` with IDE preamble + real body: body is captured.
- Multi-line "implement plan" style user message: full text captured.
- `request_user_input` output with malformed JSON: fallback user message event is emitted.

2. Runtime/capture tests (`tests/daemon-runtime_test.ts`)
- Immediate-pre-capture user message is present in destination file.
- Rapid poll/update sequence does not drop newest user message.

3. End-to-end markdown snapshot checks (`tests/writer-markdown_test.ts` or runtime e2e capture tests)
- User narrative messages remain visible alongside decision sections.
- Questionnaire selections remain visible even when prompt/options dedupe is active.

## Acceptance criteria (expanded)
- No plain user message is silently dropped in capture output under normal polling cadence.
- Questionnaire selections are always represented in captured markdown.
- Timing-sensitive capture flows (message arrives just before capture) have deterministic passing tests.
