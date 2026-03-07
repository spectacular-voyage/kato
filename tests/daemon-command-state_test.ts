import { assert, assertEquals } from "@std/assert";
import type { ConversationEvent, SessionMetadataV1 } from "@kato/shared";
import {
  buildBoundarySnapshotEvents,
  buildCommandSeedEvents,
  commandCursorAnchorEquals,
  readCommandCursor,
  readCommandCursorAnchor,
  resolveCommandBoundaries,
  resolveCommandStartCursor,
  writeCommandCursor,
} from "../apps/daemon/src/orchestrator/runtime_command_state.ts";

function makeUserEvent(
  id: string,
  content: string,
  timestamp?: string,
): ConversationEvent & { kind: "message.user" } {
  return {
    eventId: id,
    provider: "codex",
    sessionId: "session-1",
    ...(timestamp ? { timestamp } : {}),
    kind: "message.user",
    role: "user",
    content,
    source: {
      providerEventType: "user",
      providerEventId: id,
    },
  };
}

function makeAssistantEvent(
  id: string,
  content: string,
  timestamp?: string,
): ConversationEvent {
  return {
    eventId: id,
    provider: "codex",
    sessionId: "session-1",
    ...(timestamp ? { timestamp } : {}),
    kind: "message.assistant",
    role: "assistant",
    content,
    source: {
      providerEventType: "assistant",
      providerEventId: id,
    },
  } as ConversationEvent;
}

function makeMetadata(
  overrides: Partial<SessionMetadataV1> = {},
): SessionMetadataV1 {
  return {
    schemaVersion: 1,
    provider: "codex",
    providerSessionId: "session-1",
    sourceFilePath: "/tmp/session.jsonl",
    firstSeenAt: "2026-02-22T19:00:00.000Z",
    lastUpdatedAt: "2026-02-22T19:00:00.000Z",
    ...overrides,
  } as SessionMetadataV1;
}

Deno.test("resolveCommandBoundaries maps command lines to non-overlapping segments", () => {
  const content = [
    "intro",
    "::record-k",
    "record body",
    "::capture-k /tmp/out.md",
    "capture body",
  ].join("\n");

  const boundaries = resolveCommandBoundaries(content, [
    {
      verb: "record",
      name: "record",
      alias: "k",
      line: 2,
      raw: "::record-k",
    },
    {
      verb: "capture",
      name: "capture",
      alias: "k",
      argument: "/tmp/out.md",
      line: 4,
      raw: "::capture-k /tmp/out.md",
    },
  ]);

  assertEquals(boundaries, [
    {
      command: {
        verb: "record",
        name: "record",
        alias: "k",
        line: 2,
        raw: "::record-k",
      },
      nextCommandLine: 4,
      lastLineInSegment: 3,
    },
    {
      command: {
        verb: "capture",
        name: "capture",
        alias: "k",
        argument: "/tmp/out.md",
        line: 4,
        raw: "::capture-k /tmp/out.md",
      },
      nextCommandLine: 6,
      lastLineInSegment: 5,
    },
  ]);
});

Deno.test("buildBoundarySnapshotEvents truncates the boundary event to the command line", () => {
  const boundaryEvent = makeUserEvent(
    "u-boundary",
    "line before\n::record-k\nline after",
  );
  const snapshot = buildBoundarySnapshotEvents(
    [
      makeAssistantEvent("a-before", "assistant context"),
      boundaryEvent,
    ],
    1,
    boundaryEvent,
    2,
  );

  assertEquals(snapshot.length, 2);
  assertEquals(snapshot[1], {
    ...boundaryEvent,
    content: "line before\n::record-k",
  });
});

Deno.test("buildCommandSeedEvents excludes lines before the command boundary", () => {
  const event = makeUserEvent(
    "u-seed",
    "line before\n::record-k\nline after",
  );

  const seedEvents = buildCommandSeedEvents(event, 2, 3);

  assertEquals(seedEvents, [{
    ...event,
    content: "::record-k\nline after",
  }]);
  const firstSeedEvent = seedEvents[0];
  assert(firstSeedEvent?.kind === "message.user");
  assert(!firstSeedEvent.content.includes("line before"));
});

Deno.test("resolveCommandStartCursor resumes from the anchor event when the stored cursor is stale", () => {
  const events = [
    makeUserEvent(
      "u-capture-before-anchor",
      "::capture-k /tmp/old.md",
      "2026-02-22T19:00:00.000Z",
    ),
    makeAssistantEvent(
      "a-after-anchor",
      "already processed",
      "2026-02-22T19:00:01.000Z",
    ),
    makeUserEvent(
      "u-capture-after-anchor",
      "::capture-k /tmp/new.md",
      "2026-02-22T19:00:02.000Z",
    ),
  ];

  const commandCursor = resolveCommandStartCursor(
    makeMetadata({
      commandCursor: 99,
      commandCursorAnchor: {
        eventId: "u-capture-before-anchor",
        providerEventType: "user",
        providerEventId: "u-capture-before-anchor",
        timestamp: "2026-02-22T19:00:00.000Z",
      },
    }),
    events,
  );

  assertEquals(commandCursor, 1);
});

Deno.test("resolveCommandStartCursor falls back to the anchor timestamp when the anchored event is missing", () => {
  const events = [
    makeUserEvent(
      "u-older",
      "::capture-k /tmp/old.md",
      "2026-02-22T19:00:00.000Z",
    ),
    makeAssistantEvent(
      "a-middle",
      "already processed",
      "2026-02-22T19:00:01.000Z",
    ),
    makeUserEvent(
      "u-newer",
      "::capture-k /tmp/new.md",
      "2026-02-22T19:00:02.000Z",
    ),
  ];

  const commandCursor = resolveCommandStartCursor(
    makeMetadata({
      commandCursor: 99,
      commandCursorAnchor: {
        eventId: "missing-anchor",
        providerEventType: "user",
        providerEventId: "missing-anchor",
        timestamp: "2026-02-22T19:00:01.000Z",
      },
    }),
    events,
  );

  assertEquals(commandCursor, 2);
});

Deno.test("writeCommandCursor normalizes the cursor and updates the anchor", () => {
  const metadata = makeMetadata({
    commandCursor: -1,
    commandCursorAnchor: {
      eventId: "stale",
    },
  });
  const events = [
    makeUserEvent("u-1", "first", "2026-02-22T19:00:00.000Z"),
    makeUserEvent("u-2", "second", "2026-02-22T19:00:01.000Z"),
  ];

  writeCommandCursor(metadata, 2.8, events);

  assertEquals(readCommandCursor(metadata), 2);
  assertEquals(readCommandCursorAnchor(metadata), {
    eventId: "u-2",
    providerEventType: "user",
    providerEventId: "u-2",
    timestamp: "2026-02-22T19:00:01.000Z",
  });
  assert(
    commandCursorAnchorEquals(metadata.commandCursorAnchor, {
      eventId: "u-2",
      providerEventType: "user",
      providerEventId: "u-2",
      timestamp: "2026-02-22T19:00:01.000Z",
    }),
  );
});

Deno.test("writeCommandCursor clamps invalid and oversized cursor values safely", () => {
  const metadata = makeMetadata({
    commandCursor: 1,
    commandCursorAnchor: {
      eventId: "stale",
    },
  });
  const events = [
    makeUserEvent("u-1", "first", "2026-02-22T19:00:00.000Z"),
    makeUserEvent("u-2", "second", "2026-02-22T19:00:01.000Z"),
  ];

  writeCommandCursor(metadata, Number.POSITIVE_INFINITY, events);
  assertEquals(readCommandCursor(metadata), 0);
  assertEquals(readCommandCursorAnchor(metadata), undefined);

  writeCommandCursor(metadata, 99, events);
  assertEquals(readCommandCursor(metadata), 2);
  assertEquals(readCommandCursorAnchor(metadata)?.eventId, "u-2");
});
