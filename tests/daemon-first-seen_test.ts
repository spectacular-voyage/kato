import { assertEquals } from "@std/assert";
import type { ConversationEvent } from "@kato/shared";
import {
  resolveFirstSeenProviderSessionCommandCursor,
  resolveFirstSeenSourceFileFreshness,
} from "../apps/daemon/src/orchestrator/runtime_first_seen.ts";

const FIRST_SEEN_SOURCE_PATH = ".test-tmp/first-seen/provider-session.jsonl";
const FIRST_SEEN_MISSING_SOURCE_PATH =
  ".test-tmp/first-seen/missing-session.jsonl";
const FIRST_SEEN_OLD_COMMAND_PATH = ".test-tmp/first-seen/old-command.md";
const FIRST_SEEN_STALE_COMMAND_PATH = ".test-tmp/first-seen/stale.md";
const FIRST_SEEN_FRESH_COMMAND_PATH = ".test-tmp/first-seen/fresh.md";
const FIRST_SEEN_NO_TIMESTAMP_FRESH_PATH =
  ".test-tmp/first-seen/no-timestamp-fresh.md";
const FIRST_SEEN_NO_TIMESTAMP_STALE_PATH =
  ".test-tmp/first-seen/no-timestamp-stale.md";

function makeUserEvent(
  id: string,
  content: string,
  timestamp?: string,
): ConversationEvent {
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
  } as ConversationEvent;
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

Deno.test("resolveFirstSeenSourceFileFreshness prefers birthtime over mtime", async () => {
  const freshness = await resolveFirstSeenSourceFileFreshness({
    sourceFilePath: FIRST_SEEN_SOURCE_PATH,
    metadataLastObservedMtimeMs: new Date("2026-02-22T09:59:49.000Z").getTime(),
    statPath() {
      return Promise.resolve({
        birthtime: new Date("2026-02-22T09:59:56.000Z"),
        mtime: new Date("2026-02-22T09:59:58.000Z"),
      });
    },
  });

  assertEquals(freshness, {
    sourceFileFreshnessMs: new Date("2026-02-22T09:59:56.000Z").getTime(),
    sourceFileFreshnessBasis: "source.birthtime",
  });
});

Deno.test("resolveFirstSeenSourceFileFreshness falls back to metadata when stat is unavailable", async () => {
  const freshness = await resolveFirstSeenSourceFileFreshness({
    sourceFilePath: FIRST_SEEN_MISSING_SOURCE_PATH,
    metadataLastObservedMtimeMs: new Date("2026-02-22T09:59:49.000Z").getTime(),
    statPath() {
      return Promise.reject(new Deno.errors.NotFound("missing"));
    },
  });

  assertEquals(freshness, {
    sourceFileFreshnessMs: new Date("2026-02-22T09:59:49.000Z").getTime(),
    sourceFileFreshnessBasis: "metadata.lastObservedMtimeMs",
  });
});

Deno.test("resolveFirstSeenProviderSessionCommandCursor skips stale timestamped commands even when source freshness is recent", () => {
  const result = resolveFirstSeenProviderSessionCommandCursor({
    events: [
      makeUserEvent(
        "u-old-capture",
        `::capture-My.Proj ${FIRST_SEEN_OLD_COMMAND_PATH}`,
        "2026-02-22T09:59:40.000Z",
      ),
    ],
    daemonStartMs: new Date("2026-02-22T10:00:00.000Z").getTime(),
    nearRealtimeGraceMs: 5_000,
    sourceFileFreshnessMs: new Date("2026-02-22T10:00:04.000Z").getTime(),
  });

  assertEquals(result, {
    commandCursor: 1,
    eligibleUserEvents: 0,
    skippedUserEvents: 1,
  });
});

Deno.test("resolveFirstSeenProviderSessionCommandCursor picks the first near-realtime user event from mixed backlog", () => {
  const result = resolveFirstSeenProviderSessionCommandCursor({
    events: [
      makeUserEvent(
        "u-capture-stale",
        `::capture-My.Proj ${FIRST_SEEN_STALE_COMMAND_PATH}`,
        "2026-02-22T09:59:40.000Z",
      ),
      makeUserEvent(
        "u-capture-fresh",
        `::capture-My.Proj ${FIRST_SEEN_FRESH_COMMAND_PATH}`,
        "2026-02-22T09:59:56.000Z",
      ),
      makeAssistantEvent(
        "a-followup",
        "assistant follow-up",
        "2026-02-22T10:00:01.000Z",
      ),
    ],
    daemonStartMs: new Date("2026-02-22T10:00:00.000Z").getTime(),
    nearRealtimeGraceMs: 5_000,
    sourceFileFreshnessMs: new Date("2026-02-22T10:00:04.000Z").getTime(),
  });

  assertEquals(result, {
    commandCursor: 1,
    eligibleUserEvents: 1,
    skippedUserEvents: 1,
  });
});

Deno.test("resolveFirstSeenProviderSessionCommandCursor uses source freshness for untimestamped user events", () => {
  const daemonStartMs = new Date("2026-02-22T10:00:00.000Z").getTime();

  assertEquals(
    resolveFirstSeenProviderSessionCommandCursor({
      events: [
        makeUserEvent(
          "u-capture-no-timestamp-fresh",
          `::capture-My.Proj ${FIRST_SEEN_NO_TIMESTAMP_FRESH_PATH}`,
        ),
      ],
      daemonStartMs,
      nearRealtimeGraceMs: 5_000,
      sourceFileFreshnessMs: new Date("2026-02-22T09:59:56.000Z").getTime(),
    }),
    {
      commandCursor: 0,
      eligibleUserEvents: 1,
      skippedUserEvents: 0,
    },
  );

  assertEquals(
    resolveFirstSeenProviderSessionCommandCursor({
      events: [
        makeUserEvent(
          "u-capture-no-timestamp-stale",
          `::capture-My.Proj ${FIRST_SEEN_NO_TIMESTAMP_STALE_PATH}`,
        ),
      ],
      daemonStartMs,
      nearRealtimeGraceMs: 5_000,
      sourceFileFreshnessMs: new Date("2026-02-22T09:59:49.000Z").getTime(),
    }),
    {
      commandCursor: 1,
      eligibleUserEvents: 0,
      skippedUserEvents: 1,
    },
  );
});
