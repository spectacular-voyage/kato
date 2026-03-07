import { assertEquals } from "@std/assert";
import type { ConversationEvent } from "@kato/shared";
import { mergeEvents } from "../apps/daemon/src/orchestrator/provider_ingestion_merge.ts";

function makeAssistantEvent(
  id: string,
  timestamp: string | undefined,
  content: string,
  overrides: Partial<ConversationEvent> = {},
): ConversationEvent {
  return {
    eventId: id,
    provider: "test-provider",
    sessionId: "sess-test",
    ...(timestamp ? { timestamp } : {}),
    kind: "message.assistant",
    role: "assistant",
    content,
    source: {
      providerEventType: "assistant",
      providerEventId: id,
      rawCursor: { kind: "byte-offset", value: 10 },
    },
    ...overrides,
  } as ConversationEvent;
}

Deno.test("mergeEvents suppresses duplicate replayed messages", () => {
  const existing = [
    makeAssistantEvent("m1", "2026-02-22T20:15:00.000Z", "same-content"),
  ];
  const incoming = [
    makeAssistantEvent("m1", "2026-02-22T20:15:00.000Z", "same-content", {
      source: {
        providerEventType: "assistant",
        providerEventId: "m1",
        rawCursor: { kind: "byte-offset", value: 20 },
      },
    } as Partial<ConversationEvent>),
  ];

  assertEquals(mergeEvents(existing, incoming), {
    mergedEvents: existing,
    droppedEvents: 1,
  });
});

Deno.test("mergeEvents keeps cross-kind events when dedupe fields collide", () => {
  const sharedSource = {
    providerEventType: "assistant",
    rawCursor: { kind: "byte-offset" as const, value: 10 },
  };
  const sharedTimestamp = "2026-02-22T20:15:00.000Z";

  const result = mergeEvents([], [
    {
      eventId: "collision",
      provider: "test-provider",
      sessionId: "sess-test",
      timestamp: sharedTimestamp,
      kind: "message.assistant",
      role: "assistant",
      content: "same-content",
      source: sharedSource,
    } as ConversationEvent,
    {
      eventId: "collision",
      provider: "test-provider",
      sessionId: "sess-test",
      timestamp: sharedTimestamp,
      kind: "thinking",
      content: "same-content",
      source: sharedSource,
    } as ConversationEvent,
  ]);

  assertEquals(result.droppedEvents, 0);
  assertEquals(
    result.mergedEvents.map((event) => event.kind),
    ["message.assistant", "thinking"],
  );
});

Deno.test("mergeEvents keeps distinct events when provider ids and timestamps are missing", () => {
  const result = mergeEvents([], [
    makeAssistantEvent("e1", undefined, "same-content", {
      turnId: "turn-1",
      source: {
        providerEventType: "assistant",
        rawCursor: { kind: "byte-offset", value: 10 },
      },
    } as Partial<ConversationEvent>),
    makeAssistantEvent("e2", undefined, "same-content", {
      turnId: "turn-2",
      source: {
        providerEventType: "assistant",
        rawCursor: { kind: "byte-offset", value: 20 },
      },
    } as Partial<ConversationEvent>),
  ]);

  assertEquals(result.droppedEvents, 0);
  assertEquals(result.mergedEvents.length, 2);
});

Deno.test("mergeEvents can ignore timestamp and cursor for compaction-style replays", () => {
  const existing = [
    {
      eventId: "existing-first",
      provider: "codex",
      sessionId: "session-codex-compaction",
      timestamp: "2026-02-26T10:00:00.000Z",
      kind: "message.user",
      role: "user",
      content: "first message",
      source: {
        providerEventType: "event_msg.user_message",
        rawCursor: { kind: "byte-offset", value: 25_010 },
      },
    } as ConversationEvent,
  ];
  const incoming = [
    {
      eventId: "replay-duplicate-first",
      provider: "codex",
      sessionId: "session-codex-compaction",
      timestamp: "2026-02-26T10:00:10.000Z",
      kind: "message.user",
      role: "user",
      content: "first message",
      source: {
        providerEventType: "event_msg.user_message",
        rawCursor: { kind: "byte-offset", value: 27_000 },
      },
    } as ConversationEvent,
  ];

  assertEquals(
    mergeEvents(existing, incoming, {
      ignoreTimestamp: true,
      ignoreCursor: true,
    }),
    {
      mergedEvents: existing,
      droppedEvents: 1,
    },
  );
});
