import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import { normalizeText, utf8ByteLength } from "../../utils/text.ts";

interface RawContentBlock {
  type: string;
  [key: string]: unknown;
}

interface RawEntry {
  type: string;
  uuid: string;
  timestamp: string;
  isSidechain?: boolean;
  message?: {
    role: string;
    model?: string;
    content: RawContentBlock[];
  };
}

interface ParsedLine {
  entry: RawEntry;
  endOffset: number;
}

function* parseLines(
  content: string,
  fromOffset: number,
): Generator<ParsedLine> {
  const lines = content.split("\n");
  let currentOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const hasNewline = i < lines.length - 1;
    const lineBytes = utf8ByteLength(line) + (hasNewline ? 1 : 0);
    const endOffset = currentOffset + lineBytes;

    if (currentOffset < fromOffset || line.trim().length === 0) {
      currentOffset = endOffset;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      currentOffset = endOffset;
      continue;
    }

    const entry = parsed as RawEntry;
    // Accept user, assistant, and system entries.
    if (
      entry.type !== "user" && entry.type !== "assistant" &&
      entry.type !== "system"
    ) {
      currentOffset = endOffset;
      continue;
    }
    if (entry.isSidechain) {
      currentOffset = endOffset;
      continue;
    }

    yield { entry, endOffset };
    currentOffset = endOffset;
  }
}

function isUserTextEntry(entry: RawEntry): boolean {
  return (
    Array.isArray(entry.message?.content) &&
    entry.message!.content.some((block) => block.type === "text")
  );
}

function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function cleanText(text: string): string {
  return stripAnsi(text)
    .replace(
      /<(?:ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/(?:ide_opened_file|ide_selection|system-reminder)>/g,
      "",
    )
    .trim();
}

function extractText(content: RawContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => cleanText(String(block["text"] ?? "")))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return stripAnsi(content);
  if (Array.isArray(content)) {
    return content
      .filter((item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        (item as RawContentBlock).type === "text"
      )
      .map((item: unknown) => stripAnsi((item as { text: string }).text))
      .join("\n");
  }
  return "";
}

function deriveToolDescription(
  name: string,
  input?: Record<string, unknown>,
): string | undefined {
  if (!input) return undefined;
  switch (name) {
    case "Bash":
      return (input.description as string | undefined) ??
        truncate(input.command as string | undefined, 80);
    case "Read":
    case "Edit":
    case "Write":
      return input.file_path as string | undefined;
    case "Grep":
    case "Glob":
      return input.pattern as string | undefined;
    case "Task":
      return input.description as string | undefined;
    default:
      return undefined;
  }
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function makeByteOffsetCursor(offset: number): ProviderCursor {
  return { kind: "byte-offset", value: Math.max(0, Math.floor(offset)) };
}

function makeEventId(
  entryUuid: string,
  kind: string,
  index: number = 0,
): string {
  return `${entryUuid}:${kind}${index > 0 ? `:${index}` : ""}`;
}

export interface ClaudeParseContext {
  provider: string;
  sessionId: string;
}

export async function* parseClaudeEvents(
  filePath: string,
  fromOffset: number = 0,
  ctx: ClaudeParseContext,
): AsyncIterable<{ event: ConversationEvent; cursor: ProviderCursor }> {
  const content = await Deno.readTextFile(filePath);
  const { provider, sessionId } = ctx;

  for (const { entry, endOffset } of parseLines(content, fromOffset)) {
    const turnId = entry.uuid;
    const timestamp = entry.timestamp;
    const cursor = makeByteOffsetCursor(endOffset);

    const makeBase = (
      kind: ConversationEvent["kind"],
      index: number = 0,
    ): Record<string, unknown> => ({
      eventId: makeEventId(turnId, kind, index),
      provider,
      sessionId,
      timestamp,
      kind,
      turnId,
      source: {
        providerEventType: entry.type,
        providerEventId: turnId,
        rawCursor: cursor,
      },
    });

    if (entry.type === "system") {
      // system entries → provider.info events
      const blocks = entry.message?.content ?? [];
      const text = extractText(blocks);
      if (text) {
        yield {
          event: {
            ...makeBase("provider.info"),
            kind: "provider.info",
            content: text,
            subtype: "system",
          } as unknown as ConversationEvent,
          cursor,
        };
      }
      continue;
    }

    const blocks = entry.message?.content ?? [];

    if (entry.type === "user") {
      // Extract text content → message.user
      if (isUserTextEntry(entry)) {
        const text = extractText(blocks);
        if (text) {
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
      }

      // Extract tool_result blocks → tool.result events
      let toolResultIndex = 0;
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const toolUseId = String(block["tool_use_id"] ?? "");
        const resultText = extractToolResultText(block["content"]);
        yield {
          event: {
            ...makeBase("tool.result", toolResultIndex),
            kind: "tool.result",
            toolCallId: toolUseId,
            result: resultText,
          } as unknown as ConversationEvent,
          cursor,
        };
        toolResultIndex += 1;
      }
    } else if (entry.type === "assistant") {
      const model = entry.message?.model;

      // Extract text → message.assistant
      const text = extractText(blocks);
      if (text) {
        yield {
          event: {
            ...makeBase("message.assistant"),
            kind: "message.assistant",
            role: "assistant",
            content: normalizeText(text),
            ...(model ? { model } : {}),
          } as unknown as ConversationEvent,
          cursor,
        };
      }

      // Extract thinking blocks → thinking events
      let thinkingIndex = 0;
      for (const block of blocks) {
        if (block.type !== "thinking") continue;
        const thinkingContent = String(block["thinking"] ?? "");
        if (thinkingContent) {
          yield {
            event: {
              ...makeBase("thinking", thinkingIndex),
              kind: "thinking",
              content: thinkingContent,
            } as unknown as ConversationEvent,
            cursor,
          };
          thinkingIndex += 1;
        }
      }

      // Extract tool_use blocks → tool.call events
      let toolCallIndex = 0;
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const name = String(block["name"] ?? "unknown");
        const input = block["input"] as Record<string, unknown> | undefined;
        const toolCallId = String(
          block["id"] ?? makeEventId(turnId, "tool.call", toolCallIndex),
        );
        yield {
          event: {
            ...makeBase("tool.call", toolCallIndex),
            kind: "tool.call",
            toolCallId,
            name,
            description: deriveToolDescription(name, input),
            ...(input ? { input } : {}),
          } as unknown as ConversationEvent,
          cursor,
        };
        toolCallIndex += 1;
      }
    }
  }
}
