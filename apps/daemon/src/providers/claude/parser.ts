import type { Message, ThinkingBlock, ToolCall } from "@kato/shared";
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
    if (entry.type !== "user" && entry.type !== "assistant") {
      currentOffset = endOffset;
      continue;
    }
    if (entry.isSidechain) {
      currentOffset = endOffset;
      continue;
    }
    if (!entry.message?.content || !Array.isArray(entry.message.content)) {
      currentOffset = endOffset;
      continue;
    }

    yield { entry, endOffset };
    currentOffset = endOffset;
  }
}

function isUserTextEntry(entry: RawEntry): boolean {
  return entry.message!.content.some((block) => block.type === "text");
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

function extractThinking(content: RawContentBlock[]): ThinkingBlock[] {
  return content
    .filter((block) => block.type === "thinking")
    .map((block) => ({ content: String(block["thinking"] ?? "") }));
}

function extractToolUses(content: RawContentBlock[]): ToolCall[] {
  return content
    .filter((block) => block.type === "tool_use")
    .map((block) => {
      const name = String(block["name"] ?? "unknown");
      const input = block["input"] as Record<string, unknown> | undefined;
      return {
        id: String(block["id"] ?? ""),
        name,
        description: deriveToolDescription(name, input),
        input,
      };
    });
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

function linkToolResults(
  content: RawContentBlock[],
  pendingTools: Map<string, ToolCall>,
): void {
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const toolUseId = block.tool_use_id as string;
    const toolCall = pendingTools.get(toolUseId);
    if (toolCall) {
      toolCall.result = extractToolResultText(block.content);
      pendingTools.delete(toolUseId);
    }
  }
}

function makeMessage(
  role: "user" | "assistant",
  id: string,
  timestamp: string,
  textParts: string[],
  toolCalls: ToolCall[],
  thinkingBlocks: ThinkingBlock[],
  model?: string,
): Message {
  const content = normalizeText(
    textParts.filter((part) => part.length > 0).join("\n\n"),
  );

  return {
    id,
    role,
    content,
    timestamp,
    ...(model && { model }),
    ...(toolCalls.length > 0 && { toolCalls }),
    ...(thinkingBlocks.length > 0 && { thinkingBlocks }),
  };
}

export async function* parseClaudeMessages(
  filePath: string,
  fromOffset: number = 0,
): AsyncIterable<{ message: Message; offset: number }> {
  const content = await Deno.readTextFile(filePath);

  let currentRole: "user" | "assistant" | null = null;
  let currentId = "";
  let currentTimestamp = "";
  let currentModel: string | undefined;
  let textParts: string[] = [];
  let toolCalls: ToolCall[] = [];
  let thinkingBlocks: ThinkingBlock[] = [];
  let lastOffset = fromOffset;
  const pendingTools = new Map<string, ToolCall>();

  function* flushCurrent(): Generator<{ message: Message; offset: number }> {
    if (!currentRole) return;
    if (
      textParts.length > 0 || toolCalls.length > 0 || thinkingBlocks.length > 0
    ) {
      yield {
        message: makeMessage(
          currentRole,
          currentId,
          currentTimestamp,
          textParts,
          toolCalls,
          thinkingBlocks,
          currentModel,
        ),
        offset: lastOffset,
      };
    }

    currentRole = null;
    currentModel = undefined;
    textParts = [];
    toolCalls = [];
    thinkingBlocks = [];
  }

  for (const { entry, endOffset } of parseLines(content, fromOffset)) {
    if (entry.type === "user") {
      const blocks = entry.message!.content;
      const hasText = isUserTextEntry(entry);

      if (hasText) {
        yield* flushCurrent();

        currentRole = "user";
        currentId = entry.uuid;
        currentTimestamp = entry.timestamp;
        textParts = [];
        const text = extractText(blocks);
        if (text) {
          textParts.push(text);
        }
      }

      linkToolResults(blocks, pendingTools);
    } else {
      if (currentRole !== "assistant") {
        yield* flushCurrent();
        currentRole = "assistant";
        currentId = entry.uuid;
        currentTimestamp = entry.timestamp;
        currentModel = entry.message!.model;
      }

      const blocks = entry.message!.content;
      const text = extractText(blocks);
      if (text) {
        textParts.push(text);
      }
      thinkingBlocks.push(...extractThinking(blocks));

      const newToolCalls = extractToolUses(blocks);
      toolCalls.push(...newToolCalls);
      for (const toolCall of newToolCalls) {
        pendingTools.set(toolCall.id, toolCall);
      }
    }

    lastOffset = endOffset;
  }

  yield* flushCurrent();
}
