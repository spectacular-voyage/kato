import { assertEquals, assertExists, assertThrows } from "@std/assert";
import type { ConversationEvent } from "@kato/shared";
import { InMemorySessionSnapshotStore } from "../apps/daemon/src/mod.ts";

function makeEvent(
  id: string,
  timestamp: string,
): ConversationEvent {
  return {
    eventId: id,
    provider: "test",
    sessionId: "session-a",
    timestamp,
    kind: "message.assistant",
    role: "assistant",
    content: `${id}-content`,
    source: { providerEventType: "assistant", providerEventId: id },
  } as unknown as ConversationEvent;
}

Deno.test("InMemorySessionSnapshotStore upserts and returns isolated snapshots", () => {
  const store = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T19:22:00.000Z"),
  });

  const stored = store.upsert({
    provider: "codex",
    sessionId: "session-a",
    cursor: { kind: "byte-offset", value: 128 },
    events: [
      makeEvent("m1", "2026-02-22T19:20:00.000Z"),
      makeEvent("m2", "2026-02-22T19:21:00.000Z"),
    ],
  });

  assertEquals(stored.provider, "codex");
  assertEquals(stored.sessionId, "session-a");
  assertEquals(stored.cursor, { kind: "byte-offset", value: 128 });
  assertEquals(stored.conversationSchemaVersion, 2);
  assertEquals(stored.events.length, 2);
  assertEquals(stored.metadata, {
    updatedAt: "2026-02-22T19:22:00.000Z",
    eventCount: 2,
    truncatedEvents: 0,
    lastEventAt: "2026-02-22T19:21:00.000Z",
  });

  const loaded = store.get("session-a");
  assertExists(loaded);
  assertEquals(loaded, stored);

  // Mutation isolation: modifying the returned snapshot should not affect the store.
  (loaded.events[0] as unknown as Record<string, unknown>)["content"] =
    "mutated";
  loaded.metadata.eventCount = 999;
  const reloaded = store.get("session-a");
  assertExists(reloaded);
  assertEquals(
    (reloaded.events[0] as unknown as Record<string, unknown>)["content"],
    "m1-content",
  );
  assertEquals(reloaded.metadata.eventCount, 2);

  const listed = store.list();
  assertEquals(listed.length, 1);
  assertEquals(listed[0]?.sessionId, "session-a");
});

Deno.test("InMemorySessionSnapshotStore enforces bounded event windows", () => {
  const store = new InMemorySessionSnapshotStore({
    retention: {
      maxSessions: 10,
      maxEventsPerSession: 2,
    },
    now: () => new Date("2026-02-22T19:30:00.000Z"),
  });

  const stored = store.upsert({
    provider: "claude",
    sessionId: "session-window",
    cursor: { kind: "item-index", value: 10 },
    events: [
      makeEvent("m1", "2026-02-22T19:27:00.000Z"),
      makeEvent("m2", "2026-02-22T19:28:00.000Z"),
      makeEvent("m3", "2026-02-22T19:29:00.000Z"),
    ],
  });

  assertEquals(
    stored.events.map((e) => e.eventId),
    ["m2", "m3"],
  );
  assertEquals(stored.metadata, {
    updatedAt: "2026-02-22T19:30:00.000Z",
    eventCount: 2,
    truncatedEvents: 1,
    lastEventAt: "2026-02-22T19:29:00.000Z",
  });
});

Deno.test("InMemorySessionSnapshotStore omits lastEventAt for empty event lists", () => {
  const store = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T19:31:00.000Z"),
  });

  const stored = store.upsert({
    provider: "claude",
    sessionId: "session-empty",
    cursor: { kind: "item-index", value: 0 },
    events: [],
  });

  assertEquals(stored.metadata.updatedAt, "2026-02-22T19:31:00.000Z");
  assertEquals(stored.metadata.eventCount, 0);
  assertEquals(stored.metadata.truncatedEvents, 0);
  assertEquals("lastEventAt" in stored.metadata, false);
});

Deno.test("InMemorySessionSnapshotStore evicts least recently upserted sessions", () => {
  const nowValues = [
    "2026-02-22T19:40:00.000Z",
    "2026-02-22T19:41:00.000Z",
    "2026-02-22T19:42:00.000Z",
    "2026-02-22T19:43:00.000Z",
  ];
  let nowIndex = 0;
  const store = new InMemorySessionSnapshotStore({
    retention: {
      maxSessions: 2,
      maxEventsPerSession: 10,
    },
    now: () =>
      new Date(nowValues[nowIndex++] ?? nowValues[nowValues.length - 1]!),
  });

  store.upsert({
    provider: "codex",
    sessionId: "session-1",
    cursor: { kind: "byte-offset", value: 1 },
    events: [makeEvent("m1", "2026-02-22T19:40:00.000Z")],
  });
  store.upsert({
    provider: "codex",
    sessionId: "session-2",
    cursor: { kind: "byte-offset", value: 2 },
    events: [makeEvent("m2", "2026-02-22T19:41:00.000Z")],
  });

  // Refresh session-1 so session-2 becomes the oldest untouched entry.
  store.upsert({
    provider: "codex",
    sessionId: "session-1",
    cursor: { kind: "byte-offset", value: 3 },
    events: [makeEvent("m3", "2026-02-22T19:42:00.000Z")],
  });
  store.upsert({
    provider: "claude",
    sessionId: "session-3",
    cursor: { kind: "opaque", value: "cursor-3" },
    events: [makeEvent("m4", "2026-02-22T19:43:00.000Z")],
  });

  assertEquals(store.get("session-2"), undefined);
  assertExists(store.get("session-1"));
  assertExists(store.get("session-3"));

  const listed = store.list();
  assertEquals(listed.map((snapshot) => snapshot.sessionId), [
    "session-3",
    "session-1",
  ]);
});

Deno.test("InMemorySessionSnapshotStore validates retention policy bounds", () => {
  assertThrows(
    () =>
      new InMemorySessionSnapshotStore({
        retention: {
          maxSessions: 0,
        },
      }),
    Error,
    "maxSessions",
  );

  assertThrows(
    () =>
      new InMemorySessionSnapshotStore({
        retention: {
          maxEventsPerSession: -1,
        },
      }),
    Error,
    "maxEventsPerSession",
  );
});
