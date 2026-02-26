import { assertEquals, assertRejects } from "@std/assert";
import type { ConversationEvent } from "@kato/shared";
import {
  type ConversationWriterLike,
  RecordingPipeline,
  type WritePathPolicyGateLike,
} from "../apps/daemon/src/mod.ts";

function makeEvent(content: string): ConversationEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: "test",
    sessionId: "sess-test",
    timestamp: "2026-02-22T10:00:00.000Z",
    kind: "message.assistant",
    role: "assistant",
    content,
    source: { providerEventType: "assistant" },
  } as unknown as ConversationEvent;
}

function makeToolCallEvent(): ConversationEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: "test",
    sessionId: "sess-test",
    timestamp: "2026-02-22T10:00:01.000Z",
    kind: "tool.call",
    toolCallId: "tool-1",
    name: "search",
    source: { providerEventType: "tool_call", providerEventId: "tool-1" },
  } as unknown as ConversationEvent;
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
    {
      mode: "append" | "overwrite";
      path: string;
      events: number;
      hasNow: boolean;
      includeCommentary?: boolean;
      includeThinking?: boolean;
      includeToolCalls?: boolean;
      italicizeUserMessages?: boolean;
    }
  >;
  renderOptionsByCall: Array<{ frontmatterConversationEventKinds?: string[] }>;
  writer: ConversationWriterLike;
  appendOutcomes: Array<{ wrote: boolean; deduped: boolean }>;
  overwriteOutcomes: Array<{ wrote: boolean; deduped: boolean }>;
} {
  const calls: Array<
    {
      mode: "append" | "overwrite";
      path: string;
      events: number;
      hasNow: boolean;
      includeCommentary?: boolean;
      includeThinking?: boolean;
      includeToolCalls?: boolean;
      italicizeUserMessages?: boolean;
    }
  > = [];
  const renderOptionsByCall: Array<
    { frontmatterConversationEventKinds?: string[] }
  > = [];
  const appendOutcomes: Array<{ wrote: boolean; deduped: boolean }> = [];
  const overwriteOutcomes: Array<{ wrote: boolean; deduped: boolean }> = [];

  return {
    calls,
    renderOptionsByCall,
    appendOutcomes,
    overwriteOutcomes,
    writer: {
      appendEvents(path, events, options) {
        callOrder.push("writer.append");
        renderOptionsByCall.push({
          frontmatterConversationEventKinds:
            options?.frontmatterConversationEventKinds
              ? [...options.frontmatterConversationEventKinds]
              : undefined,
        });
        calls.push({
          mode: "append",
          path,
          events: events.length,
          hasNow: typeof options?.now === "function",
          includeCommentary: options?.includeCommentary,
          includeThinking: options?.includeThinking,
          includeToolCalls: options?.includeToolCalls,
          italicizeUserMessages: options?.italicizeUserMessages,
        });
        const outcome = appendOutcomes.shift() ??
          { wrote: true, deduped: false };
        return Promise.resolve({
          mode: "append",
          outputPath: path,
          wrote: outcome.wrote,
          deduped: outcome.deduped,
        });
      },
      overwriteEvents(path, events, options) {
        callOrder.push("writer.overwrite");
        renderOptionsByCall.push({
          frontmatterConversationEventKinds:
            options?.frontmatterConversationEventKinds
              ? [...options.frontmatterConversationEventKinds]
              : undefined,
        });
        calls.push({
          mode: "overwrite",
          path,
          events: events.length,
          hasNow: typeof options?.now === "function",
          includeCommentary: options?.includeCommentary,
          includeThinking: options?.includeThinking,
          includeToolCalls: options?.includeToolCalls,
          italicizeUserMessages: options?.italicizeUserMessages,
        });
        const outcome = overwriteOutcomes.shift() ??
          { wrote: true, deduped: false };
        return Promise.resolve({
          mode: "overwrite",
          outputPath: path,
          wrote: outcome.wrote,
          deduped: outcome.deduped,
        });
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
    seedEvents: [makeEvent("seed")],
  });

  assertEquals(recording.recordingId, "rec-1");
  assertEquals(recording.outputPath, "/safe/notes/record.md");
  assertEquals(order, ["policy", "writer.append"]);
  assertEquals(writerSpy.calls[0]?.hasNow, true);
});

Deno.test("RecordingPipeline normalizes caller-provided recordingId", async () => {
  const order: string[] = [];
  const writerSpy = makeWriterSpy(order);
  const pipeline = new RecordingPipeline({
    pathPolicyGate: makeSequencedPathPolicyGate(["allow", "allow"], order),
    writer: writerSpy.writer,
    makeRecordingId: () => "generated-recording-id",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  const trimmed = await pipeline.startOrRotateRecording({
    provider: "codex",
    sessionId: "session-trim",
    targetPath: "notes/record.md",
    recordingId: "  rec-user-1  ",
  });
  assertEquals(trimmed.recordingId, "rec-user-1");

  const generated = await pipeline.startOrRotateRecording({
    provider: "codex",
    sessionId: "session-trim",
    targetPath: "notes/record-2.md",
    recordingId: "   ",
  });
  assertEquals(generated.recordingId, "generated-recording-id");
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
          seedEvents: [makeEvent("should-not-write")],
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
    events: [makeEvent("capture-all")],
  });

  const active = pipeline.getActiveRecording("codex", "session-9");
  assertEquals(active?.outputPath, "/safe/notes/live-record.md");
  assertEquals(writerSpy.calls.length, 1);
  assertEquals(writerSpy.calls[0], {
    mode: "overwrite",
    path: "/safe/notes/capture.md",
    events: 1,
    hasNow: true,
    includeCommentary: undefined,
    includeThinking: undefined,
    includeToolCalls: undefined,
    italicizeUserMessages: undefined,
  });
});

Deno.test("RecordingPipeline export passes deterministic clock to writer", async () => {
  const order: string[] = [];
  const writerSpy = makeWriterSpy(order);
  const pipeline = new RecordingPipeline({
    pathPolicyGate: makeSequencedPathPolicyGate(["allow"], order),
    writer: writerSpy.writer,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  await pipeline.exportSnapshot({
    provider: "codex",
    sessionId: "session-export",
    targetPath: "notes/export.md",
    events: [makeEvent("export-all")],
  });

  assertEquals(writerSpy.calls.length, 1);
  assertEquals(writerSpy.calls[0], {
    mode: "overwrite",
    path: "/safe/notes/export.md",
    events: 1,
    hasNow: true,
    includeCommentary: undefined,
    includeThinking: undefined,
    includeToolCalls: undefined,
    italicizeUserMessages: undefined,
  });
});

Deno.test(
  "RecordingPipeline appendToActiveRecording returns false flags when no recording is active",
  async () => {
    const order: string[] = [];
    const writerSpy = makeWriterSpy(order);
    const pipeline = new RecordingPipeline({
      pathPolicyGate: makeSequencedPathPolicyGate(["allow"], order),
      writer: writerSpy.writer,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    const result = await pipeline.appendToActiveRecording({
      provider: "codex",
      sessionId: "missing-session",
      events: [makeEvent("noop")],
    });

    assertEquals(result, {
      appended: false,
      deduped: false,
    });
    assertEquals(writerSpy.calls.length, 0);
  },
);

Deno.test(
  "RecordingPipeline appendToActiveRecording updates lastWriteAt on write and preserves it on dedupe",
  async () => {
    const order: string[] = [];
    const writerSpy = makeWriterSpy(order);
    writerSpy.appendOutcomes.push(
      { wrote: true, deduped: false },
      { wrote: false, deduped: true },
    );

    const timestamps = [
      "2026-02-22T10:00:00.000Z",
      "2026-02-22T10:00:05.000Z",
    ];
    let nextTimestamp = 0;
    const pipeline = new RecordingPipeline({
      pathPolicyGate: makeSequencedPathPolicyGate(["allow"], order),
      writer: writerSpy.writer,
      makeRecordingId: () => "rec-hot-path",
      now: () =>
        new Date(
          timestamps[Math.min(nextTimestamp++, timestamps.length - 1)],
        ),
    });

    await pipeline.startOrRotateRecording({
      provider: "codex",
      sessionId: "session-append",
      targetPath: "notes/live.md",
    });

    const firstAppend = await pipeline.appendToActiveRecording({
      provider: "codex",
      sessionId: "session-append",
      events: [makeEvent("first")],
    });
    assertEquals(firstAppend.appended, true);
    assertEquals(firstAppend.deduped, false);
    assertEquals(
      firstAppend.recording?.lastWriteAt,
      "2026-02-22T10:00:05.000Z",
    );

    const secondAppend = await pipeline.appendToActiveRecording({
      provider: "codex",
      sessionId: "session-append",
      events: [makeEvent("duplicate")],
    });
    assertEquals(secondAppend.appended, false);
    assertEquals(secondAppend.deduped, true);
    assertEquals(
      secondAppend.recording?.lastWriteAt,
      "2026-02-22T10:00:05.000Z",
    );

    const active = pipeline.getActiveRecording("codex", "session-append");
    assertEquals(active?.lastWriteAt, "2026-02-22T10:00:05.000Z");
    assertEquals(writerSpy.calls.map((call) => call.hasNow), [true, true]);
  },
);

Deno.test(
  "RecordingPipeline applies default writer render options from pipeline config",
  async () => {
    const order: string[] = [];
    const writerSpy = makeWriterSpy(order);
    const pipeline = new RecordingPipeline({
      pathPolicyGate: makeSequencedPathPolicyGate(["allow", "allow"], order),
      writer: writerSpy.writer,
      defaultRenderOptions: {
        includeCommentary: true,
        includeThinking: false,
        includeToolCalls: false,
        italicizeUserMessages: true,
      },
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    await pipeline.startOrRotateRecording({
      provider: "codex",
      sessionId: "session-flags",
      targetPath: "notes/with-flags.md",
      seedEvents: [makeEvent("seed")],
    });

    await pipeline.appendToActiveRecording({
      provider: "codex",
      sessionId: "session-flags",
      events: [makeEvent("append")],
    });

    assertEquals(writerSpy.calls.length, 2);
    assertEquals(writerSpy.calls[0], {
      mode: "append",
      path: "/safe/notes/with-flags.md",
      events: 1,
      hasNow: true,
      includeCommentary: true,
      includeThinking: false,
      includeToolCalls: false,
      italicizeUserMessages: true,
    });
    assertEquals(writerSpy.calls[1], {
      mode: "append",
      path: "/safe/notes/with-flags.md",
      events: 1,
      hasNow: true,
      includeCommentary: true,
      includeThinking: false,
      includeToolCalls: false,
      italicizeUserMessages: true,
    });
  },
);

Deno.test(
  "RecordingPipeline frontmatter conversationEventKinds include all event kinds",
  async () => {
    const order: string[] = [];
    const writerSpy = makeWriterSpy(order);
    const pipeline = new RecordingPipeline({
      pathPolicyGate: makeSequencedPathPolicyGate(["allow", "allow"], order),
      writer: writerSpy.writer,
      includeConversationEventKindsInFrontmatter: true,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    await pipeline.startOrRotateRecording({
      provider: "codex",
      sessionId: "session-kinds",
      targetPath: "notes/kinds.md",
      seedEvents: [makeEvent("seed"), makeToolCallEvent()],
    });
    assertEquals(
      writerSpy.renderOptionsByCall[0]?.frontmatterConversationEventKinds,
      ["message.assistant", "tool.call"],
    );

    const pipelineWithoutKinds = new RecordingPipeline({
      pathPolicyGate: makeSequencedPathPolicyGate(["allow"], order),
      writer: writerSpy.writer,
      includeConversationEventKindsInFrontmatter: false,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    await pipelineWithoutKinds.startOrRotateRecording({
      provider: "claude",
      sessionId: "session-no-kinds",
      targetPath: "notes/no-kinds.md",
      seedEvents: [makeEvent("seed")],
    });
    assertEquals(
      writerSpy.renderOptionsByCall[1]?.frontmatterConversationEventKinds,
      undefined,
    );
  },
);
