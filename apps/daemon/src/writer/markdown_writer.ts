import type { Message } from "@kato/shared";
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
  includeToolCalls?: boolean;
  includeThinking?: boolean;
  italicizeUserMessages?: boolean;
  truncateToolResults?: number;
  speakerNames?: MarkdownSpeakerNames;
}

export interface ConversationWriterLike {
  appendMessages(
    outputPath: string,
    messages: Message[],
    options?: MarkdownRenderOptions,
  ): Promise<MarkdownWriteResult>;
  overwriteMessages(
    outputPath: string,
    messages: Message[],
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

function formatHeading(
  message: Message,
  speakerNames: MarkdownSpeakerNames | undefined,
): string {
  let speaker = "Assistant";
  if (message.role === "user") {
    speaker = speakerNames?.user ?? "User";
  } else if (message.role === "system") {
    speaker = speakerNames?.system ?? "System";
  } else if (message.model) {
    speaker = formatModelName(message.model);
  } else {
    speaker = speakerNames?.assistant ?? "Assistant";
  }

  return `# ${speaker}_${formatHeadingTimestamp(message.timestamp)}`;
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

function formatMessage(
  message: Message,
  options:
    & Required<
      Pick<
        MarkdownRenderOptions,
        | "includeToolCalls"
        | "includeThinking"
        | "italicizeUserMessages"
        | "truncateToolResults"
      >
    >
    & Pick<MarkdownRenderOptions, "speakerNames">,
  includeHeading: boolean,
): string {
  const parts: string[] = [];

  if (includeHeading) {
    parts.push(formatHeading(message, options.speakerNames));
    parts.push("");
  }

  const content = options.italicizeUserMessages && message.role === "user"
    ? formatUserMessageContent(message.content)
    : message.content;
  if (content.trim().length > 0) {
    parts.push(content);
  }

  if (options.includeToolCalls && message.toolCalls?.length) {
    parts.push("", "<details>", "<summary>Tool Calls</summary>", "");
    for (const call of message.toolCalls) {
      parts.push(
        `**${call.name}**${call.description ? `: ${call.description}` : ""}`,
      );
      if (call.result && call.result.length > 0) {
        parts.push(
          "",
          "```",
          truncate(call.result, options.truncateToolResults),
          "```",
        );
      }
      parts.push("");
    }
    parts.push("</details>");
  }

  if (options.includeThinking && message.thinkingBlocks?.length) {
    parts.push("", "<details>", "<summary>Thinking</summary>", "");
    for (const block of message.thinkingBlocks) {
      if (block.content.trim().length > 0) {
        parts.push(block.content.trim(), "");
      }
    }
    parts.push("</details>");
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function isEmptyMessage(
  message: Message,
  options: Required<
    Pick<MarkdownRenderOptions, "includeToolCalls" | "includeThinking">
  >,
): boolean {
  if (message.content.trim().length > 0) {
    return false;
  }
  if (options.includeToolCalls && message.toolCalls?.length) {
    return false;
  }
  if (options.includeThinking && message.thinkingBlocks?.length) {
    return false;
  }
  return true;
}

export function renderMessagesToMarkdown(
  messages: Message[],
  options: MarkdownRenderOptions = {},
): string {
  const includeFrontmatter = options.includeFrontmatter !== false;
  const includeToolCalls = options.includeToolCalls ?? true;
  const includeThinking = options.includeThinking ?? true;
  const italicizeUserMessages = options.italicizeUserMessages ?? false;
  const truncateToolResults = options.truncateToolResults ?? 4_000;

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

  let lastRole: Message["role"] | undefined;
  let lastSignature: string | undefined;

  for (const message of messages) {
    if (isEmptyMessage(message, { includeToolCalls, includeThinking })) {
      continue;
    }

    const signature = [
      message.id,
      message.role,
      message.timestamp,
      message.model ?? "",
      message.content,
    ].join("\u0000");
    if (signature === lastSignature) {
      continue;
    }

    parts.push(
      formatMessage(
        message,
        {
          includeToolCalls,
          includeThinking,
          italicizeUserMessages,
          truncateToolResults,
          speakerNames: options.speakerNames,
        },
        message.role !== lastRole,
      ),
      "",
    );
    lastRole = message.role;
    lastSignature = signature;
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
  async appendMessages(
    outputPath: string,
    messages: Message[],
    options: MarkdownRenderOptions = {},
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });

    const existing = await readExistingFile(outputPath);
    if (!existing.exists) {
      const title = options.title ?? basename(outputPath, ".md");
      const rendered = renderMessagesToMarkdown(messages, {
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

    const rendered = renderMessagesToMarkdown(messages, {
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

  async overwriteMessages(
    outputPath: string,
    messages: Message[],
    options: MarkdownRenderOptions = {},
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });

    const existingFrontmatter = await extractExistingFrontmatter(outputPath);
    if (existingFrontmatter) {
      const body = renderMessagesToMarkdown(messages, {
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
    const rendered = renderMessagesToMarkdown(messages, {
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
