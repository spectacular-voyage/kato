import { assertEquals, assertExists } from "@std/assert";
import {
  buildGeminiMessageAnchor,
  makeByteOffsetCursor,
  makeItemIndexCursor,
  resolveByteOffsetResume,
  resolveCodexCompactionResume,
  resolveGeminiAnchorResume,
  resolveInitialIngestionCursor,
  resolveNextIngestAnchor,
} from "../apps/daemon/src/orchestrator/provider_ingestion_resume.ts";

function makeGeminiMessage(
  id: string,
  type: "user" | "gemini",
  content: string,
) {
  return {
    id,
    type,
    content,
    displayContent: content,
  };
}

Deno.test("resolveInitialIngestionCursor resets persisted cursor when source file path changes", () => {
  const result = resolveInitialIngestionCursor({
    persistedCursor: makeByteOffsetCursor(10),
    persistedSourceFilePath: "/tmp/session-a.jsonl",
    memoryCursor: makeByteOffsetCursor(20),
    memoryCursorSourcePath: "/tmp/session-a.jsonl",
    sessionFilePath: "/tmp/session-b.jsonl",
  });

  assertEquals(result, {
    existingCursor: undefined,
    fromOffset: 0,
    resumeSource: "persisted",
    clearStoredCursor: true,
  });
});

Deno.test("resolveInitialIngestionCursor resets memory cursor when tracked source path changes", () => {
  const result = resolveInitialIngestionCursor({
    persistedCursor: undefined,
    persistedSourceFilePath: undefined,
    memoryCursor: makeByteOffsetCursor(20),
    memoryCursorSourcePath: "/tmp/session-a.jsonl",
    sessionFilePath: "/tmp/session-b.jsonl",
  });

  assertEquals(result, {
    existingCursor: undefined,
    fromOffset: 0,
    resumeSource: "default",
    clearStoredCursor: true,
  });
});

Deno.test("resolveByteOffsetResume resets truncated byte-offset cursors", () => {
  const result = resolveByteOffsetResume({
    existingCursor: makeByteOffsetCursor(50),
    fromOffset: 50,
    fileSize: 12,
  });

  assertEquals(result, {
    existingCursor: makeByteOffsetCursor(0),
    fromOffset: 0,
    truncated: true,
  });
});

Deno.test("resolveCodexCompactionResume backtracks near a newer compaction marker", () => {
  const result = resolveCodexCompactionResume({
    existingCursor: makeByteOffsetCursor(15_000),
    fromOffset: 15_000,
    persistedAnchor: {
      messageId: "old-compaction",
      payloadHash: "old-hash",
    },
    latestCompactionAnchor: {
      lineEnd: 12_345,
      anchor: {
        messageId: "codex-compacted:12345",
        payloadHash: "new-hash",
      },
    },
    backtrackBytes: 4 * 1024,
  });

  assertEquals(result.backtracked, true);
  assertEquals(result.previousOffset, 15_000);
  assertEquals(result.backtrackedOffset, 8_249);
  assertEquals(result.fromOffset, 8_249);
  assertEquals(result.existingCursor, makeByteOffsetCursor(8_249));
  assertEquals(result.compactionAnchor, {
    messageId: "codex-compacted:12345",
    payloadHash: "new-hash",
  });
});

Deno.test("resolveGeminiAnchorResume realigns item-index cursor via persisted anchor", () => {
  const messages = [
    makeGeminiMessage("m-b", "gemini", "second"),
    makeGeminiMessage("m-x", "user", "third"),
    makeGeminiMessage("m-c", "gemini", "fourth"),
  ];
  const persistedAnchor = buildGeminiMessageAnchor(messages[0]!);

  const result = resolveGeminiAnchorResume({
    existingCursor: makeItemIndexCursor(2),
    fromOffset: 2,
    persistedAnchor,
    messages,
  });

  assertEquals(result, {
    existingCursor: makeItemIndexCursor(1),
    fromOffset: 1,
    replayedFromStart: false,
    realigned: true,
    previousOffset: 2,
    realignedOffset: 1,
  });
});

Deno.test("resolveGeminiAnchorResume replays from start when the persisted anchor is missing", () => {
  const result = resolveGeminiAnchorResume({
    existingCursor: makeItemIndexCursor(2),
    fromOffset: 2,
    persistedAnchor: {
      messageId: "missing-anchor",
      payloadHash: "missing-hash",
    },
    messages: [
      makeGeminiMessage("m-x", "user", "replacement-1"),
      makeGeminiMessage("m-y", "gemini", "replacement-2"),
    ],
  });

  assertEquals(result, {
    existingCursor: makeItemIndexCursor(0),
    fromOffset: 0,
    replayedFromStart: true,
    realigned: false,
    previousOffset: 2,
  });
});

Deno.test("resolveNextIngestAnchor derives the next Gemini anchor from the latest cursor", () => {
  const messages = [
    makeGeminiMessage("m-a", "user", "first"),
    makeGeminiMessage("m-b", "gemini", "second"),
  ];

  const result = resolveNextIngestAnchor({
    provider: "gemini",
    previousAnchor: undefined,
    latestCursor: makeItemIndexCursor(2),
    geminiMessages: messages,
    codexCompactionAnchor: undefined,
  });

  assertEquals(result.anchorChanged, true);
  assertExists(result.nextAnchor);
  assertEquals(result.nextAnchor?.messageId, "m-b");
});
