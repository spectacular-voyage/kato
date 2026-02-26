import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import { normalizeText } from "../../utils/text.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function makeItemIndexCursor(index: number): ProviderCursor {
  return {
    kind: "item-index",
    value: Math.max(0, Math.floor(index)),
  };
}

function normalizeFromIndex(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function readTimestamp(value: unknown): string | undefined {
  return asNonEmptyString(value);
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractText(entry))
      .filter((entry) => entry.length > 0)
      .join("\n\n")
      .trim();
  }
  if (!isRecord(value)) {
    return "";
  }

  const directText = asNonEmptyString(value["text"]);
  if (directText) return directText;

  const directContent = asNonEmptyString(value["content"]);
  if (directContent) return directContent;

  const parts = value["parts"];
  if (Array.isArray(parts)) {
    const fromParts = extractText(parts);
    if (fromParts) return fromParts;
  }

  const nestedContent = value["content"];
  if (Array.isArray(nestedContent)) {
    const fromNested = extractText(nestedContent);
    if (fromNested) return fromNested;
  }

  const functionResponse = value["functionResponse"];
  if (isRecord(functionResponse)) {
    const response = functionResponse["response"];
    if (isRecord(response)) {
      const output = asNonEmptyString(response["output"]);
      if (output) return output;
    }
  }

  return "";
}

// For model messages, prefer content (authoritative full text) over displayContent
// (display-optimized and may omit narration/action lines).  Fall back to
// displayContent only when content is absent.
function extractPreferredMessageText(message: Record<string, unknown>): string {
  const content = extractText(message["content"]);
  if (content.length > 0) return content;
  return extractText(message["displayContent"]);
}

const COMMAND_LINE_PATTERN = /^\s*::[a-z][a-z0-9-]*(?:\s+.+)?\s*$/i;

function collectCommandLikeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && COMMAND_LINE_PATTERN.test(line));
}

// Gemini displayContent can omit raw control-command lines; preserve any
// command-like lines from raw content so runtime command detection still works.
function extractPreferredUserMessageText(
  message: Record<string, unknown>,
): string {
  const display = normalizeText(extractText(message["displayContent"]));
  const content = normalizeText(extractText(message["content"]));

  if (display.length === 0) return content;
  if (content.length === 0) return display;

  const displayCommands = new Set(collectCommandLikeLines(display));
  const missingCommands = collectCommandLikeLines(content).filter((line) =>
    !displayCommands.has(line)
  );

  if (missingCommands.length === 0) {
    return display;
  }

  return `${missingCommands.join("\n")}\n${display}`.trim();
}

function extractThoughts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = normalizeText(extractText(value));
    return single.length > 0 ? [single] : [];
  }
  return value
    .map((entry) => normalizeText(extractText(entry)))
    .filter((entry) => entry.length > 0);
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function deriveToolDescription(
  name: string,
  args?: Record<string, unknown>,
  explicitDescription?: unknown,
): string | undefined {
  const explicit = asNonEmptyString(explicitDescription);
  if (explicit) return explicit;
  if (!args) return undefined;

  switch (name) {
    case "run_shell_command":
      return truncate(asNonEmptyString(args["command"]), 100);
    case "read_file":
    case "write_file":
      return asNonEmptyString(args["path"]);
  }

  for (
    const key of [
      "description",
      "command",
      "path",
      "filePath",
      "query",
      "pattern",
      "prompt",
    ]
  ) {
    const candidate = asNonEmptyString(args[key]);
    if (candidate) {
      return truncate(candidate, 100);
    }
  }

  for (const value of Object.values(args)) {
    const candidate = asNonEmptyString(value);
    if (candidate) {
      return truncate(candidate, 100);
    }
  }

  return undefined;
}

function extractToolResult(resultDisplay: unknown, result: unknown): string {
  const display = extractText(resultDisplay);
  if (display.length > 0) return display;

  if (typeof result === "string") {
    return result;
  }

  const text = extractText(result);
  if (text.length > 0) {
    return text;
  }

  if (result === undefined) {
    return "";
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function makeEventId(
  sessionId: string,
  messageIndex: number,
  kind: string,
  index: number = 0,
): string {
  return `${sessionId}:${messageIndex}:${kind}${index > 0 ? `:${index}` : ""}`;
}

function makeTurnId(
  sessionId: string,
  message: Record<string, unknown>,
  messageIndex: number,
): string {
  return asNonEmptyString(message["id"]) ?? `${sessionId}:msg-${messageIndex}`;
}

export interface GeminiParseContext {
  provider: string;
  sessionId: string;
}

export async function* parseGeminiEvents(
  filePath: string,
  fromIndex: number = 0,
  ctx: GeminiParseContext,
): AsyncIterable<{ event: ConversationEvent; cursor: ProviderCursor }> {
  const content = await Deno.readTextFile(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : [];
  const fallbackTimestamp = readTimestamp(parsed["lastUpdated"]) ??
    readTimestamp(parsed["startTime"]) ??
    new Date(0).toISOString();
  const startIndex = normalizeFromIndex(fromIndex);
  const { provider, sessionId } = ctx;

  for (
    let messageIndex = startIndex;
    messageIndex < messages.length;
    messageIndex++
  ) {
    const rawMessage = messages[messageIndex];
    if (!isRecord(rawMessage)) continue;

    const messageType = asNonEmptyString(rawMessage["type"]);
    if (!messageType || messageType === "info") {
      continue;
    }

    const messageTimestamp = readTimestamp(rawMessage["timestamp"]) ??
      fallbackTimestamp;
    const messageId = asNonEmptyString(rawMessage["id"]);
    const turnId = makeTurnId(sessionId, rawMessage, messageIndex);
    const cursor = makeItemIndexCursor(messageIndex + 1);

    const makeBase = (
      kind: ConversationEvent["kind"],
      index: number = 0,
      providerEventType: string = messageType,
    ): Record<string, unknown> => ({
      eventId: makeEventId(sessionId, messageIndex, kind, index),
      provider,
      sessionId,
      timestamp: messageTimestamp,
      kind,
      turnId,
      source: {
        providerEventType,
        ...(messageId ? { providerEventId: messageId } : {}),
        rawCursor: cursor,
      },
    });

    if (messageType === "user") {
      const text = extractPreferredUserMessageText(rawMessage);
      if (text.length > 0) {
        yield {
          event: {
            ...makeBase("message.user"),
            kind: "message.user",
            role: "user",
            content: text,
          } as unknown as ConversationEvent,
          cursor,
        };
      }
      continue;
    }

    if (messageType !== "gemini") {
      continue;
    }

    const assistantText = normalizeText(
      extractPreferredMessageText(rawMessage),
    );
    const model = asNonEmptyString(rawMessage["model"]);
    if (assistantText.length > 0) {
      yield {
        event: {
          ...makeBase("message.assistant"),
          kind: "message.assistant",
          role: "assistant",
          content: assistantText,
          ...(model ? { model } : {}),
        } as unknown as ConversationEvent,
        cursor,
      };
    }

    const thoughts = extractThoughts(rawMessage["thoughts"]);
    for (let thoughtIndex = 0; thoughtIndex < thoughts.length; thoughtIndex++) {
      const thought = thoughts[thoughtIndex]!;
      yield {
        event: {
          ...makeBase("thinking", thoughtIndex),
          kind: "thinking",
          content: thought,
        } as unknown as ConversationEvent,
        cursor,
      };
    }

    const toolCalls = Array.isArray(rawMessage["toolCalls"])
      ? rawMessage["toolCalls"]
      : [];
    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
      const rawToolCall = toolCalls[toolIndex];
      if (!isRecord(rawToolCall)) continue;

      const name = asNonEmptyString(rawToolCall["name"]) ?? "unknown";
      const toolCallId = asNonEmptyString(rawToolCall["id"]) ??
        `${turnId}:tool-${toolIndex}`;
      const input = isRecord(rawToolCall["args"])
        ? rawToolCall["args"]
        : undefined;
      const toolCallDescription = deriveToolDescription(
        name,
        input,
        rawToolCall["description"],
      );
      const resultExists = hasOwnKey(rawToolCall, "result") ||
        hasOwnKey(rawToolCall, "resultDisplay");

      yield {
        event: {
          ...makeBase("tool.call", toolIndex, "gemini.tool_call"),
          kind: "tool.call",
          toolCallId,
          name,
          ...(toolCallDescription ? { description: toolCallDescription } : {}),
          ...(input ? { input } : {}),
        } as unknown as ConversationEvent,
        cursor,
      };

      if (!resultExists) continue;
      const result = extractToolResult(
        rawToolCall["resultDisplay"],
        rawToolCall["result"],
      );
      yield {
        event: {
          ...makeBase("tool.result", toolIndex, "gemini.tool_result"),
          kind: "tool.result",
          toolCallId,
          result,
        } as unknown as ConversationEvent,
        cursor,
      };
    }
  }
}
