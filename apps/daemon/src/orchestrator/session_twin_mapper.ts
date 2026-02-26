import type { ConversationEvent, SessionTwinEventV1 } from "@kato/shared";
import { detectInChatControlCommands } from "../policy/mod.ts";

type TwinEventDraft = Omit<SessionTwinEventV1, "seq">;

export interface MapConversationEventsToTwinInput {
  provider: string;
  providerSessionId: string;
  sessionId: string;
  events: ConversationEvent[];
  mode: "live" | "backfill";
  capturedAt?: string;
}

export interface TwinToConversationOptions {
  includeKatoCommandsAsUserMessages?: boolean;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function eventTimestampForTwin(
  event: ConversationEvent,
  provider: string,
  mode: "live" | "backfill",
): string | undefined {
  if (provider === "codex") {
    // Codex parser timestamps are synthetic for backprocessing; omit.
    return undefined;
  }
  if (mode === "backfill") {
    return undefined;
  }
  const timestamp = normalizeText(event.timestamp);
  return timestamp.length > 0 ? timestamp : undefined;
}

function readCapturedAt(
  mode: "live" | "backfill",
  capturedAt: string | undefined,
): string | undefined {
  if (mode !== "live") return undefined;
  const normalized = normalizeText(capturedAt);
  return normalized.length > 0 ? normalized : undefined;
}

function makeBaseDraft(
  event: ConversationEvent,
  input: MapConversationEventsToTwinInput,
  kind: SessionTwinEventV1["kind"],
  emitIndex: number,
): TwinEventDraft {
  const providerTimestamp = eventTimestampForTwin(
    event,
    input.provider,
    input.mode,
  );
  const capturedAt = readCapturedAt(input.mode, input.capturedAt);

  return {
    schemaVersion: 1,
    session: {
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      sessionId: input.sessionId,
    },
    kind,
    source: {
      providerEventType: event.source.providerEventType,
      ...(event.source.providerEventId
        ? { providerEventId: event.source.providerEventId }
        : {}),
      cursor: event.source.rawCursor ?? {
        kind: "opaque",
        value: event.eventId,
      },
      emitIndex,
    },
    ...((providerTimestamp || capturedAt)
      ? {
        time: {
          ...(providerTimestamp ? { providerTimestamp } : {}),
          ...(capturedAt ? { capturedAt } : {}),
        },
      }
      : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.kind === "message.assistant" && event.model
      ? { model: event.model }
      : {}),
    payload: {},
  };
}

function toKatoCommandPayloads(
  text: string,
): Array<Record<string, unknown>> {
  const parsed = detectInChatControlCommands(text);
  if (parsed.errors.length > 0) {
    return [{
      command: "unknown",
      parseErrors: parsed.errors.map((error) => ({
        line: error.line,
        reason: error.reason,
      })),
    }];
  }

  return parsed.commands.map((command) => {
    const payload: Record<string, unknown> = {
      command: command.name === "record" ? "start" : command.name,
    };
    if (command.argument) {
      payload["rawArgument"] = command.argument;
      const rawArgument = command.argument.trim();
      if (rawArgument.toLowerCase().startsWith("id:")) {
        payload["target"] = {
          kind: "recording-id",
          value: rawArgument.slice(3).trim(),
          match: "prefix",
        };
      } else if (rawArgument.toLowerCase().startsWith("dest:")) {
        payload["target"] = {
          kind: "destination",
          value: rawArgument.slice(5).trim(),
        };
      } else if (command.name === "stop") {
        payload["target"] = {
          kind: "ambiguous",
          value: rawArgument,
        };
      } else {
        payload["target"] = {
          kind: "destination",
          value: rawArgument,
        };
      }
    } else if (command.name === "stop") {
      payload["target"] = { kind: "all" };
    }
    return payload;
  });
}

function parseDecisionOptions(
  metadata: Record<string, unknown> | undefined,
): Array<{ label: string; description: string }> {
  const raw = metadata?.["options"];
  if (!Array.isArray(raw)) {
    return [];
  }

  const options: Array<{ label: string; description: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const label = normalizeText((entry as Record<string, unknown>)["label"]);
    if (label.length === 0) continue;
    const description = normalizeText(
      (entry as Record<string, unknown>)["description"],
    );
    options.push({ label, description });
  }
  return options;
}

function parseDecisionMetadata(
  event: Extract<ConversationEvent, { kind: "decision" }>,
): {
  providerQuestionId?: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
} {
  const metadata = event.metadata as Record<string, unknown> | undefined;
  const providerQuestionId = normalizeText(metadata?.["providerQuestionId"]);
  const options = parseDecisionOptions(metadata);
  const multiSelect = typeof metadata?.["multiSelect"] === "boolean"
    ? metadata["multiSelect"] as boolean
    : undefined;

  return {
    ...(providerQuestionId.length > 0 ? { providerQuestionId } : {}),
    options,
    ...(multiSelect !== undefined ? { multiSelect } : {}),
  };
}

export function mapConversationEventsToTwin(
  input: MapConversationEventsToTwinInput,
): SessionTwinEventV1[] {
  const drafts: TwinEventDraft[] = [];

  for (const event of input.events) {
    const emitWith = (
      kind: SessionTwinEventV1["kind"],
      payload: Record<string, unknown>,
      emitIndex: number = 0,
    ) => {
      drafts.push({
        ...makeBaseDraft(event, input, kind, emitIndex),
        payload,
      });
    };

    switch (event.kind) {
      case "message.user": {
        emitWith("user.message", {
          text: event.content,
          ...(event.phase ? { phase: event.phase } : {}),
        });
        const commands = toKatoCommandPayloads(event.content);
        for (
          let commandIndex = 0;
          commandIndex < commands.length;
          commandIndex++
        ) {
          emitWith(
            "user.kato-command",
            commands[commandIndex]!,
            commandIndex + 1,
          );
        }
        break;
      }
      case "message.assistant":
        emitWith("assistant.message", {
          text: event.content,
          ...(event.phase ? { phase: event.phase } : {}),
        });
        break;
      case "thinking":
        emitWith("assistant.thinking", { text: event.content });
        break;
      case "tool.call":
        emitWith("assistant.tool.call", {
          toolCallId: event.toolCallId,
          name: event.name,
          ...(event.description ? { description: event.description } : {}),
          ...(event.input ? { input: event.input } : {}),
        });
        break;
      case "tool.result":
        emitWith("assistant.tool.result", {
          toolCallId: event.toolCallId,
          result: event.result,
        });
        break;
      case "decision": {
        const metadata = parseDecisionMetadata(event);
        if (event.status === "proposed" && event.decidedBy === "assistant") {
          emitWith("assistant.decision.prompt", {
            decisionId: event.decisionId,
            decisionKey: event.decisionKey,
            prompt: event.summary,
            ...(metadata.providerQuestionId
              ? { providerQuestionId: metadata.providerQuestionId }
              : {}),
            ...(metadata.options.length > 0
              ? { options: metadata.options }
              : {}),
            ...(metadata.multiSelect !== undefined
              ? { multiSelect: metadata.multiSelect }
              : {}),
          });
        } else if (event.status === "accepted" && event.decidedBy === "user") {
          emitWith("user.decision.response", {
            decisionId: event.decisionId,
            decisionKey: event.decisionKey,
            selection: event.summary,
            ...(metadata.providerQuestionId
              ? { providerQuestionId: metadata.providerQuestionId }
              : {}),
          });
        } else {
          emitWith("provider.raw", {
            rawType: "decision.unmodeled",
            decision: {
              decisionId: event.decisionId,
              decisionKey: event.decisionKey,
              summary: event.summary,
              status: event.status,
              decidedBy: event.decidedBy,
              basisEventIds: event.basisEventIds,
              metadata: event.metadata,
            },
          });
        }
        break;
      }
      case "message.system":
        emitWith("system.message", { text: event.content });
        break;
      case "provider.info":
        emitWith("provider.info", {
          text: event.content,
          ...(event.subtype ? { subtype: event.subtype } : {}),
          ...(event.level ? { level: event.level } : {}),
        });
        break;
      default:
        emitWith("provider.raw", {
          rawType: (event as { kind: string }).kind,
          raw: event,
        });
        break;
    }
  }

  return drafts.map((draft, index) => ({
    ...draft,
    // Re-assigned by the append path; kept stable for intermediate operations.
    seq: index + 1,
  }));
}

function readTimestamp(event: SessionTwinEventV1): string {
  const fromProvider = normalizeText(event.time?.providerTimestamp);
  if (fromProvider.length > 0) return fromProvider;
  const fromCapturedAt = normalizeText(event.time?.capturedAt);
  if (fromCapturedAt.length > 0) return fromCapturedAt;
  return "";
}

function makeEventId(event: SessionTwinEventV1): string {
  return `${event.session.sessionId}:${event.seq}:${event.kind}`;
}

export function mapTwinEventsToConversation(
  events: SessionTwinEventV1[],
  options: TwinToConversationOptions = {},
): ConversationEvent[] {
  const includeKatoCommandsAsUserMessages =
    options.includeKatoCommandsAsUserMessages ?? false;
  const output: ConversationEvent[] = [];

  for (const event of events) {
    const common = {
      eventId: makeEventId(event),
      provider: event.session.provider,
      sessionId: event.session.providerSessionId,
      timestamp: readTimestamp(event),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      source: {
        providerEventType: event.source.providerEventType,
        ...(event.source.providerEventId
          ? { providerEventId: event.source.providerEventId }
          : {}),
        rawCursor: event.source.cursor,
      },
    };

    switch (event.kind) {
      case "user.message": {
        const text = normalizeText(event.payload["text"]);
        if (text.length === 0) continue;
        output.push({
          ...common,
          kind: "message.user",
          role: "user",
          content: text,
          ...(typeof event.payload["phase"] === "string"
            ? {
              phase: event.payload["phase"] as "commentary" | "final" | "other",
            }
            : {}),
        } as ConversationEvent);
        break;
      }
      case "user.kato-command": {
        if (!includeKatoCommandsAsUserMessages) {
          continue;
        }
        const command = normalizeText(event.payload["command"]);
        if (command.length === 0) continue;
        output.push({
          ...common,
          kind: "message.user",
          role: "user",
          content: `::${command}`,
        } as ConversationEvent);
        break;
      }
      case "assistant.message": {
        const text = normalizeText(event.payload["text"]);
        if (text.length === 0) continue;
        output.push({
          ...common,
          kind: "message.assistant",
          role: "assistant",
          content: text,
          ...(event.model ? { model: event.model } : {}),
          ...(typeof event.payload["phase"] === "string"
            ? {
              phase: event.payload["phase"] as "commentary" | "final" | "other",
            }
            : {}),
        } as ConversationEvent);
        break;
      }
      case "assistant.thinking": {
        const text = normalizeText(event.payload["text"]);
        if (text.length === 0) continue;
        output.push({
          ...common,
          kind: "thinking",
          content: text,
        } as ConversationEvent);
        break;
      }
      case "assistant.tool.call": {
        const toolCallId = normalizeText(event.payload["toolCallId"]);
        const name = normalizeText(event.payload["name"]);
        if (toolCallId.length === 0 || name.length === 0) continue;
        output.push({
          ...common,
          kind: "tool.call",
          toolCallId,
          name,
          ...(typeof event.payload["description"] === "string"
            ? { description: event.payload["description"] as string }
            : {}),
          ...(typeof event.payload["input"] === "object" &&
              event.payload["input"] !== null &&
              !Array.isArray(event.payload["input"])
            ? { input: event.payload["input"] as Record<string, unknown> }
            : {}),
        } as ConversationEvent);
        break;
      }
      case "assistant.tool.result": {
        const toolCallId = normalizeText(event.payload["toolCallId"]);
        if (toolCallId.length === 0) continue;
        output.push({
          ...common,
          kind: "tool.result",
          toolCallId,
          result: String(event.payload["result"] ?? ""),
        } as ConversationEvent);
        break;
      }
      case "assistant.decision.prompt": {
        const summary = normalizeText(event.payload["prompt"]);
        if (summary.length === 0) continue;
        const decisionId = normalizeText(event.payload["decisionId"]) ||
          makeEventId(event);
        const decisionKey = normalizeText(event.payload["decisionKey"]) ||
          `decision-${event.seq}`;
        output.push({
          ...common,
          kind: "decision",
          decisionId,
          decisionKey,
          summary,
          status: "proposed",
          decidedBy: "assistant",
          basisEventIds: [makeEventId(event)],
          metadata: {
            ...(event.payload["providerQuestionId"] !== undefined
              ? { providerQuestionId: event.payload["providerQuestionId"] }
              : {}),
            ...(event.payload["options"] !== undefined
              ? { options: event.payload["options"] }
              : {}),
            ...(event.payload["multiSelect"] !== undefined
              ? { multiSelect: event.payload["multiSelect"] }
              : {}),
          },
        } as ConversationEvent);
        break;
      }
      case "user.decision.response": {
        const summary = normalizeText(event.payload["selection"]);
        if (summary.length === 0) continue;
        const decisionId = normalizeText(event.payload["decisionId"]) ||
          makeEventId(event);
        const decisionKey = normalizeText(event.payload["decisionKey"]) ||
          `decision-${event.seq}`;
        output.push({
          ...common,
          kind: "decision",
          decisionId,
          decisionKey,
          summary,
          status: "accepted",
          decidedBy: "user",
          basisEventIds: [makeEventId(event)],
          metadata: {
            ...(event.payload["providerQuestionId"] !== undefined
              ? { providerQuestionId: event.payload["providerQuestionId"] }
              : {}),
          },
        } as ConversationEvent);
        break;
      }
      case "system.message": {
        const text = normalizeText(event.payload["text"]);
        if (text.length === 0) continue;
        output.push({
          ...common,
          kind: "message.system",
          role: "system",
          content: text,
        } as ConversationEvent);
        break;
      }
      case "provider.info": {
        const text = normalizeText(event.payload["text"]);
        if (text.length === 0) continue;
        output.push({
          ...common,
          kind: "provider.info",
          content: text,
          ...(typeof event.payload["subtype"] === "string"
            ? { subtype: event.payload["subtype"] as string }
            : {}),
          ...(typeof event.payload["level"] === "string"
            ? { level: event.payload["level"] as string }
            : {}),
        } as ConversationEvent);
        break;
      }
      case "provider.raw":
      default:
        continue;
    }
  }

  return output;
}
