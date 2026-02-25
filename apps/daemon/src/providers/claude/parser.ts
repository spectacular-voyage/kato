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
  toolUseResult?: unknown;
  message?: {
    role: string;
    model?: string;
    content?: unknown;
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

function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(text: string): string {
  return stripAnsi(text)
    .replace(
      /<(?:ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/(?:ide_opened_file|ide_selection|system-reminder)>/g,
      "",
    )
    .trim();
}

function asContentBlocks(content: unknown): RawContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((block): block is RawContentBlock =>
    typeof block === "object" &&
    block !== null &&
    typeof (block as { type?: unknown }).type === "string"
  );
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return cleanText(content);
  }

  const blocks = asContentBlocks(content);
  return blocks
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

function asQuestionList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

function asAnswersRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value;
}

function normalizeDecisionKey(raw: string, fallbackIndex: number): string {
  const compact = raw.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact.length > 0 ? compact : `decision-${fallbackIndex + 1}`;
}

function extractQuestionnairePayload(entry: RawEntry): {
  questions: Array<Record<string, unknown>>;
  answers: Record<string, unknown>;
} | undefined {
  if (!isRecord(entry.toolUseResult)) {
    return undefined;
  }
  const questions = asQuestionList(entry.toolUseResult["questions"]);
  const answers = asAnswersRecord(entry.toolUseResult["answers"]);
  if (!answers) {
    return undefined;
  }
  return { questions, answers };
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
      const text = extractText(entry.message?.content);
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

    const blocks = asContentBlocks(entry.message?.content);

    if (entry.type === "user") {
      // Extract text content → message.user
      const text = extractText(entry.message?.content);
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

      // Extract tool_result blocks → tool.result events
      let toolResultIndex = 0;
      const toolResultEventIds: string[] = [];
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const toolUseId = String(block["tool_use_id"] ?? "");
        const resultText = extractToolResultText(block["content"]);
        const toolResultEventId = makeEventId(turnId, "tool.result", toolResultIndex);
        yield {
          event: {
            ...makeBase("tool.result", toolResultIndex),
            kind: "tool.result",
            toolCallId: toolUseId,
            result: resultText,
          } as unknown as ConversationEvent,
          cursor,
        };
        toolResultEventIds.push(toolResultEventId);
        toolResultIndex += 1;
      }

      // Claude AskUserQuestion answers live in top-level toolUseResult payload.
      const questionnaire = extractQuestionnairePayload(entry);
      if (questionnaire) {
        const { questions, answers } = questionnaire;
        const answerPairs = Object.entries(answers);
        if (answerPairs.length > 0) {
          const answeredLines = answerPairs.map(([key, value]) => {
            const questionEntry = questions.find((question) =>
              String(question["id"] ?? "") === key ||
              String(question["question"] ?? "") === key
            );
            const questionText = questionEntry
              ? String(questionEntry["question"] ?? key)
              : key;
            return `- ${questionText}: ${String(value)}`;
          }).join("\n");

          yield {
            event: {
              ...makeBase("message.user", 1),
              kind: "message.user",
              role: "user",
              content: answeredLines,
              phase: "other",
            } as unknown as ConversationEvent,
            cursor,
          };

          let decisionIndex = 0;
          for (const [key, value] of answerPairs) {
            const questionEntry = questions.find((question) =>
              String(question["id"] ?? "") === key ||
              String(question["question"] ?? "") === key
            );
            const questionText = questionEntry
              ? String(questionEntry["question"] ?? key)
              : key;
            const questionHeader = questionEntry
              ? String(questionEntry["header"] ?? "")
              : "";
            const options = questionEntry
              ? asQuestionList(questionEntry["options"]).map((option) => ({
                label: String(option["label"] ?? ""),
                description: String(option["description"] ?? ""),
              }))
              : [];

            yield {
              event: {
                ...makeBase("decision", decisionIndex),
                kind: "decision",
                decisionId: makeEventId(turnId, "decision", decisionIndex),
                decisionKey: normalizeDecisionKey(key, decisionIndex),
                summary: `${questionText} -> ${String(value)}`,
                status: "accepted",
                decidedBy: "user",
                basisEventIds: [...toolResultEventIds],
                metadata: {
                  providerQuestionId: key,
                  ...(questionHeader.length > 0 ? { header: questionHeader } : {}),
                  ...(options.length > 0 ? { options } : {}),
                },
              } as unknown as ConversationEvent,
              cursor,
            };
            decisionIndex += 1;
          }
        }
      }
    } else if (entry.type === "assistant") {
      const model = entry.message?.model;

      // Extract text → message.assistant
      const text = extractText(entry.message?.content);
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
      let decisionIndex = 0;
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const name = String(block["name"] ?? "unknown");
        const input = block["input"] as Record<string, unknown> | undefined;
        const toolCallId = String(
          block["id"] ?? makeEventId(turnId, "tool.call", toolCallIndex),
        );
        const toolCallEventId = makeEventId(turnId, "tool.call", toolCallIndex);
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

        if (name === "AskUserQuestion" && input) {
          const questions = asQuestionList(input["questions"]);
          for (const question of questions) {
            const questionText = String(question["question"] ?? "").trim();
            if (questionText.length === 0) continue;
            const questionHeader = String(question["header"] ?? "").trim();
            const options = asQuestionList(question["options"]).map((option) => ({
              label: String(option["label"] ?? ""),
              description: String(option["description"] ?? ""),
            }));

            yield {
              event: {
                ...makeBase("decision", decisionIndex),
                kind: "decision",
                decisionId: makeEventId(turnId, "decision", decisionIndex),
                decisionKey: normalizeDecisionKey(questionText, decisionIndex),
                summary: questionText,
                status: "proposed",
                decidedBy: "assistant",
                basisEventIds: [toolCallEventId],
                metadata: {
                  ...(questionHeader.length > 0 ? { header: questionHeader } : {}),
                  ...(options.length > 0 ? { options } : {}),
                  ...(typeof question["multiSelect"] === "boolean"
                    ? { multiSelect: question["multiSelect"] }
                    : {}),
                },
              } as unknown as ConversationEvent,
              cursor,
            };
            decisionIndex += 1;
          }
        }

        toolCallIndex += 1;
      }
    }
  }
}
