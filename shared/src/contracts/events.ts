import type { ProviderCursor } from "./ipc.ts";

export type ConversationEventKind =
  | "message.user"
  | "message.assistant"
  | "message.system"
  | "tool.call"
  | "tool.result"
  | "thinking"
  | "decision"
  | "provider.info";

export type DecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "superseded";

export interface ConversationEventSource {
  providerEventType: string;
  providerEventId?: string;
  rawCursor?: ProviderCursor;
}

export interface DecisionPayload {
  decisionId: string;
  decisionKey: string;
  summary: string;
  status: DecisionStatus;
  decidedBy: string;
  basisEventIds: string[];
  metadata?: Record<string, unknown>;
}

interface ConversationEventBase {
  eventId: string;
  provider: string;
  sessionId: string;
  timestamp: string;
  kind: ConversationEventKind;
  turnId?: string;
  source: ConversationEventSource;
}

export type ConversationEvent =
  | (ConversationEventBase & {
    kind: "message.user";
    role: "user";
    content: string;
    phase?: "commentary" | "final" | "other";
  })
  | (ConversationEventBase & {
    kind: "message.assistant";
    role: "assistant";
    content: string;
    model?: string;
    phase?: "commentary" | "final" | "other";
  })
  | (ConversationEventBase & {
    kind: "message.system";
    role: "system";
    content: string;
  })
  | (ConversationEventBase & {
    kind: "tool.call";
    toolCallId: string;
    name: string;
    description?: string;
    input?: Record<string, unknown>;
  })
  | (ConversationEventBase & {
    kind: "tool.result";
    toolCallId: string;
    result: string;
  })
  | (ConversationEventBase & {
    kind: "thinking";
    content: string;
  })
  | (ConversationEventBase & DecisionPayload & {
    kind: "decision";
  })
  | (ConversationEventBase & {
    kind: "provider.info";
    content: string;
    subtype?: string;
    level?: string;
  });
