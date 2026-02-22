import { assertEquals, assertRejects } from "@std/assert";
import type { Message } from "@kato/shared";
import {
  type ConversationWriterLike,
  type MarkdownWriteResult,
  RecordingPipeline,
  type WritePathPolicyGateLike,
} from "../apps/daemon/src/mod.ts";

function makeMessage(content: string): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    timestamp: "2026-02-22T10:00:00.000Z",
    model: "claude-opus-4-6",
  };
}

function makeSequencedPathPolicyGate(
  sequence: Array<"allow" | "deny">,
  callOrder: string[],
): WritePathPolicyGateLike {
  let index = 0;
  return {
    evaluateWritePath(targetPath: string) {
      callOrder.push("policy");
      const decision = sequence[index] ?? sequence[sequence.length - 1] ??
        "deny";
      index += 1;
      if (decision === "allow") {
        return Promise.resolve({
          decision,
          targetPath,
          reason: "allowed-for-test",
          canonicalTargetPath: `/safe/${targetPath}`,
          matchedRoot: "/safe",
        });
      }
      return Promise.resolve({
        decision,
        targetPath,
        reason: "denied-for-test",
      });
    },
  };
}

function makeWriterSpy(callOrder: string[]): {
  calls: Array<
    { mode: "append" | "overwrite"; path: string; messages: number }
  >;
  writer: ConversationWriterLike;
} {
  const calls: Array<
    { mode: "append" | "overwrite"; path: string; messages: number }
  > = [];

  function makeResult(mode: MarkdownWriteResult["mode"], path: string) {
    return {
      mode,
      outputPath: path,
      wrote: true,
      deduped: false,
    } as MarkdownWriteResult;
  }

  return {
    calls,
    writer: {
      appendMessages(path, messages) {
        callOrder.push("writer.append");
        calls.push({ mode: "append", path, messages: messages.length });
        return Promise.resolve(makeResult("append", path));
      },
      overwriteMessages(path, messages) {
        callOrder.push("writer.overwrite");
        calls.push({ mode: "overwrite", path, messages: messages.length });
        return Promise.resolve(makeResult("overwrite", path));
      },
    },
  };
}

Deno.test("RecordingPipeline evaluates policy before record writer start", async () => {
  const order: string[] = [];
  const writerSpy = makeWriterSpy(order);
  const pipeline = new RecordingPipeline({
    pathPolicyGate: makeSequencedPathPolicyGate(["allow"], order),
    writer: writerSpy.writer,
    makeRecordingId: () => "rec-1",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  const recording = await pipeline.startOrRotateRecording({
    provider: "codex",
    sessionId: "session-1",
    targetPath: "notes/record.md",
    seedMessages: [makeMessage("seed")],
  });

  assertEquals(recording.recordingId, "rec-1");
  assertEquals(recording.outputPath, "/safe/notes/record.md");
  assertEquals(order, ["policy", "writer.append"]);
});

Deno.test(
  "RecordingPipeline denied record rotation keeps existing active recording",
  async () => {
    const order: string[] = [];
    const writerSpy = makeWriterSpy(order);
    let nextId = 0;
    const pipeline = new RecordingPipeline({
      pathPolicyGate: makeSequencedPathPolicyGate(["allow", "deny"], order),
      writer: writerSpy.writer,
      makeRecordingId: () => `rec-${++nextId}`,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    await pipeline.startOrRotateRecording({
      provider: "claude",
      sessionId: "session-42",
      targetPath: "notes/first.md",
    });

    await assertRejects(
      () =>
        pipeline.startOrRotateRecording({
          provider: "claude",
          sessionId: "session-42",
          targetPath: "notes/second.md",
          seedMessages: [makeMessage("should-not-write")],
        }),
      Error,
      "Path denied by policy",
    );

    const active = pipeline.getActiveRecording("claude", "session-42");
    assertEquals(active?.recordingId, "rec-1");
    assertEquals(active?.outputPath, "/safe/notes/first.md");
    assertEquals(order, ["policy", "policy"]);
    assertEquals(writerSpy.calls.length, 0);
  },
);

Deno.test("RecordingPipeline capture keeps existing recording target unchanged", async () => {
  const order: string[] = [];
  const writerSpy = makeWriterSpy(order);
  const pipeline = new RecordingPipeline({
    pathPolicyGate: makeSequencedPathPolicyGate(["allow", "allow"], order),
    writer: writerSpy.writer,
    makeRecordingId: () => "rec-1",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  await pipeline.startOrRotateRecording({
    provider: "codex",
    sessionId: "session-9",
    targetPath: "notes/live-record.md",
  });

  await pipeline.captureSnapshot({
    provider: "codex",
    sessionId: "session-9",
    targetPath: "notes/capture.md",
    messages: [makeMessage("capture-all")],
  });

  const active = pipeline.getActiveRecording("codex", "session-9");
  assertEquals(active?.outputPath, "/safe/notes/live-record.md");
  assertEquals(writerSpy.calls.length, 1);
  assertEquals(writerSpy.calls[0], {
    mode: "overwrite",
    path: "/safe/notes/capture.md",
    messages: 1,
  });
});
