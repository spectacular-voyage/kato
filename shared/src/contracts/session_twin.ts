import type { ProviderCursor } from "./ipc.ts";

export const SESSION_TWIN_SCHEMA_VERSION = 1 as const;

export type SessionTwinKind =
  | "user.message"
  | "user.kato-command"
  | "assistant.message"
  | "assistant.thinking"
  | "assistant.decision.prompt"
  | "user.decision.response"
  | "assistant.tool.call"
  | "assistant.tool.result"
  | "system.message"
  | "provider.info"
  | "provider.raw";

export type SessionTwinSourceCursor = ProviderCursor;

export interface SessionTwinEventTime {
  providerTimestamp?: string;
  capturedAt?: string;
}

export interface SessionTwinEventSource {
  providerEventType: string;
  providerEventId?: string;
  cursor: SessionTwinSourceCursor;
  emitIndex: number;
}

export interface SessionTwinEventV1 {
  schemaVersion: typeof SESSION_TWIN_SCHEMA_VERSION;
  session: {
    provider: string;
    providerSessionId: string;
    sessionId: string;
  };
  seq: number;
  kind: SessionTwinKind;
  source: SessionTwinEventSource;
  time?: SessionTwinEventTime;
  turnId?: string;
  model?: string;
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProviderCursor(value: unknown): value is ProviderCursor {
  if (!isRecord(value)) {
    return false;
  }

  const kind = value["kind"];
  const cursorValue = value["value"];

  if (kind === "byte-offset" || kind === "item-index") {
    return typeof cursorValue === "number" && Number.isFinite(cursorValue);
  }
  if (kind === "opaque") {
    return typeof cursorValue === "string";
  }
  return false;
}

const SESSION_TWIN_KINDS = new Set<SessionTwinKind>([
  "user.message",
  "user.kato-command",
  "assistant.message",
  "assistant.thinking",
  "assistant.decision.prompt",
  "user.decision.response",
  "assistant.tool.call",
  "assistant.tool.result",
  "system.message",
  "provider.info",
  "provider.raw",
]);

export function isSessionTwinKind(value: unknown): value is SessionTwinKind {
  return typeof value === "string" &&
    SESSION_TWIN_KINDS.has(value as SessionTwinKind);
}

export function isSessionTwinEventV1(
  value: unknown,
): value is SessionTwinEventV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (value["schemaVersion"] !== SESSION_TWIN_SCHEMA_VERSION) {
    return false;
  }

  const session = value["session"];
  if (!isRecord(session)) {
    return false;
  }
  if (
    !isNonEmptyString(session["provider"]) ||
    !isNonEmptyString(session["providerSessionId"]) ||
    !isNonEmptyString(session["sessionId"])
  ) {
    return false;
  }

  if (
    typeof value["seq"] !== "number" ||
    !Number.isSafeInteger(value["seq"]) ||
    value["seq"] <= 0
  ) {
    return false;
  }
  if (!isSessionTwinKind(value["kind"])) {
    return false;
  }

  const source = value["source"];
  if (!isRecord(source)) {
    return false;
  }
  if (!isNonEmptyString(source["providerEventType"])) {
    return false;
  }
  if (
    source["providerEventId"] !== undefined &&
    typeof source["providerEventId"] !== "string"
  ) {
    return false;
  }
  if (!isProviderCursor(source["cursor"])) {
    return false;
  }
  if (
    typeof source["emitIndex"] !== "number" ||
    !Number.isSafeInteger(source["emitIndex"]) ||
    source["emitIndex"] < 0
  ) {
    return false;
  }

  const time = value["time"];
  if (time !== undefined) {
    if (!isRecord(time)) {
      return false;
    }
    if (
      time["providerTimestamp"] !== undefined &&
      typeof time["providerTimestamp"] !== "string"
    ) {
      return false;
    }
    if (
      time["capturedAt"] !== undefined && typeof time["capturedAt"] !== "string"
    ) {
      return false;
    }
  }

  if (value["turnId"] !== undefined && typeof value["turnId"] !== "string") {
    return false;
  }
  if (value["model"] !== undefined && typeof value["model"] !== "string") {
    return false;
  }

  return isRecord(value["payload"]);
}

