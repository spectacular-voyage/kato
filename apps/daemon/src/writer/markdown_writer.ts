import type { ConversationEvent } from "@kato/shared";
import { basename, dirname } from "@std/path";
import { renderFrontmatter } from "./frontmatter.ts";

export type ConversationWriteMode = "create" | "append" | "overwrite";

export interface MarkdownWriteResult {
  mode: ConversationWriteMode;
  outputPath: string;
  wrote: boolean;
  deduped: boolean;
}

export interface MarkdownSpeakerNames {
  user?: string;
  assistant?: string;
  system?: string;
}

export interface MarkdownRenderOptions {
  includeFrontmatter?: boolean;
  title?: string;
  now?: () => Date;
  makeFrontmatterId?: (title: string) => string;
  includeCommentary?: boolean;
  includeToolCalls?: boolean;
  includeThinking?: boolean;
  italicizeUserMessages?: boolean;
  includeSystemEvents?: boolean;
  truncateToolResults?: number;
  speakerNames?: MarkdownSpeakerNames;
}

export interface ConversationWriterLike {
  appendEvents(
    outputPath: string,
    events: ConversationEvent[],
    options?: MarkdownRenderOptions,
  ): Promise<MarkdownWriteResult>;
  overwriteEvents(
    outputPath: string,
    events: ConversationEvent[],
    options?: MarkdownRenderOptions,
  ): Promise<MarkdownWriteResult>;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatHeadingTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "unknown-time";
  }

  return [
    date.getFullYear(),
    "-",
    pad2(date.getMonth() + 1),
    "-",
    pad2(date.getDate()),
    "_",
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    "_",
    pad2(date.getSeconds()),
  ].join("");
}

function formatModelName(model: string): string {
  return model.replace(/-(\d+)-(\d+)$/, "-$1.$2");
}

function formatUserMessageContent(content: string): string {
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return "";
    }
    return `*${trimmed.replace(/\*/g, "\\*")}*`;
  }).join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0 || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

type MessageEvent = ConversationEvent & {
  kind: "message.user" | "message.assistant" | "message.system";
};

function isMessageEvent(event: ConversationEvent): event is MessageEvent {
  return (
    event.kind === "message.user" ||
    event.kind === "message.assistant" ||
    event.kind === "message.system"
  );
}

function formatMessageHeading(
  event: MessageEvent,
  speakerNames: MarkdownSpeakerNames | undefined,
): string {
  let speaker: string;
  if (event.kind === "message.user") {
    speaker = speakerNames?.user ?? "User";
  } else if (event.kind === "message.system") {
    speaker = speakerNames?.system ?? "System";
  } else {
    const model = "model" in event
      ? (event.model as string | undefined)
      : undefined;
    speaker = model
      ? formatModelName(model)
      : (speakerNames?.assistant ?? "Assistant");
  }
  return `# ${speaker}_${formatHeadingTimestamp(event.timestamp)}`;
}

function makeEventSignature(event: ConversationEvent): string {
  const base = `${event.kind}\0${event.eventId}\0${event.timestamp}`;
  switch (event.kind) {
    case "message.user":
    case "message.assistant":
    case "message.system":
      return `${base}\0${event.content}`;
    case "tool.call":
      return `${base}\0${event.toolCallId}\0${event.name}`;
    case "tool.result":
      return `${base}\0${event.toolCallId}`;
    case "thinking":
      return `${base}\0${event.content}`;
    case "decision":
      return `${base}\0${event.decisionId}`;
    case "provider.info":
      return `${base}\0${event.content}`;
    default:
      return base;
  }
}

export function renderEventsToMarkdown(
  events: ConversationEvent[],
  options: MarkdownRenderOptions = {},
): string {
  const includeFrontmatter = options.includeFrontmatter !== false;
  const includeCommentary = options.includeCommentary ?? true;
  const includeToolCalls = options.includeToolCalls ?? true;
  const includeThinking = options.includeThinking ?? true;
  const italicizeUserMessages = options.italicizeUserMessages ?? false;
  const includeSystemEvents = options.includeSystemEvents ?? false;
  const truncateToolResults = options.truncateToolResults ?? 4_000;

  // Pass 1: Build tool result queue per toolCallId (preserves order for revisions).
  const toolResultQueues = new Map<
    string,
    Array<ConversationEvent & { kind: "tool.result" }>
  >();
  for (const event of events) {
    if (event.kind === "tool.result") {
      const queue = toolResultQueues.get(event.toolCallId) ?? [];
      queue.push(event);
      toolResultQueues.set(event.toolCallId, queue);
    }
  }
  // Mutable pointer per toolCallId to consume results in order.
  const toolResultPointers = new Map<string, number>();
  function nextToolResult(
    toolCallId: string,
  ): (ConversationEvent & { kind: "tool.result" }) | undefined {
    const queue = toolResultQueues.get(toolCallId);
    if (!queue) return undefined;
    const idx = toolResultPointers.get(toolCallId) ?? 0;
    toolResultPointers.set(toolCallId, idx + 1);
    return queue[idx];
  }

  const parts: string[] = [];

  if (includeFrontmatter) {
    const title = options.title ?? "Untitled Conversation";
    parts.push(
      renderFrontmatter({
        title,
        now: options.now?.() ?? new Date(),
        makeFrontmatterId: options.makeFrontmatterId,
      }),
      "",
    );
  }

  let lastRole: string | undefined;
  let lastSignature: string | undefined;

  // Pass 2: Render events in sequence.
  for (const event of events) {
    if (isMessageEvent(event)) {
      if (event.kind === "message.system" && !includeSystemEvents) {
        continue;
      }
      if (
        event.kind === "message.assistant" &&
        event.phase === "commentary" &&
        !includeCommentary
      ) {
        continue;
      }

      const content = (event.kind === "message.user" && italicizeUserMessages)
        ? formatUserMessageContent(event.content)
        : event.content;

      if (content.trim().length === 0) {
        continue;
      }

      const signature = makeEventSignature(event);
      if (signature === lastSignature) {
        continue;
      }
      lastSignature = signature;

      const includeHeading = event.kind !== lastRole;
      lastRole = event.kind;

      const messageParts: string[] = [];
      if (includeHeading) {
        messageParts.push(
          formatMessageHeading(event, options.speakerNames),
          "",
        );
      }
      messageParts.push(content);
      parts.push(messageParts.join("\n"), "");
    } else if (event.kind === "tool.call") {
      if (!includeToolCalls) continue;

      const result = nextToolResult(event.toolCallId);
      const callParts: string[] = [
        "",
        "<details>",
        `<summary>Tool: ${event.name}${
          event.description ? ` — ${event.description}` : ""
        }</summary>`,
        "",
      ];
      if (event.input && Object.keys(event.input).length > 0) {
        callParts.push(
          "```json",
          JSON.stringify(event.input, null, 2),
          "```",
        );
      }
      if (result && result.result.length > 0) {
        callParts.push(
          "",
          "```",
          truncate(result.result, truncateToolResults),
          "```",
        );
      }
      callParts.push("", "</details>");
      parts.push(callParts.join("\n"), "");
      lastSignature = undefined;
    } else if (event.kind === "tool.result") {
      // Skip: rendered inline with its tool.call above.
      continue;
    } else if (event.kind === "thinking") {
      if (!includeThinking) continue;
      const thinkingParts = [
        "",
        "<details>",
        "<summary>Thinking</summary>",
        "",
        event.content.trim(),
        "",
        "</details>",
      ];
      parts.push(thinkingParts.join("\n"), "");
      lastSignature = undefined;
    } else if (event.kind === "decision") {
      const decisionParts = [
        "",
        `**Decision [${event.decisionKey}]:** ${event.summary}`,
        `*Status: ${event.status} — decided by: ${event.decidedBy}*`,
      ];
      parts.push(decisionParts.join("\n"), "");
      lastSignature = undefined;
    } else if (event.kind === "provider.info") {
      if (!includeSystemEvents) continue;
      const infoParts = [
        "",
        `> [provider.info${
          event.subtype ? `:${event.subtype}` : ""
        }] ${event.content}`,
      ];
      parts.push(infoParts.join("\n"), "");
      lastSignature = undefined;
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

async function extractExistingFrontmatter(
  filePath: string,
): Promise<string | null> {
  let content: string;
  try {
    content = await Deno.readTextFile(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }

  if (!content.startsWith("---\n")) {
    return null;
  }

  const closingIndex = content.indexOf("\n---", 4);
  if (closingIndex < 0) {
    return null;
  }

  return content.slice(0, closingIndex + 4);
}

async function readExistingFile(
  filePath: string,
): Promise<{ exists: boolean; content: string }> {
  try {
    const content = await Deno.readTextFile(filePath);
    return { exists: true, content };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { exists: false, content: "" };
    }
    throw error;
  }
}

export class MarkdownConversationWriter implements ConversationWriterLike {
  async appendEvents(
    outputPath: string,
    events: ConversationEvent[],
    options: MarkdownRenderOptions = {},
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });

    const existing = await readExistingFile(outputPath);
    if (!existing.exists) {
      const title = options.title ?? basename(outputPath, ".md");
      const rendered = renderEventsToMarkdown(events, {
        ...options,
        includeFrontmatter: true,
        title,
      });
      const content = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
      await Deno.writeTextFile(outputPath, content);
      return {
        mode: "create",
        outputPath,
        wrote: true,
        deduped: false,
      };
    }

    const rendered = renderEventsToMarkdown(events, {
      ...options,
      includeFrontmatter: false,
    });
    const content = rendered.trim();
    if (content.length === 0) {
      return {
        mode: "append",
        outputPath,
        wrote: false,
        deduped: false,
      };
    }

    const existingTrimmed = existing.content.trimEnd();
    if (existingTrimmed.endsWith(content)) {
      return {
        mode: "append",
        outputPath,
        wrote: false,
        deduped: true,
      };
    }

    const separator = existing.content.length === 0
      ? ""
      : existing.content.endsWith("\n\n")
      ? ""
      : existing.content.endsWith("\n")
      ? "\n"
      : "\n\n";
    await Deno.writeTextFile(outputPath, `${separator}${content}`, {
      append: true,
      create: true,
    });

    return {
      mode: "append",
      outputPath,
      wrote: true,
      deduped: false,
    };
  }

  async overwriteEvents(
    outputPath: string,
    events: ConversationEvent[],
    options: MarkdownRenderOptions = {},
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });

    const existingFrontmatter = await extractExistingFrontmatter(outputPath);
    if (existingFrontmatter) {
      const body = renderEventsToMarkdown(events, {
        ...options,
        includeFrontmatter: false,
      }).trim();
      const content = body.length > 0
        ? `${existingFrontmatter}\n\n${body}\n`
        : `${existingFrontmatter}\n`;
      await Deno.writeTextFile(outputPath, content);
      return {
        mode: "overwrite",
        outputPath,
        wrote: true,
        deduped: false,
      };
    }

    const title = options.title ?? basename(outputPath, ".md");
    const rendered = renderEventsToMarkdown(events, {
      ...options,
      includeFrontmatter: true,
      title,
    });
    const content = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
    await Deno.writeTextFile(outputPath, content);
    return {
      mode: "overwrite",
      outputPath,
      wrote: true,
      deduped: false,
    };
  }
}
