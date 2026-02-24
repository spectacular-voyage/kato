import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import { normalizeText, utf8ByteLength } from "../../utils/text.ts";

interface CodexEntry {
  type: string;
  payload?: Record<string, unknown>;
}

function stripIdePreamble(text: string): string {
  const marker = "## My request for Codex:\n";
  const idx = text.indexOf(marker);
  if (idx >= 0) {
    return text.slice(idx + marker.length).trim();
  }
  return text.trim();
}

function deriveCodexToolDescription(
  name: string,
  input?: Record<string, unknown>,
): string | undefined {
  if (!input) return undefined;
  if (name === "exec_command" || name === "exec") {
    return typeof input["cmd"] === "string" ? input["cmd"] : undefined;
  }
  if (name === "search") {
    return typeof input["query"] === "string" ? input["query"] : undefined;
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((item) => item["type"] === "text")
    .map((item) => String(item["text"] ?? ""))
    .join("\n\n")
    .trim();
}

function makeByteOffsetCursor(offset: number): ProviderCursor {
  return { kind: "byte-offset", value: Math.max(0, Math.floor(offset)) };
}

function makeEventId(
  sessionId: string,
  lineEnd: number,
  kind: string,
  index: number = 0,
): string {
  return `${sessionId}:${lineEnd}:${kind}${index > 0 ? `:${index}` : ""}`;
}

export interface CodexParseContext {
  provider: string;
  sessionId: string;
}

export async function* parseCodexEvents(
  filePath: string,
  fromOffset: number = 0,
  ctx: CodexParseContext,
): AsyncIterable<{ event: ConversationEvent; cursor: ProviderCursor }> {
  const content = await Deno.readTextFile(filePath);
  const lines = content.split("\n");

  const { provider, sessionId } = ctx;
  let model: string | undefined;
  let currentTurnId: string | undefined;

  let userMsgEnd = -1;
  let pendingAssistantText: string | undefined;
  let turnFinalized = false;

  let currentByteOffset = 0;
  const timestamp = new Date().toISOString();

  function makeBase(
    kind: ConversationEvent["kind"],
    providerEventType: string,
    lineEnd: number,
    index: number = 0,
    turnIdOverride?: string,
  ): Record<string, unknown> {
    return {
      eventId: makeEventId(sessionId, lineEnd, kind, index),
      provider,
      sessionId,
      timestamp,
      kind,
      // turnIdOverride semantics: undefined → fall back to currentTurnId;
      // empty string → explicitly suppress turnId; non-empty → use as turnId.
      ...(turnIdOverride !== undefined
        ? (turnIdOverride ? { turnId: turnIdOverride } : {})
        : currentTurnId
        ? { turnId: currentTurnId }
        : {}),
      source: {
        providerEventType,
        rawCursor: makeByteOffsetCursor(lineEnd),
      },
    };
  }

  function* flushPendingAssistant(
    newUserLineStart: number,
  ): Generator<{ event: ConversationEvent; cursor: ProviderCursor }> {
    if (!pendingAssistantText || turnFinalized || userMsgEnd < fromOffset) {
      return;
    }
    const text = pendingAssistantText;
    turnFinalized = true;
    pendingAssistantText = undefined;
    const base = makeBase(
      "message.assistant",
      "event_msg.agent_message",
      newUserLineStart,
    );
    yield {
      event: {
        ...base,
        kind: "message.assistant",
        role: "assistant",
        content: normalizeText(text),
        ...(model ? { model } : {}),
      } as unknown as ConversationEvent,
      cursor: makeByteOffsetCursor(newUserLineStart),
    };
  }

  function* finalizeAssistant(
    text: string,
    lineEnd: number,
    providerEventType: string,
    phase: "final" | "commentary",
  ): Generator<{ event: ConversationEvent; cursor: ProviderCursor }> {
    if (turnFinalized || lineEnd <= fromOffset) return;
    turnFinalized = true;
    pendingAssistantText = undefined;
    const base = makeBase("message.assistant", providerEventType, lineEnd);
    yield {
      event: {
        ...base,
        kind: "message.assistant",
        role: "assistant",
        content: normalizeText(text),
        ...(model ? { model } : {}),
        phase,
      } as unknown as ConversationEvent,
      cursor: makeByteOffsetCursor(lineEnd),
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const hasNewline = i < lines.length - 1;
    const lineBytes = utf8ByteLength(line) + (hasNewline ? 1 : 0);
    const lineStart = currentByteOffset;
    const lineEnd = lineStart + lineBytes;
    currentByteOffset = lineEnd;

    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = parsed as CodexEntry;
    const payload = entry.payload;

    switch (entry.type) {
      case "turn_context": {
        if (!model && payload?.["model"]) {
          model = String(payload["model"]);
        }
        break;
      }

      case "event_msg": {
        if (!payload) break;
        const msgType = String(payload["type"] ?? "");

        if (msgType === "task_started") {
          if (payload["turn_id"]) {
            currentTurnId = String(payload["turn_id"]);
          }
        } else if (msgType === "user_message") {
          const rawText = String(payload["message"] ?? "");
          const text = normalizeText(stripIdePreamble(rawText));

          if (lineEnd > fromOffset) {
            yield* flushPendingAssistant(lineStart);

            pendingAssistantText = undefined;
            turnFinalized = false;

            const savedTurnId = currentTurnId;
            currentTurnId = undefined;
            userMsgEnd = lineEnd;

            if (text) {
              const base = makeBase(
                "message.user",
                "event_msg.user_message",
                lineEnd,
                0,
                savedTurnId,
              );
              yield {
                event: {
                  ...base,
                  kind: "message.user",
                  role: "user",
                  content: text,
                } as unknown as ConversationEvent,
                cursor: makeByteOffsetCursor(lineEnd),
              };
            }
          } else {
            pendingAssistantText = undefined;
            turnFinalized = false;
            currentTurnId = undefined;
            userMsgEnd = lineEnd;
          }
        } else if (msgType === "agent_message") {
          if (!turnFinalized) {
            pendingAssistantText = String(payload["message"] ?? "");
          }
        } else if (msgType === "task_complete") {
          if (!turnFinalized) {
            const lastMessage = payload["last_agent_message"];
            const text = typeof lastMessage === "string" ? lastMessage : "";
            if (text) {
              yield* finalizeAssistant(
                text,
                lineEnd,
                "event_msg.task_complete",
                "final",
              );
            }
          }
        }
        break;
      }

      case "response_item": {
        if (!payload) break;
        const itemType = String(payload["type"] ?? "");

        if (itemType === "message") {
          const phase = String(payload["phase"] ?? "other");
          const text = extractMessageText(payload["content"]);
          if (text && lineEnd > fromOffset) {
            if (phase === "final_answer") {
              yield* finalizeAssistant(
                text,
                lineEnd,
                "response_item.message.final_answer",
                "final",
              );
            } else if (phase === "commentary" && !turnFinalized) {
              const base = makeBase(
                "message.assistant",
                "response_item.message.commentary",
                lineEnd,
              );
              yield {
                event: {
                  ...base,
                  kind: "message.assistant",
                  role: "assistant",
                  content: normalizeText(text),
                  ...(model ? { model } : {}),
                  phase: "commentary",
                } as unknown as ConversationEvent,
                cursor: makeByteOffsetCursor(lineEnd),
              };
            }
          }
        } else if (itemType === "function_call" && lineEnd > fromOffset) {
          const callId = String(payload["call_id"] ?? "");
          const name = String(payload["name"] ?? "unknown");
          let input: Record<string, unknown> | undefined;
          try {
            const args = payload["arguments"];
            if (typeof args === "string") {
              input = JSON.parse(args) as Record<string, unknown>;
            }
          } catch {
            // Ignore malformed function_call arguments.
          }
          const toolCallId = callId ||
            makeEventId(sessionId, lineEnd, "tool.call");
          const base = makeBase(
            "tool.call",
            "response_item.function_call",
            lineEnd,
          );
          yield {
            event: {
              ...base,
              kind: "tool.call",
              toolCallId,
              name,
              description: deriveCodexToolDescription(name, input),
              ...(input ? { input } : {}),
            } as unknown as ConversationEvent,
            cursor: makeByteOffsetCursor(lineEnd),
          };
        } else if (
          itemType === "function_call_output" && lineEnd > fromOffset
        ) {
          const callId = String(payload["call_id"] ?? "");
          const output = payload["output"];
          const result = typeof output === "string"
            ? output
            : JSON.stringify(output);
          const base = makeBase(
            "tool.result",
            "response_item.function_call_output",
            lineEnd,
          );
          yield {
            event: {
              ...base,
              kind: "tool.result",
              toolCallId: callId,
              result,
            } as unknown as ConversationEvent,
            cursor: makeByteOffsetCursor(lineEnd),
          };
        } else if (itemType === "reasoning" && lineEnd > fromOffset) {
          const summary = payload["summary"];
          if (Array.isArray(summary) && summary.length > 0) {
            const texts = (summary as Array<Record<string, unknown>>)
              .filter((item) => item["type"] === "summary_text")
              .map((item) => String(item["text"] ?? ""))
              .filter((text) => text.length > 0);
            if (texts.length > 0) {
              const base = makeBase(
                "thinking",
                "response_item.reasoning",
                lineEnd,
              );
              yield {
                event: {
                  ...base,
                  kind: "thinking",
                  content: texts.join("\n"),
                } as unknown as ConversationEvent,
                cursor: makeByteOffsetCursor(lineEnd),
              };
            }
          }
        }
        break;
      }

      case "request_user_input": {
        if (!payload || lineEnd <= fromOffset) break;

        const toolCallId = makeEventId(
          sessionId,
          lineEnd,
          "request_user_input",
        );
        const questions = payload["questions"];
        const answers = payload["answers"];

        // tool.call: the questionnaire prompt
        const toolCallBase = makeBase(
          "tool.call",
          "request_user_input",
          lineEnd,
          0,
        );
        yield {
          event: {
            ...toolCallBase,
            kind: "tool.call",
            toolCallId,
            name: "request_user_input",
            ...(questions ? { input: { questions } } : {}),
          } as unknown as ConversationEvent,
          cursor: makeByteOffsetCursor(lineEnd),
        };

        // tool.result: raw answer output
        const toolResultBase = makeBase(
          "tool.result",
          "request_user_input",
          lineEnd,
          1,
        );
        yield {
          event: {
            ...toolResultBase,
            kind: "tool.result",
            toolCallId,
            result: answers !== undefined ? JSON.stringify(answers) : "",
          } as unknown as ConversationEvent,
          cursor: makeByteOffsetCursor(lineEnd),
        };

        const answersRecord = answers !== null && typeof answers === "object" &&
            !Array.isArray(answers)
          ? answers as Record<string, unknown>
          : undefined;

        if (answersRecord) {
          const answeredLines = Object.entries(answersRecord)
            .map(([key, val]) => `- ${key}: ${String(val)}`)
            .join("\n");

          const userBase = makeBase(
            "message.user",
            "request_user_input",
            lineEnd,
            2,
          );
          userMsgEnd = lineEnd;
          yield {
            event: {
              ...userBase,
              kind: "message.user",
              role: "user",
              content: answeredLines,
            } as unknown as ConversationEvent,
            cursor: makeByteOffsetCursor(lineEnd),
          };

          // decision events: one per answered question
          const questionsList = Array.isArray(questions)
            ? questions as Array<Record<string, unknown>>
            : [];
          let decisionIndex = 3;
          for (const [key, val] of Object.entries(answersRecord)) {
            const questionEntry = questionsList.find((q) => q["id"] === key);
            const questionText = questionEntry
              ? String(questionEntry["question"] ?? key)
              : key;
            const decisionBase = makeBase(
              "decision",
              "request_user_input",
              lineEnd,
              decisionIndex,
            );
            const decisionId = makeEventId(
              sessionId,
              lineEnd,
              "decision",
              decisionIndex,
            );
            yield {
              event: {
                ...decisionBase,
                kind: "decision",
                decisionId,
                decisionKey: key,
                summary: `${questionText} → ${String(val)}`,
                status: "accepted",
                decidedBy: "user",
                basisEventIds: [
                  String(toolCallBase["eventId"]),
                  String(toolResultBase["eventId"]),
                ],
              } as unknown as ConversationEvent,
              cursor: makeByteOffsetCursor(lineEnd),
            };
            decisionIndex += 1;
          }
        }
        break;
      }
    }
  }

  // Flush any remaining pending assistant text at end of file
  if (pendingAssistantText && !turnFinalized && userMsgEnd >= fromOffset) {
    const base = makeBase(
      "message.assistant",
      "event_msg.agent_message",
      currentByteOffset,
    );
    yield {
      event: {
        ...base,
        kind: "message.assistant",
        role: "assistant",
        content: normalizeText(pendingAssistantText),
        ...(model ? { model } : {}),
      } as unknown as ConversationEvent,
      cursor: makeByteOffsetCursor(currentByteOffset),
    };
  }
}
