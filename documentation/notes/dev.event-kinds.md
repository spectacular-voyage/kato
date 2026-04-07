---
id: p1akcynjrpjltfj57e3ptd2
title: Event Kinds
desc: Canonical event taxonomy and provider-type mapping for session translation.
updated: 1772076304293
created: 1772076304293
---

## Purpose

Define kato's canonical `SessionTranslation` event kinds and map provider-specific source types (Claude/Codex/Gemini) into them.

This note tracks:

1. Canonical naming and actor model (`user.*`, `assistant.*`, plus provider/system kinds).
2. Correlation requirements (tool call/result, decision prompt/response).
3. Exhaustive provider-specific type inventory observed in current fixtures and parser branches.

## Canonical Kind Naming

### Recommendation

Use actor-prefixed names for interactive conversation flow:

- `user.message`
- `user.kato-command`
- `user.decision.response`
- `assistant.message`
- `assistant.thinking`
- `assistant.tool.call`
- `assistant.tool.result`
- `assistant.decision.prompt`

Keep these non-actor kinds for non-conversational metadata/fallbacks:

- `system.message`
- `provider.info`
- `provider.raw`

Rationale:

- Most content is user/assistant authored, so actor prefix improves readability.
- `provider.info` and `provider.raw` remain essential for provider-origin metadata and lossless fallback capture.

## Canonical SessionTranslationKinds (v1)

| Kind | Meaning | Typical Source |
| --- | --- | --- |
| `user.message` | User-authored conversational text | Claude user text, Codex `event_msg.user_message`, Gemini `messages[].type=user` |
| `user.kato-command` | Parsed in-chat kato command (`::start`, `::stop`, etc.) | Derived from `user.message` text lines |
| `user.decision.response` | User selection/answer to a prior decision prompt | Codex `request_user_input` answer payloads, Claude `toolUseResult.answers` |
| `assistant.message` | Assistant natural-language content | Claude assistant text, Codex commentary/final messages, Gemini `type=gemini` text |
| `assistant.thinking` | Assistant reasoning/thinking blocks | Claude `thinking`, Codex `response_item.reasoning`, Gemini `thoughts` |
| `assistant.tool.call` | Assistant-issued tool call | Claude `tool_use`, Codex `response_item.function_call`, Gemini `toolCalls[]` |
| `assistant.tool.result` | Result payload for assistant tool call | Claude `tool_result`, Codex `function_call_output`, Gemini `toolCalls[].result*` |
| `assistant.decision.prompt` | Assistant prompt with selectable options | AskUserQuestion / request_user_input prompt synthesis |
| `system.message` | System-authored message intended for user/assistant flow | Reserved; not widely emitted yet |
| `provider.info` | Provider metadata/info event | Claude `system` entries currently map here |
| `provider.raw` | Raw provider event retained when no canonical mapping fits | Recommended fallback for unknown types |

## Correlation Rules (Do Not Rely On Sequence Alone)

### Tool Correlation

- `assistant.tool.result` must carry `toolCallId` that references an earlier `assistant.tool.call`.
- Sequence should still be preserved, but correlation is explicit via ID.

### Decision Correlation

- `assistant.decision.prompt` should carry a stable decision/question identifier.
- `user.decision.response` must reference that identifier directly (for example `decisionId` or `providerQuestionId`).
- Sequence-only correlation is insufficient for resume/replay, partial ingestion, and multi-question prompts.

### Minimum Correlation Fields

Recommended payload fields:

- `assistant.decision.prompt`: `decisionId`, `decisionKey`, `prompt`, `options[]`, `multiSelect?`
- `user.decision.response`: `decisionId`, `selections[]`, `freeText?`

## How Current ConversationEvent Kinds Map

| Current `ConversationEvent.kind` | Current attributes | Target `SessionTranslationKind` |
| --- | --- | --- |
| `message.user` | Any | `user.message` (plus derived `user.kato-command` events when command lines exist) |
| `message.assistant` | `phase=commentary/final/other` | `assistant.message` |
| `thinking` | Any | `assistant.thinking` |
| `tool.call` | Any | `assistant.tool.call` |
| `tool.result` | Any | `assistant.tool.result` |
| `decision` | `status=proposed`, `decidedBy=assistant` | `assistant.decision.prompt` |
| `decision` | `status=accepted`, `decidedBy=user` | `user.decision.response` |
| `decision` | Other states (`rejected`, etc.) | keep as `provider.raw` until explicitly modeled |
| `message.system` | Any | `system.message` |
| `provider.info` | Any | `provider.info` |

## Examples For Requested Kinds

### `system.message`

Example (reserved pattern):

```json
{
  "kind": "system.message",
  "payload": { "text": "This conversation is now read-only." }
}
```

Current status: parser support exists in canonical model, but current provider parsers rarely emit this directly.

### `provider.info`

Current concrete example: Claude `entry.type=system` maps to provider info.

```json
{
  "kind": "provider.info",
  "source": { "providerEventType": "system" },
  "payload": { "text": "...", "subtype": "system" }
}
```

### `provider.raw`

Recommended fallback for unknown/ignored provider types to preserve data without losing parse continuity.

Example candidate from existing fixtures: Claude `progress` entry, currently ignored by parser.

```json
{
  "kind": "provider.raw",
  "source": { "providerEventType": "progress" },
  "payload": { "rawType": "progress", "raw": { "...": "..." } }
}
```

## Provider-Specific Type Inventory (Complete For Current Fixtures + Parser Branches)

### Claude

#### Top-level `entry.type`

| Source type | Encountered | Current behavior | Canonical mapping |
| --- | --- | --- | --- |
| `user` | Yes | Parsed | `user.message`, `assistant.tool.result` (from user `tool_result` blocks), `user.decision.response` (from `toolUseResult.answers`) |
| `assistant` | Yes | Parsed | `assistant.message`, `assistant.thinking`, `assistant.tool.call`, `assistant.decision.prompt` |
| `system` | Parser-supported (not in current fixtures) | Parsed | `provider.info` (today), potentially `system.message` later |
| `progress` | Yes | Ignored | Candidate `provider.raw` |
| `queue-operation` | Yes | Ignored | Candidate `provider.raw` |
| `file-history-snapshot` | Yes | Ignored | Candidate `provider.raw` |

#### `message.content[].type`

| Block type | Encountered | Current behavior | Canonical mapping |
| --- | --- | --- | --- |
| `text` | Yes | Parsed | `user.message` / `assistant.message` |
| `thinking` | Yes | Parsed | `assistant.thinking` |
| `tool_use` | Yes | Parsed | `assistant.tool.call`; `assistant.decision.prompt` when name is `AskUserQuestion` |
| `tool_result` | Yes | Parsed | `assistant.tool.result` |

#### Claude tool names encountered

- `Read`
- `Grep`
- `AskUserQuestion`

### Codex

#### Top-level line `type`

| Source type | Encountered | Current behavior | Canonical mapping |
| --- | --- | --- | --- |
| `session_meta` | Yes | Used for session discovery; not translated into events | none (metadata/discovery) |
| `turn_context` | Yes | Updates model context; no direct event | none (context update) |
| `event_msg` | Yes | Parsed by `payload.type` | multiple (see below) |
| `response_item` | Yes | Parsed by `payload.type` | multiple (see below) |
| `request_user_input` | Parser-supported branch, not in current fixture files | Parsed when present | `assistant.tool.call` + `assistant.decision.prompt` + `assistant.tool.result` + `user.decision.response` |

#### `event_msg.payload.type`

| Source subtype | Encountered | Current behavior | Canonical mapping |
| --- | --- | --- | --- |
| `user_message` | Yes | Parsed | `user.message` |
| `agent_message` | Yes | Parsed commentary | `assistant.message` |
| `task_started` | Yes | Turn context only | none |
| `task_complete` | Yes | Emits final assistant message when needed | `assistant.message` |
| `turn_aborted` | Yes | Ignored today | Candidate `provider.info` or `provider.raw` |

#### `response_item.payload.type`

| Source subtype | Encountered | Current behavior | Canonical mapping |
| --- | --- | --- | --- |
| `message` | Yes | Parsed (`phase=final_answer` seen in fixtures; `commentary` supported in parser) | `assistant.message` |
| `function_call` | Yes | Parsed | `assistant.tool.call` (+ `assistant.decision.prompt` for `request_user_input`) |
| `function_call_output` | Yes | Parsed | `assistant.tool.result` (+ `user.decision.response` when answers parse) |
| `reasoning` | Yes | Parsed (`summary[].type=summary_text`) | `assistant.thinking` |

#### Codex function names encountered

- `exec_command`
- `request_user_input`
- `search`

#### `session_meta.payload.source` values encountered

- `vscode`
- `cli`
- `exec` (discovery layer currently excludes `exec` sessions)

### Gemini

#### `messages[].type`

| Source type | Encountered | Current behavior | Canonical mapping |
| --- | --- | --- | --- |
| `user` | Yes | Parsed | `user.message` (plus derived `user.kato-command` when command lines present) |
| `gemini` | Yes | Parsed | `assistant.message`, `assistant.thinking`, `assistant.tool.call`, `assistant.tool.result` |
| `info` | Yes | Skipped by parser today | Candidate `provider.info` or `provider.raw` |

#### Gemini tool names encountered

- `read_file`
- `run_shell_command`

## Provider-Type To Canonical Mapping Reference (Condensed)

| Provider path | Canonical |
| --- | --- |
| Claude `user + text` | `user.message` |
| Claude `assistant + text` | `assistant.message` |
| Claude `assistant + thinking` | `assistant.thinking` |
| Claude `assistant + tool_use` | `assistant.tool.call` |
| Claude `user + tool_result` | `assistant.tool.result` |
| Claude `AskUserQuestion prompt` | `assistant.decision.prompt` |
| Claude `toolUseResult.answers` | `user.decision.response` |
| Claude `system` | `provider.info` |
| Codex `event_msg.user_message` | `user.message` |
| Codex `event_msg.agent_message` | `assistant.message` |
| Codex `event_msg.task_complete` | `assistant.message` |
| Codex `response_item.reasoning` | `assistant.thinking` |
| Codex `response_item.function_call` | `assistant.tool.call` |
| Codex `response_item.function_call_output` | `assistant.tool.result` |
| Codex request_user_input prompt | `assistant.decision.prompt` |
| Codex request_user_input answer | `user.decision.response` |
| Gemini `messages[].type=user` | `user.message` |
| Gemini `messages[].type=gemini` text | `assistant.message` |
| Gemini `thoughts` | `assistant.thinking` |
| Gemini `toolCalls[]` | `assistant.tool.call` |
| Gemini `toolCalls[].result*` | `assistant.tool.result` |

## Known Gaps

- Unknown/ignored provider types are not yet emitted as `provider.raw`.
- `system.message` is not yet broadly used in parser output.
- `decision` states beyond prompt/accepted response are not yet modeled as dedicated canonical kinds.
