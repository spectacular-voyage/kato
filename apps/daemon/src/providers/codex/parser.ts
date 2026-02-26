import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import { normalizeText, utf8ByteLength } from "../../utils/text.ts";

interface CodexEntry {
  type: string;
  payload?: Record<string, unknown>;
}

interface PendingRequestUserInputCall {
  callEventId: string;
  questions: Array<Record<string, unknown>>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asQuestionList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> =>
    isRecord(item)
  );
}

function normalizeDecisionKey(raw: string, fallbackIndex: number): string {
  const compact = raw.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact.length > 0 ? compact : `decision-${fallbackIndex + 1}`;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asAnswerList(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }
  if (!isRecord(value)) {
    return [];
  }

  const fromAnswers = Array.isArray(value["answers"])
    ? (value["answers"] as unknown[])
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0)
    : [];

  const fromOtherFields = Object.entries(value)
    .filter(([key]) => key !== "answers")
    .flatMap(([, entry]) => {
      if (typeof entry === "string") {
        const text = entry.trim();
        return text.length > 0 ? [text] : [];
      }
      if (Array.isArray(entry)) {
        return entry
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0);
      }
      return [];
    });

  return [...fromAnswers, ...fromOtherFields];
}

function extractRequestUserInputAnswers(
  output: unknown,
): Record<string, string[]> | undefined {
  const parsed = parseMaybeJson(output);
  if (!isRecord(parsed)) {
    return undefined;
  }

  const answers = parsed["answers"];
  if (!isRecord(answers)) {
    return undefined;
  }

  const normalized: Record<string, string[]> = {};
  for (const [questionId, answerValue] of Object.entries(answers)) {
    if (!isRecord(answerValue) || !("answers" in answerValue)) {
      continue;
    }
    const selectedAnswers = asAnswerList(answerValue);
    if (selectedAnswers.length > 0) {
      normalized[questionId] = selectedAnswers;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function findQuestionEntry(
  questions: Array<Record<string, unknown>>,
  key: string,
): Record<string, unknown> | undefined {
  return questions.find((question) =>
    String(question["id"] ?? "") === key ||
    String(question["question"] ?? "") === key
  );
}

function asQuestionOptions(question: Record<string, unknown>): Array<{
  label: string;
  description: string;
}> {
  return asQuestionList(question["options"]).map((option) => ({
    label: String(option["label"] ?? ""),
    description: String(option["description"] ?? ""),
  }));
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

  let turnFinalized = false;

  let currentByteOffset = 0;
  const timestamp = new Date().toISOString();
  const pendingRequestUserInputCalls = new Map<
    string,
    PendingRequestUserInputCall
  >();

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

  function* finalizeAssistant(
    text: string,
    lineEnd: number,
    providerEventType: string,
    phase: "final" | "commentary",
  ): Generator<{ event: ConversationEvent; cursor: ProviderCursor }> {
    if (turnFinalized || lineEnd <= fromOffset) return;
    turnFinalized = true;
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

  function* emitAssistantCommentary(
    text: string,
    lineEnd: number,
    providerEventType: string,
  ): Generator<{ event: ConversationEvent; cursor: ProviderCursor }> {
    if (lineEnd <= fromOffset || turnFinalized) return;
    const normalized = normalizeText(text);
    if (normalized.length === 0) return;
    const base = makeBase("message.assistant", providerEventType, lineEnd);
    yield {
      event: {
        ...base,
        kind: "message.assistant",
        role: "assistant",
        content: normalized,
        ...(model ? { model } : {}),
        phase: "commentary",
      } as unknown as ConversationEvent,
      cursor: makeByteOffsetCursor(lineEnd),
    };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const hasNewline = i < lines.length - 1;
    const lineBytes = utf8ByteLength(line) + (hasNewline ? 1 : 0);
    const lineEnd = currentByteOffset + lineBytes;
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
            turnFinalized = false;

            const savedTurnId = currentTurnId;
            currentTurnId = undefined;

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
            turnFinalized = false;
            currentTurnId = undefined;
          }
        } else if (msgType === "agent_message") {
          const text = String(payload["message"] ?? "");
          yield* emitAssistantCommentary(
            text,
            lineEnd,
            "event_msg.agent_message",
          );
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

          const questions = name === "request_user_input"
            ? asQuestionList(input?.["questions"])
            : [];
          if (name === "request_user_input" && callId.length > 0) {
            pendingRequestUserInputCalls.set(callId, {
              callEventId: makeEventId(sessionId, lineEnd, "tool.call"),
              questions,
            });
          }

          if (lineEnd <= fromOffset) {
            break;
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

          if (name === "request_user_input" && questions.length > 0) {
            let decisionIndex = 1;
            for (const question of questions) {
              const questionText = String(question["question"] ?? "").trim();
              if (questionText.length === 0) continue;
              const questionHeader = String(question["header"] ?? "").trim();
              const options = asQuestionOptions(question);
              const questionId = String(question["id"] ?? "").trim();
              const providerQuestionId = questionId.length > 0
                ? questionId
                : normalizeDecisionKey(questionText, decisionIndex);

              const decisionBase = makeBase(
                "decision",
                "response_item.function_call.request_user_input",
                lineEnd,
                decisionIndex,
              );
              yield {
                event: {
                  ...decisionBase,
                  kind: "decision",
                  decisionId: makeEventId(
                    sessionId,
                    lineEnd,
                    "decision",
                    decisionIndex,
                  ),
                  decisionKey: normalizeDecisionKey(
                    providerQuestionId,
                    decisionIndex,
                  ),
                  summary: questionText,
                  status: "proposed",
                  decidedBy: "assistant",
                  basisEventIds: [String(base["eventId"])],
                  metadata: {
                    providerQuestionId,
                    ...(questionHeader.length > 0
                      ? { header: questionHeader }
                      : {}),
                    ...(options.length > 0 ? { options } : {}),
                    ...(typeof question["multiSelect"] === "boolean"
                      ? { multiSelect: question["multiSelect"] }
                      : {}),
                  },
                } as unknown as ConversationEvent,
                cursor: makeByteOffsetCursor(lineEnd),
              };
              decisionIndex += 1;
            }
          }
        } else if (itemType === "function_call_output") {
          const callId = String(payload["call_id"] ?? "");
          const output = payload["output"];
          const pending = callId.length > 0
            ? pendingRequestUserInputCalls.get(callId)
            : undefined;
          if (callId.length > 0) {
            pendingRequestUserInputCalls.delete(callId);
          }
          const parsedAnswers = extractRequestUserInputAnswers(output);

          if (lineEnd <= fromOffset) {
            break;
          }

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

          // Synthesize request_user_input selections as first-class conversation events.
          if (pending || parsedAnswers) {
            const questions = pending?.questions ?? [];
            const basisEventIds = [
              ...(pending?.callEventId ? [pending.callEventId] : []),
              String(base["eventId"]),
            ];

            if (parsedAnswers) {
              const answerPairs = Object.entries(parsedAnswers);
              if (answerPairs.length > 0) {
                let decisionIndex = 1;
                for (const [key, selected] of answerPairs) {
                  const questionEntry = findQuestionEntry(questions, key);
                  const questionText = questionEntry
                    ? String(questionEntry["question"] ?? key)
                    : key;
                  const questionId = questionEntry
                    ? String(questionEntry["id"] ?? "").trim()
                    : "";
                  const providerQuestionId = questionId.length > 0
                    ? questionId
                    : key;
                  const summary = `${questionText} -> ${selected.join(", ")}`;
                  const questionHeader = questionEntry
                    ? String(questionEntry["header"] ?? "")
                    : "";
                  const options = questionEntry
                    ? asQuestionOptions(questionEntry)
                    : [];

                  const decisionBase = makeBase(
                    "decision",
                    "response_item.function_call_output.request_user_input",
                    lineEnd,
                    decisionIndex,
                  );
                  yield {
                    event: {
                      ...decisionBase,
                      kind: "decision",
                      decisionId: makeEventId(
                        sessionId,
                        lineEnd,
                        "decision",
                        decisionIndex,
                      ),
                      decisionKey: normalizeDecisionKey(
                        providerQuestionId,
                        decisionIndex,
                      ),
                      summary,
                      status: "accepted",
                      decidedBy: "user",
                      basisEventIds,
                      metadata: {
                        providerQuestionId,
                        ...(questionHeader.length > 0
                          ? { header: questionHeader }
                          : {}),
                        ...(options.length > 0 ? { options } : {}),
                        ...(questionEntry &&
                            typeof questionEntry["multiSelect"] === "boolean"
                          ? { multiSelect: questionEntry["multiSelect"] }
                          : {}),
                      },
                    } as unknown as ConversationEvent,
                    cursor: makeByteOffsetCursor(lineEnd),
                  };
                  decisionIndex += 1;
                }
              }
            } else if (pending) {
              const rawOutput = String(
                typeof output === "string" ? output : JSON.stringify(output),
              ).trim();
              if (rawOutput.length > 0) {
                const fallbackQuestion = pending.questions.length === 1
                  ? String(pending.questions[0]?.["question"] ?? "").trim()
                  : "";
                const fallbackContent = fallbackQuestion.length > 0
                  ? `- ${fallbackQuestion}: ${rawOutput}`
                  : rawOutput;
                const userBase = makeBase(
                  "message.user",
                  "response_item.function_call_output.request_user_input",
                  lineEnd,
                  1,
                );
                yield {
                  event: {
                    ...userBase,
                    kind: "message.user",
                    role: "user",
                    content: fallbackContent,
                    phase: "other",
                  } as unknown as ConversationEvent,
                  cursor: makeByteOffsetCursor(lineEnd),
                };
              }
            }
          }
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
        const questionsList = Array.isArray(questions)
          ? questions as Array<Record<string, unknown>>
          : [];

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

        let decisionIndex = 1;
        for (const question of questionsList) {
          const questionText = String(question["question"] ?? "").trim();
          if (questionText.length === 0) continue;
          const questionHeader = String(question["header"] ?? "").trim();
          const options = asQuestionOptions(question);
          const questionId = String(question["id"] ?? "").trim();
          const providerQuestionId = questionId.length > 0
            ? questionId
            : normalizeDecisionKey(questionText, decisionIndex);
          const proposedDecisionBase = makeBase(
            "decision",
            "request_user_input",
            lineEnd,
            decisionIndex,
          );
          const proposedDecisionId = makeEventId(
            sessionId,
            lineEnd,
            "decision",
            decisionIndex,
          );
          yield {
            event: {
              ...proposedDecisionBase,
              kind: "decision",
              decisionId: proposedDecisionId,
              decisionKey: normalizeDecisionKey(
                providerQuestionId,
                decisionIndex,
              ),
              summary: questionText,
              status: "proposed",
              decidedBy: "assistant",
              basisEventIds: [String(toolCallBase["eventId"])],
              metadata: {
                providerQuestionId,
                ...(questionHeader.length > 0
                  ? { header: questionHeader }
                  : {}),
                ...(options.length > 0 ? { options } : {}),
                ...(typeof question["multiSelect"] === "boolean"
                  ? { multiSelect: question["multiSelect"] }
                  : {}),
              },
            } as unknown as ConversationEvent,
            cursor: makeByteOffsetCursor(lineEnd),
          };
          decisionIndex += 1;
        }

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
          // decision events: one per answered question
          for (const [key, val] of Object.entries(answersRecord)) {
            const questionEntry = questionsList.find((q) => q["id"] === key);
            const questionText = questionEntry
              ? String(questionEntry["question"] ?? key)
              : key;
            const questionId = questionEntry
              ? String(questionEntry["id"] ?? "").trim()
              : "";
            const providerQuestionId = questionId.length > 0 ? questionId : key;
            const questionHeader = questionEntry
              ? String(questionEntry["header"] ?? "")
              : "";
            const options = questionEntry
              ? asQuestionOptions(questionEntry)
              : [];
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
                decisionKey: normalizeDecisionKey(
                  providerQuestionId,
                  decisionIndex,
                ),
                summary: `${questionText} → ${String(val)}`,
                status: "accepted",
                decidedBy: "user",
                basisEventIds: [
                  String(toolCallBase["eventId"]),
                  String(toolResultBase["eventId"]),
                ],
                metadata: {
                  providerQuestionId,
                  ...(questionHeader.length > 0
                    ? { header: questionHeader }
                    : {}),
                  ...(options.length > 0 ? { options } : {}),
                  ...(questionEntry &&
                      typeof questionEntry["multiSelect"] === "boolean"
                    ? { multiSelect: questionEntry["multiSelect"] }
                    : {}),
                },
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
}
