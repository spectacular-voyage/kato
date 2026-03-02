import { assertEquals } from "@std/assert";
import type { ConversationEvent, DaemonSessionStatus } from "@kato/shared";
import {
  DEFAULT_STATUS_STALE_AFTER_MS,
  extractSnippet,
  filterSessionsForDisplay,
  isSessionStale,
  projectSessionStatus,
  sortSessionsByRecency,
} from "@kato/shared";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeUserEvent(content: string, id = "e1"): ConversationEvent {
  return {
    eventId: id,
    provider: "claude",
    sessionId: "s1",
    timestamp: "2026-02-24T10:00:00.000Z",
    kind: "message.user",
    role: "user",
    content,
    source: { providerEventType: "user" },
  } as unknown as ConversationEvent;
}

function makeAssistantEvent(content: string, id = "e2"): ConversationEvent {
  return {
    eventId: id,
    provider: "claude",
    sessionId: "s1",
    timestamp: "2026-02-24T10:00:00.000Z",
    kind: "message.assistant",
    role: "assistant",
    content,
    source: { providerEventType: "assistant" },
  } as unknown as ConversationEvent;
}

// ─── extractSnippet ───────────────────────────────────────────────────────────

Deno.test("extractSnippet returns undefined for empty event list", () => {
  assertEquals(extractSnippet([]), undefined);
});

Deno.test("extractSnippet returns undefined when no user message", () => {
  assertEquals(extractSnippet([makeAssistantEvent("hello")]), undefined);
});

Deno.test("extractSnippet returns first user message content", () => {
  const events = [
    makeUserEvent("first message", "e1"),
    makeAssistantEvent("response", "e2"),
    makeUserEvent("second message", "e3"),
  ];
  assertEquals(extractSnippet(events), "first message");
});

Deno.test("extractSnippet truncates long content with ellipsis", () => {
  const long = "a".repeat(70);
  const result = extractSnippet([makeUserEvent(long)]);
  assertEquals(result?.length, 60);
  assertEquals(result?.endsWith("…"), true);
});

Deno.test("extractSnippet skips blank user messages and uses next", () => {
  const events = [
    makeUserEvent("   ", "e1"),
    makeUserEvent("real first message", "e2"),
  ];
  assertEquals(extractSnippet(events), "real first message");
});

Deno.test("extractSnippet returns undefined when all user messages are blank", () => {
  assertEquals(extractSnippet([makeUserEvent("   ")]), undefined);
});

Deno.test("extractSnippet returns only the first line of a multi-line message", () => {
  assertEquals(
    extractSnippet([makeUserEvent("first line\nsecond line\nthird line")]),
    "first line",
  );
});

// ─── isSessionStale ───────────────────────────────────────────────────────────

Deno.test("isSessionStale returns false for recent timestamp", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(now.getTime() - 60_000).toISOString(); // 1 min ago
  assertEquals(isSessionStale(updatedAt, now), false);
});

Deno.test("isSessionStale returns true for old timestamp beyond default", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(
    now.getTime() - DEFAULT_STATUS_STALE_AFTER_MS - 1,
  ).toISOString();
  assertEquals(isSessionStale(updatedAt, now), true);
});

Deno.test("isSessionStale returns true for unparseable string", () => {
  assertEquals(isSessionStale("not-a-date", new Date()), true);
});

Deno.test("isSessionStale respects custom staleAfterMs", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(now.getTime() - 10_000).toISOString();
  assertEquals(isSessionStale(updatedAt, now, 5_000), true);
  assertEquals(isSessionStale(updatedAt, now, 60_000), false);
});

// ─── projectSessionStatus ────────────────────────────────────────────────────

Deno.test("projectSessionStatus marks active session as not stale", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(now.getTime() - 60_000).toISOString();
  const result = projectSessionStatus({
    session: {
      provider: "claude",
      sessionId: "abc",
      updatedAt,
      lastEventAt: updatedAt, // required for active classification
      events: [makeUserEvent("hello")],
    },
    now,
  });
  assertEquals(result.stale, false);
  assertEquals(result.snippet, "hello");
  assertEquals(result.provider, "claude");
  assertEquals(result.sessionId, "abc");
  assertEquals(result.recordings, undefined);
});

Deno.test("projectSessionStatus attaches recordings when provided", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(now.getTime() - 60_000).toISOString();
  const result = projectSessionStatus({
    session: {
      provider: "codex",
      sessionId: "xyz",
      updatedAt,
      events: [],
    },
    recordings: [{
      provider: "codex",
      sessionId: "xyz",
      outputPath: "/out/notes.md",
      startedAt: updatedAt,
      lastWriteAt: updatedAt,
    }, {
      provider: "codex",
      sessionId: "xyz",
      outputPath: "/out/other.md",
      startedAt: updatedAt,
      lastWriteAt: updatedAt,
    }],
    now,
  });
  assertEquals(
    result.recordings?.map((recording) => recording.outputPath),
    ["/out/notes.md", "/out/other.md"],
  );
});

Deno.test("projectSessionStatus marks session stale when lastEventAt absent", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(now.getTime() - 60_000).toISOString(); // recent updatedAt
  const result = projectSessionStatus({
    session: {
      provider: "claude",
      sessionId: "no-event-at",
      updatedAt,
      // lastEventAt intentionally absent
      events: [],
    },
    now,
  });
  assertEquals(result.stale, true);
});

Deno.test("projectSessionStatus does not fall back lastEventAt to fileModifiedAtMs", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(now.getTime() - 60_000).toISOString();
  const fileModifiedAtMs = Date.parse("2026-02-24T08:30:00.000Z");
  const result = projectSessionStatus({
    session: {
      provider: "claude",
      sessionId: "mtime-fallback",
      updatedAt,
      fileModifiedAtMs,
      events: [],
    },
    now,
  });
  assertEquals(result.lastEventAt, undefined);
  assertEquals(result.stale, true);
});

Deno.test("projectSessionStatus marks old session as stale", () => {
  const now = new Date("2026-02-24T10:00:00.000Z");
  const updatedAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  const result = projectSessionStatus({
    session: {
      provider: "claude",
      sessionId: "old",
      updatedAt,
      events: [],
    },
    now,
  });
  assertEquals(result.stale, true);
});

// ─── filterSessionsForDisplay ─────────────────────────────────────────────────

Deno.test("filterSessionsForDisplay excludes stale when includeStale=false", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "claude",
      sessionId: "a",
      stale: false,
      updatedAt: "2026-02-24T10:00:00.000Z",
    },
    {
      provider: "claude",
      sessionId: "b",
      stale: true,
      updatedAt: "2026-02-24T09:00:00.000Z",
    },
  ];
  const result = filterSessionsForDisplay(sessions, {
    includeStale: false,
  });
  assertEquals(result.length, 1);
  assertEquals(result[0].sessionId, "a");
});

Deno.test("filterSessionsForDisplay includes stale when includeStale=true", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "claude",
      sessionId: "a",
      stale: false,
      updatedAt: "2026-02-24T10:00:00.000Z",
    },
    {
      provider: "claude",
      sessionId: "b",
      stale: true,
      updatedAt: "2026-02-24T09:00:00.000Z",
    },
  ];
  const result = filterSessionsForDisplay(sessions, {
    includeStale: true,
  });
  assertEquals(result.length, 2);
});

Deno.test("filterSessionsForDisplay sorts by recency descending", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "claude",
      sessionId: "older",
      stale: false,
      updatedAt: "2026-02-24T09:00:00.000Z",
      lastEventAt: "2026-02-24T11:00:00.000Z",
    },
    {
      provider: "claude",
      sessionId: "newer",
      stale: false,
      updatedAt: "2026-02-24T10:00:00.000Z",
      lastEventAt: "2026-02-24T08:00:00.000Z",
    },
  ];
  const result = filterSessionsForDisplay(sessions, {
    includeStale: true,
  });
  assertEquals(result[0].sessionId, "newer");
  assertEquals(result[1].sessionId, "older");
});

// ─── sortSessionsByRecency ────────────────────────────────────────────────────

Deno.test("sortSessionsByRecency for active recordings uses updatedAt over lastWriteAt", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "claude",
      sessionId: "older-message",
      stale: false,
      updatedAt: "2026-02-24T10:00:00.000Z",
      lastEventAt: "2026-02-24T12:30:00.000Z",
      recordings: [{
        outputPath: "/out-older.md",
        startedAt: "2026-02-24T09:00:00.000Z",
        // Intentionally newer than newer-message session. Should be ignored.
        lastWriteAt: "2026-02-24T12:00:00.000Z",
      }],
    },
    {
      provider: "claude",
      sessionId: "newer-message",
      stale: false,
      updatedAt: "2026-02-24T11:00:00.000Z",
      lastEventAt: "2026-02-24T09:00:00.000Z",
      recordings: [{
        outputPath: "/out-newer.md",
        startedAt: "2026-02-24T10:00:00.000Z",
        lastWriteAt: "2026-02-24T11:00:00.000Z",
      }],
    },
  ];
  const result = sortSessionsByRecency(sessions);
  assertEquals(result[0].sessionId, "newer-message");
});

Deno.test(
  "sortSessionsByRecency for stale sessions uses updatedAt over recording lastWriteAt",
  () => {
    const sessions: DaemonSessionStatus[] = [
      {
        provider: "claude",
        sessionId: "stale-older-message",
        stale: true,
        updatedAt: "2026-02-24T09:00:00.000Z",
        lastEventAt: "2026-02-24T12:30:00.000Z",
        recordings: [{
          outputPath: "/out-old.md",
          startedAt: "2026-02-24T09:00:00.000Z",
          // Intentionally newer than the other stale session. Should be ignored.
          lastWriteAt: "2026-02-24T12:00:00.000Z",
        }],
      },
      {
        provider: "claude",
        sessionId: "stale-newer-message",
        stale: true,
        updatedAt: "2026-02-24T10:00:00.000Z",
        lastEventAt: "2026-02-24T08:30:00.000Z",
        recordings: [{
          outputPath: "/out-new.md",
          startedAt: "2026-02-24T10:00:00.000Z",
          lastWriteAt: "2026-02-24T11:00:00.000Z",
        }],
      },
    ];

    const result = sortSessionsByRecency(sessions);
    assertEquals(result[0].sessionId, "stale-newer-message");
    assertEquals(result[1].sessionId, "stale-older-message");
  },
);

Deno.test(
  "sortSessionsByRecency uses updatedAt even when lastEventAt is absent",
  () => {
    const sessions: DaemonSessionStatus[] = [
      {
        provider: "claude",
        sessionId: "missing-last-event",
        stale: false,
        updatedAt: "2026-02-24T09:00:00.000Z",
      },
      {
        provider: "claude",
        sessionId: "newer-updated",
        stale: false,
        updatedAt: "2026-02-24T10:00:00.000Z",
        lastEventAt: "2026-02-24T08:00:00.000Z",
      },
    ];

    const result = sortSessionsByRecency(sessions);
    assertEquals(result[0].sessionId, "newer-updated");
    assertEquals(result[1].sessionId, "missing-last-event");
  },
);

Deno.test(
  "sortSessionsByRecency groups sessions with recordings before sessions without recordings",
  () => {
    const sessions: DaemonSessionStatus[] = [
      {
        provider: "claude",
        sessionId: "no-recording-newer",
        stale: false,
        updatedAt: "2026-02-24T12:00:00.000Z",
      },
      {
        provider: "claude",
        sessionId: "recording-older",
        stale: false,
        updatedAt: "2026-02-24T11:00:00.000Z",
        recordings: [{
          outputPath: "/out.md",
          startedAt: "2026-02-24T10:00:00.000Z",
          lastWriteAt: "2026-02-24T11:00:00.000Z",
        }],
      },
    ];

    const result = sortSessionsByRecency(sessions);
    assertEquals(result[0].sessionId, "recording-older");
    assertEquals(result[1].sessionId, "no-recording-newer");
  },
);

Deno.test(
  "sortSessionsByRecency only prioritizes active recordings (stale recordings are not in top bucket)",
  () => {
    const sessions: DaemonSessionStatus[] = [
      {
        provider: "claude",
        sessionId: "active-recording",
        stale: false,
        updatedAt: "2026-02-24T09:00:00.000Z",
        lastEventAt: "2026-02-24T09:00:00.000Z",
        recordings: [{
          outputPath: "/active.md",
          startedAt: "2026-02-24T08:00:00.000Z",
          lastWriteAt: "2026-02-24T09:00:00.000Z",
        }],
      },
      {
        provider: "claude",
        sessionId: "stale-recording",
        stale: true,
        updatedAt: "2026-02-24T11:00:00.000Z",
        lastEventAt: "2026-02-24T11:00:00.000Z",
        recordings: [{
          outputPath: "/stale.md",
          startedAt: "2026-02-24T08:30:00.000Z",
          lastWriteAt: "2026-02-24T11:30:00.000Z",
        }],
      },
    ];

    const result = sortSessionsByRecency(sessions);
    assertEquals(result[0].sessionId, "active-recording");
    assertEquals(result[1].sessionId, "stale-recording");
  },
);
