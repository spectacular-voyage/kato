import { assertEquals, assertExists, assertThrows } from "@std/assert";
import {
  InMemorySessionSnapshotStore,
  SessionSnapshotMemoryBudgetExceededError,
} from "../apps/daemon/src/orchestrator/ingestion_runtime.ts";
import type { ConversationEvent } from "@kato/shared";

function makeEvent(
  id: string,
  contentLength: number,
): ConversationEvent {
  return {
    eventId: id,
    provider: "test",
    sessionId: "session-a",
    timestamp: new Date().toISOString(),
    kind: "message.assistant",
    role: "assistant",
    content: "a".repeat(contentLength),
    source: { providerEventType: "assistant", providerEventId: id },
  } as unknown as ConversationEvent;
}

Deno.test("InMemorySessionSnapshotStore enforces memory budget via LRU eviction", () => {
  // 1MB budget
  const store = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 1,
    retention: { maxSessions: 100, maxEventsPerSession: 100 },
  });

  // Create a session taking up ~400KB
  store.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e1", 400 * 1024)],
  });

  // Create another session taking up ~400KB
  store.upsert({
    provider: "p1",
    sessionId: "s2",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e2", 400 * 1024)],
  });

  let stats = store.getMemoryStats!();
  assertEquals(stats.sessionCount, 2);
  assertEquals(stats.evictionsTotal, 0);

  // Create third session ~400KB. Total > 1.2MB > 1MB. Should evict s1 (LRU).
  store.upsert({
    provider: "p1",
    sessionId: "s3",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e3", 400 * 1024)],
  });

  stats = store.getMemoryStats!();
  assertEquals(stats.sessionCount, 2);
  assertEquals(stats.evictionsTotal, 1);
  assertEquals(store.get("s1"), undefined);
  assertExists(store.get("s2"));
  assertExists(store.get("s3"));

  // Update s2. Now s3 is LRU.
  store.upsert({
    provider: "p1",
    sessionId: "s2",
    cursor: { kind: "byte-offset", value: 1 },
    events: [makeEvent("e2b", 400 * 1024)],
  });

  // Add s4. Should evict s3.
  store.upsert({
    provider: "p1",
    sessionId: "s4",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e4", 400 * 1024)],
  });

  stats = store.getMemoryStats!();
  assertEquals(stats.sessionCount, 2);
  assertEquals(store.get("s3"), undefined);
  assertExists(store.get("s2"));
  assertExists(store.get("s4"));
});

Deno.test("InMemorySessionSnapshotStore fails closed if single session exceeds budget", () => {
  // 1MB budget
  const store = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 1,
    retention: { maxSessions: 100, maxEventsPerSession: 100 },
  });

  const error = assertThrows(
    () =>
      store.upsert({
        provider: "p1",
        sessionId: "s1",
        cursor: { kind: "byte-offset", value: 0 },
        events: [makeEvent("e1", 1.5 * 1024 * 1024)], // 1.5MB > 1MB
      }),
    SessionSnapshotMemoryBudgetExceededError,
  );

  assertEquals(error.sessionId, "s1");
  assertEquals(error.daemonMaxMemoryBytes, 1024 * 1024);
  const stats = store.getMemoryStats!();
  assertEquals(stats.overBudget, true);
});

Deno.test("InMemorySessionSnapshotStore updates metrics correctly", () => {
  const store = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 10,
  });

  store.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e1", 100)],
  });

  let stats = store.getMemoryStats!();
  assertEquals(stats.sessionCount, 1);
  assertEquals(stats.eventCount, 1);
  assertEquals(stats.estimatedBytes > 100, true);

  // Update session (replace)
  store.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 1 },
    events: [makeEvent("e1", 100), makeEvent("e2", 100)],
  });

  stats = store.getMemoryStats!();
  assertEquals(stats.sessionCount, 1);
  assertEquals(stats.eventCount, 2);

  // Remove session (via eviction simulation or manual delete if exposed, but only eviction logic removes)
  // We can simulate maxSessions = 1
  const store2 = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 10,
    retention: { maxSessions: 1 },
  });

  store2.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 0 },
    events: [],
  });

  store2.upsert({
    provider: "p1",
    sessionId: "s2",
    cursor: { kind: "byte-offset", value: 0 },
    events: [],
  });

  stats = store2.getMemoryStats!();
  assertEquals(stats.sessionCount, 1);
  assertEquals(stats.evictionsTotal, 1);
  assertEquals(stats.evictionsByReason["max_sessions"], 1);
});
