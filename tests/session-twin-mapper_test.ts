import { assert, assertEquals } from "@std/assert";
import type { ConversationEvent } from "@kato/shared";
import {
  mapConversationEventsToTwin,
  mapTwinEventsToConversation,
} from "../apps/daemon/src/mod.ts";

function makeUserEvent(content: string): ConversationEvent {
  return {
    eventId: "u1",
    provider: "codex",
    sessionId: "provider-session-1",
    timestamp: "2026-02-26T10:00:00.000Z",
    kind: "message.user",
    role: "user",
    content,
    source: {
      providerEventType: "event_msg.user_message",
      rawCursor: { kind: "byte-offset", value: 10 },
    },
  } as ConversationEvent;
}

Deno.test("mapConversationEventsToTwin emits canonical kinds and command events", () => {
  const events: ConversationEvent[] = [
    makeUserEvent("hello\n::init /tmp/a.md\n::stop"),
    {
      eventId: "a1",
      provider: "codex",
      sessionId: "provider-session-1",
      timestamp: "2026-02-26T10:00:01.000Z",
      kind: "message.assistant",
      role: "assistant",
      content: "done",
      source: {
        providerEventType: "response_item.message",
        rawCursor: { kind: "byte-offset", value: 20 },
      },
    } as ConversationEvent,
  ];

  const twin = mapConversationEventsToTwin({
    provider: "codex",
    providerSessionId: "provider-session-1",
    sessionId: "kato-session-1",
    events,
    mode: "backfill",
  });

  assert(twin.some((event) => event.kind === "user.message"));
  assert(twin.some((event) => event.kind === "assistant.message"));
  assert(twin.some((event) => event.kind === "user.kato-command"));

  const commandEvents = twin.filter((event) =>
    event.kind === "user.kato-command"
  );
  assertEquals(commandEvents.length, 2);
  assertEquals(commandEvents[0]?.payload["command"], "init");
  assertEquals(commandEvents[1]?.payload["command"], "stop");

  // Codex backfill omits provider timestamps by policy.
  assertEquals(
    twin.some((event) => event.time?.providerTimestamp !== undefined),
    false,
  );
});

Deno.test("mapTwinEventsToConversation round-trips message events", () => {
  const twin = mapConversationEventsToTwin({
    provider: "claude",
    providerSessionId: "provider-session-2",
    sessionId: "kato-session-2",
    events: [
      {
        eventId: "u2",
        provider: "claude",
        sessionId: "provider-session-2",
        timestamp: "2026-02-26T10:00:00.000Z",
        kind: "message.user",
        role: "user",
        content: "hello",
        source: {
          providerEventType: "user",
          providerEventId: "u2",
          rawCursor: { kind: "byte-offset", value: 1 },
        },
      } as ConversationEvent,
      {
        eventId: "a2",
        provider: "claude",
        sessionId: "provider-session-2",
        timestamp: "2026-02-26T10:00:01.000Z",
        kind: "message.assistant",
        role: "assistant",
        content: "hi",
        source: {
          providerEventType: "assistant",
          providerEventId: "a2",
          rawCursor: { kind: "byte-offset", value: 2 },
        },
      } as ConversationEvent,
    ],
    mode: "live",
    capturedAt: "2026-02-26T10:00:02.000Z",
  });

  const roundTrip = mapTwinEventsToConversation(twin);
  assertEquals(roundTrip.length, 2);
  assertEquals(roundTrip[0]?.kind, "message.user");
  assertEquals(roundTrip[1]?.kind, "message.assistant");
});

Deno.test("mapConversationEventsToTwin backfill keeps capturedAt when provided", () => {
  const twin = mapConversationEventsToTwin({
    provider: "codex",
    providerSessionId: "provider-session-3",
    sessionId: "kato-session-3",
    events: [makeUserEvent("hello backfill")],
    mode: "backfill",
    capturedAt: "2026-02-26T11:00:00.000Z",
  });

  assertEquals(twin[0]?.time?.capturedAt, "2026-02-26T11:00:00.000Z");

  const roundTrip = mapTwinEventsToConversation(twin);
  assertEquals(roundTrip[0]?.timestamp, "2026-02-26T11:00:00.000Z");
});

Deno.test("mapTwinEventsToConversation uses empty timestamp for codex backfill without timestamps", () => {
  const twin = mapConversationEventsToTwin({
    provider: "codex",
    providerSessionId: "provider-session-4",
    sessionId: "kato-session-4",
    events: [makeUserEvent("hello unknown")],
    mode: "backfill",
  });

  const roundTrip = mapTwinEventsToConversation(twin);
  assertEquals(roundTrip[0]?.timestamp, "");
});
