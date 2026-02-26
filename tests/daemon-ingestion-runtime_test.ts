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

function makeUserEvent(
  id: string,
  timestamp: string,
  content: string,
): ConversationEvent {
  return {
    eventId: id,
    provider: "test",
    sessionId: "session-a",
    timestamp,
    kind: "message.user",
    role: "user",
    content,
    source: { providerEventType: "user", providerEventId: id },
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

Deno.test("InMemorySessionSnapshotStore keeps first user snippet when early events are truncated", () => {
  const store = new InMemorySessionSnapshotStore({
    retention: {
      maxSessions: 10,
      maxEventsPerSession: 2,
    },
    now: () => new Date("2026-02-22T19:30:00.000Z"),
  });

  const first = store.upsert({
    provider: "claude",
    sessionId: "session-window-snippet",
    cursor: { kind: "item-index", value: 3 },
    events: [
      makeUserEvent("u1", "2026-02-22T19:27:00.000Z", "first user message"),
      makeEvent("a1", "2026-02-22T19:28:00.000Z"),
      makeEvent("a2", "2026-02-22T19:29:00.000Z"),
    ],
  });
  assertEquals(first.metadata.snippet, "first user message");
  assertEquals(first.events.map((event) => event.eventId), ["a1", "a2"]);

  const second = store.upsert({
    provider: "claude",
    sessionId: "session-window-snippet",
    cursor: { kind: "item-index", value: 4 },
    events: [
      makeEvent("a2", "2026-02-22T19:29:00.000Z"),
      makeEvent("a3", "2026-02-22T19:30:00.000Z"),
    ],
  });

  assertEquals(second.metadata.snippet, "first user message");
});

Deno.test("InMemorySessionSnapshotStore snippetOverride can repair resumed snippet", () => {
  const store = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T19:30:00.000Z"),
  });

  const first = store.upsert({
    provider: "codex",
    sessionId: "session-snippet-override",
    cursor: { kind: "byte-offset", value: 100 },
    events: [
      makeUserEvent("u-late", "2026-02-22T19:29:00.000Z", "late user message"),
    ],
  });
  assertEquals(first.metadata.snippet, "late user message");

  const second = store.upsert({
    provider: "codex",
    sessionId: "session-snippet-override",
    cursor: { kind: "byte-offset", value: 110 },
    events: [
      makeEvent("a-next", "2026-02-22T19:30:00.000Z"),
    ],
    snippetOverride: "original first user message",
  });

  assertEquals(second.metadata.snippet, "original first user message");
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

Deno.test("InMemorySessionSnapshotStore evicts due to memory pressure", () => {
  // Budget is in MB, so we need to work with integer values.
  // 1 MB = 1024 * 1024 bytes. Each session with large events will consume ~30KB,
  // so 1 MB budget allows ~33 sessions before eviction kicks in.
  const store = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 1, // 1 MB budget (exact value doesn't matter, just needs to trigger eviction)
    retention: {
      maxSessions: 100, // plenty of room by count
      maxEventsPerSession: 100,
    },
    now: () => new Date("2026-02-25T12:00:00.000Z"),
  });

  // Create events with large content to exceed memory budget.
  // Each event with ~100 KB of content helps accumulate to exceed 1 MB budget.
  const largeContent = "x".repeat(100000);

  const event1 = {
    eventId: "e1",
    provider: "test",
    sessionId: "session-1",
    timestamp: "2026-02-25T12:00:00.000Z",
    kind: "message.assistant" as const,
    role: "assistant" as const,
    content: largeContent,
    source: { providerEventType: "assistant", providerEventId: "e1" },
  } as unknown as ConversationEvent;

  const event2 = {
    eventId: "e2",
    provider: "test",
    sessionId: "session-1",
    timestamp: "2026-02-25T12:00:01.000Z",
    kind: "message.user" as const,
    role: "user" as const,
    content: largeContent,
    source: { providerEventType: "user", providerEventId: "e2" },
  } as unknown as ConversationEvent;

  // Add first session (fits within budget)
  store.upsert({
    provider: "test",
    sessionId: "session-1",
    cursor: { kind: "byte-offset", value: 100 },
    events: [event1, event2],
  });

  let stats = store.getMemoryStats();
  assertEquals(stats.evictionsTotal, 0, "No evictions yet");
  assertEquals(stats.sessionCount, 1);

  // Add second session (still fits)
  store.upsert({
    provider: "test",
    sessionId: "session-2",
    cursor: { kind: "byte-offset", value: 200 },
    events: [event1, event2],
  });

  stats = store.getMemoryStats();
  assertEquals(stats.sessionCount, 2);

  // Add sessions until we exceed budget
  // Each session is ~200 KB, so 6 sessions * 200 KB = ~1.2 MB, exceeding 1 MB budget
  for (let i = 3; i <= 6; i++) {
    store.upsert({
      provider: "test",
      sessionId: `session-${i}`,
      cursor: { kind: "byte-offset", value: i * 100 },
      events: [event1, event2],
    });
  }

  stats = store.getMemoryStats();

  // At least one session should be evicted to stay under budget
  assertEquals(stats.evictionsTotal > 0, true);
  assertEquals((stats.evictionsByReason["memory_pressure"] ?? 0) > 0, true);

  // Verify at least the oldest session was evicted
  assertEquals(store.get("session-1"), undefined, "session-1 was evicted");

  // At least one newer session should still exist
  const remainingSessions = [2, 3, 4, 5, 6].filter((i) =>
    store.get(`session-${i}`) !== undefined
  );
  assertEquals(
    remainingSessions.length > 0,
    true,
    "At least one recent session still exists",
  );
});
