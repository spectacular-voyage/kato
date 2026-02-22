import type { Message, ThinkingBlock, ToolCall } from "@kato/shared";
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

function extractFinalAnswerText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((item) => item["type"] === "text")
    .map((item) => String(item["text"] ?? ""))
    .join("\n\n")
    .trim();
}

function makeMessage(
  role: "user" | "assistant",
  id: string,
  model: string | undefined,
  content: string,
  toolCalls: ToolCall[],
  thinkingBlocks: ThinkingBlock[],
): Message {
  return {
    id,
    role,
    content: normalizeText(content),
    timestamp: new Date().toISOString(),
    ...(model && role === "assistant" && { model }),
    ...(toolCalls.length > 0 && { toolCalls: [...toolCalls] }),
    ...(thinkingBlocks.length > 0 && { thinkingBlocks: [...thinkingBlocks] }),
  };
}

export async function* parseCodexMessages(
  filePath: string,
  fromOffset: number = 0,
): AsyncIterable<{ message: Message; offset: number }> {
  const content = await Deno.readTextFile(filePath);
  const lines = content.split("\n");

  let model: string | undefined;
  let sessionId: string | undefined;
  let currentTurnId: string | undefined;

  let userMsgEnd = -1;
  let pendingAssistantText: string | undefined;
  let toolCalls: ToolCall[] = [];
  let thinkingBlocks: ThinkingBlock[] = [];
  const pendingTools = new Map<string, ToolCall>();
  let turnFinalized = false;

  let currentByteOffset = 0;

  function* finalizeAssistant(
    text: string,
    lineEnd: number,
  ): Generator<{ message: Message; offset: number }> {
    if (turnFinalized) return;
    turnFinalized = true;
    pendingAssistantText = undefined;

    if (lineEnd > fromOffset) {
      const assistantId = `${sessionId ?? "unknown"}-assist-${lineEnd}`;
      yield {
        message: makeMessage(
          "assistant",
          assistantId,
          model,
          text,
          toolCalls,
          thinkingBlocks,
        ),
        offset: lineEnd,
      };
    }

    toolCalls = [];
    thinkingBlocks = [];
    pendingTools.clear();
  }

  function* flushPendingAssistant(
    newUserLineStart: number,
  ): Generator<{ message: Message; offset: number }> {
    if (!pendingAssistantText || turnFinalized || userMsgEnd < fromOffset) {
      return;
    }

    const text = pendingAssistantText;
    turnFinalized = true;
    pendingAssistantText = undefined;
    const assistantId = `${sessionId ?? "unknown"}-assist-${newUserLineStart}`;
    yield {
      message: makeMessage(
        "assistant",
        assistantId,
        model,
        text,
        toolCalls,
        thinkingBlocks,
      ),
      offset: newUserLineStart,
    };

    toolCalls = [];
    thinkingBlocks = [];
    pendingTools.clear();
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
      case "session_meta": {
        if (payload?.["id"]) {
          sessionId = String(payload["id"]);
        }
        break;
      }

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
            toolCalls = [];
            thinkingBlocks = [];
            pendingTools.clear();
            turnFinalized = false;

            const msgId = currentTurnId ??
              `${sessionId ?? "unknown"}-${lineStart}`;
            currentTurnId = undefined;
            userMsgEnd = lineEnd;

            if (text) {
              yield {
                message: makeMessage("user", msgId, undefined, text, [], []),
                offset: lineEnd,
              };
            }
          } else {
            pendingAssistantText = undefined;
            toolCalls = [];
            thinkingBlocks = [];
            pendingTools.clear();
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
              yield* finalizeAssistant(text, lineEnd);
            }
          }
        }
        break;
      }

      case "response_item": {
        if (!payload) break;
        const itemType = String(payload["type"] ?? "");

        if (itemType === "message" && payload["phase"] === "final_answer") {
          if (!turnFinalized) {
            const text = extractFinalAnswerText(payload["content"]);
            if (text) {
              yield* finalizeAssistant(text, lineEnd);
            }
          }
        } else if (itemType === "function_call") {
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

          const toolCall: ToolCall = {
            id: callId,
            name,
            description: deriveCodexToolDescription(name, input),
            input,
          };
          toolCalls.push(toolCall);
          if (callId) {
            pendingTools.set(callId, toolCall);
          }
        } else if (itemType === "function_call_output") {
          const callId = String(payload["call_id"] ?? "");
          const toolCall = pendingTools.get(callId);
          if (toolCall) {
            const output = payload["output"];
            toolCall.result = typeof output === "string"
              ? output
              : JSON.stringify(output);
            pendingTools.delete(callId);
          }
        } else if (itemType === "reasoning") {
          const summary = payload["summary"];
          if (Array.isArray(summary) && summary.length > 0) {
            const texts = (summary as Array<Record<string, unknown>>)
              .filter((item) => item["type"] === "summary_text")
              .map((item) => String(item["text"] ?? ""))
              .filter((text) => text.length > 0);
            if (texts.length > 0) {
              thinkingBlocks.push({ content: texts.join("\n") });
            }
          }
        }
        break;
      }
    }
  }

  if (pendingAssistantText && !turnFinalized && userMsgEnd >= fromOffset) {
    const assistantId = `${sessionId ?? "unknown"}-assist-${currentByteOffset}`;
    yield {
      message: makeMessage(
        "assistant",
        assistantId,
        model,
        pendingAssistantText,
        toolCalls,
        thinkingBlocks,
      ),
      offset: currentByteOffset,
    };
  }
}
