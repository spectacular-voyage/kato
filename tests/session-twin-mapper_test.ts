import { assert, assertEquals } from "@std/assert";
import type { ConversationEvent, SessionTwinEventV1 } from "@kato/shared";
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
    makeUserEvent("hello\n::record-My.Proj /tmp/a.md\n::stop"),
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
  assertEquals(commandEvents[0]?.payload["command"], "record");
  assertEquals(commandEvents[0]?.payload["workspaceAlias"], "My.Proj");
  assertEquals(commandEvents[0]?.payload["rawArgument"], "/tmp/a.md");
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

Deno.test("mapTwinEventsToConversation reconstructs scoped kato commands with raw arguments", () => {
  const roundTrip = mapTwinEventsToConversation(
    [
      {
        schemaVersion: 1,
        seq: 1,
        session: {
          provider: "codex",
          providerSessionId: "provider-session-5",
          sessionId: "kato-session-5",
        },
        kind: "user.kato-command",
        source: {
          providerEventType: "user.kato-command",
          cursor: { kind: "byte-offset", value: 1 },
          emitIndex: 1,
        },
        payload: {
          command: "record",
          workspaceAlias: "My.Proj",
          rawArgument: "/tmp/a.md",
        },
      },
      {
        schemaVersion: 1,
        seq: 2,
        session: {
          provider: "codex",
          providerSessionId: "provider-session-5",
          sessionId: "kato-session-5",
        },
        kind: "user.kato-command",
        source: {
          providerEventType: "user.kato-command",
          cursor: { kind: "byte-offset", value: 2 },
          emitIndex: 1,
        },
        payload: {
          command: "stop",
          workspaceAlias: "My.Proj",
        },
      },
    ],
    { includeKatoCommandsAsUserMessages: true },
  );

  assertEquals(roundTrip.length, 2);
  assertEquals(roundTrip[0]?.kind, "message.user");
  if (roundTrip[0]?.kind !== "message.user") {
    throw new Error("expected first event to be message.user");
  }
  assertEquals(roundTrip[0].content, "::record-My.Proj /tmp/a.md");
  assertEquals(roundTrip[1]?.kind, "message.user");
  if (roundTrip[1]?.kind !== "message.user") {
    throw new Error("expected second event to be message.user");
  }
  assertEquals(roundTrip[1].content, "::stop-My.Proj");
});

Deno.test("mapConversationEventsToTwin preserves non-message event kinds and decision metadata", () => {
  const events: ConversationEvent[] = [
    {
      eventId: "u-live",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:00.000Z",
      kind: "message.user",
      role: "user",
      content: "::init",
      source: {
        providerEventType: "user",
        providerEventId: "u-live",
        rawCursor: { kind: "byte-offset", value: 1 },
      },
    },
    {
      eventId: "a-live",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:01.000Z",
      kind: "message.assistant",
      role: "assistant",
      content: "Working on it.",
      model: "claude-sonnet",
      phase: "commentary",
      source: {
        providerEventType: "assistant",
        rawCursor: { kind: "byte-offset", value: 2 },
      },
    },
    {
      eventId: "thinking-1",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:02.000Z",
      kind: "thinking",
      content: "Need to inspect runtime state.",
      source: {
        providerEventType: "assistant_thinking",
        rawCursor: { kind: "byte-offset", value: 3 },
      },
    },
    {
      eventId: "tool-call-1",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:03.000Z",
      kind: "tool.call",
      toolCallId: "tool-1",
      name: "search",
      description: "Inspect files",
      input: { path: "apps/daemon/src" },
      source: {
        providerEventType: "tool_use",
        rawCursor: { kind: "byte-offset", value: 4 },
      },
    },
    {
      eventId: "tool-result-1",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:04.000Z",
      kind: "tool.result",
      toolCallId: "tool-1",
      result: "found",
      source: {
        providerEventType: "tool_result",
        rawCursor: { kind: "byte-offset", value: 5 },
      },
    },
    {
      eventId: "decision-proposed",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:05.000Z",
      kind: "decision",
      decisionId: "decision-1",
      decisionKey: "start_with",
      summary: "Which file should we start with?",
      status: "proposed",
      decidedBy: "assistant",
      basisEventIds: ["tool-call-1"],
      metadata: {
        providerQuestionId: "question-1",
        options: [
          { label: "mapper", description: "session_twin_mapper.ts" },
          { label: "launcher", description: "launcher.ts" },
        ],
        multiSelect: false,
      },
      source: {
        providerEventType: "tool_use",
        rawCursor: { kind: "byte-offset", value: 6 },
      },
    } as ConversationEvent,
    {
      eventId: "decision-accepted",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:06.000Z",
      kind: "decision",
      decisionId: "decision-1",
      decisionKey: "start_with",
      summary: "mapper",
      status: "accepted",
      decidedBy: "user",
      basisEventIds: ["tool-result-1"],
      metadata: {
        providerQuestionId: "question-1",
      },
      source: {
        providerEventType: "tool_result",
        rawCursor: { kind: "byte-offset", value: 7 },
      },
    } as ConversationEvent,
    {
      eventId: "decision-unmodeled",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:07.000Z",
      kind: "decision",
      decisionId: "decision-2",
      decisionKey: "start_with",
      summary: "skip",
      status: "rejected",
      decidedBy: "assistant",
      basisEventIds: ["tool-result-1"],
      metadata: {
        reason: "not selected",
      },
      source: {
        providerEventType: "decision",
      },
    } as ConversationEvent,
    {
      eventId: "system-1",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:08.000Z",
      kind: "message.system",
      role: "system",
      content: "system note",
      source: {
        providerEventType: "system",
      },
    },
    {
      eventId: "info-1",
      provider: "claude",
      sessionId: "provider-session-6",
      timestamp: "2026-02-26T12:00:09.000Z",
      kind: "provider.info",
      content: "syncing",
      subtype: "lifecycle",
      level: "warn",
      source: {
        providerEventType: "provider.info",
      },
    },
  ];

  const twin = mapConversationEventsToTwin({
    provider: "claude",
    providerSessionId: "provider-session-6",
    sessionId: "kato-session-6",
    events,
    mode: "live",
    capturedAt: "2026-02-26T12:01:00.000Z",
  });

  assertEquals(twin.length, 11);
  assertEquals(twin[0]?.kind, "user.message");
  assertEquals(twin[0]?.time?.providerTimestamp, "2026-02-26T12:00:00.000Z");
  assertEquals(twin[0]?.time?.capturedAt, "2026-02-26T12:01:00.000Z");

  const parseErrorCommand = twin.find((event) =>
    event.kind === "user.kato-command"
  );
  assertEquals(parseErrorCommand?.payload["command"], "unknown");
  assertEquals(parseErrorCommand?.payload["parseErrors"], [
    {
      line: 1,
      reason:
        "Unsupported control command '::init'. Use ::record-<alias>, ::capture-<alias>, or ::export-<alias>.",
    },
  ]);

  const assistantMessage = twin.find((event) =>
    event.kind === "assistant.message"
  );
  assertEquals(assistantMessage?.model, "claude-sonnet");
  assertEquals(assistantMessage?.payload["phase"], "commentary");

  const thinking = twin.find((event) => event.kind === "assistant.thinking");
  assertEquals(thinking?.payload["text"], "Need to inspect runtime state.");

  const toolCall = twin.find((event) => event.kind === "assistant.tool.call");
  assertEquals(toolCall?.payload["description"], "Inspect files");
  assertEquals(toolCall?.payload["input"], { path: "apps/daemon/src" });

  const promptDecision = twin.find((event) =>
    event.kind === "assistant.decision.prompt"
  );
  assertEquals(promptDecision?.payload["providerQuestionId"], "question-1");
  assertEquals(promptDecision?.payload["multiSelect"], false);

  const responseDecision = twin.find((event) =>
    event.kind === "user.decision.response"
  );
  assertEquals(responseDecision?.payload["selection"], "mapper");

  const unmodeledDecision = twin.find((event) => event.kind === "provider.raw");
  assertEquals(unmodeledDecision?.payload["rawType"], "decision.unmodeled");
  assertEquals(unmodeledDecision?.source.cursor, {
    kind: "opaque",
    value: "decision-unmodeled",
  });

  const systemMessage = twin.find((event) => event.kind === "system.message");
  assertEquals(systemMessage?.source.cursor, {
    kind: "opaque",
    value: "system-1",
  });

  const infoMessage = twin.find((event) => event.kind === "provider.info");
  assertEquals(infoMessage?.payload["subtype"], "lifecycle");
  assertEquals(infoMessage?.payload["level"], "warn");
});

Deno.test("mapTwinEventsToConversation restores rich twin events and skips invalid payloads", () => {
  const events: SessionTwinEventV1[] = [
    {
      schemaVersion: 1,
      seq: 1,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "user.kato-command",
      source: {
        providerEventType: "user.kato-command",
        cursor: { kind: "byte-offset", value: 1 },
        emitIndex: 1,
      },
      payload: {
        command: "stop",
      },
    },
    {
      schemaVersion: 1,
      seq: 2,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "assistant.message",
      source: {
        providerEventType: "assistant",
        providerEventId: "a-2",
        cursor: { kind: "byte-offset", value: 2 },
        emitIndex: 0,
      },
      time: {
        providerTimestamp: "2026-02-26T12:10:00.000Z",
        capturedAt: "2026-02-26T12:10:30.000Z",
      },
      model: "claude-sonnet",
      payload: {
        text: "Rendered answer",
        phase: "final",
      },
    },
    {
      schemaVersion: 1,
      seq: 3,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "assistant.thinking",
      source: {
        providerEventType: "thinking",
        cursor: { kind: "byte-offset", value: 3 },
        emitIndex: 0,
      },
      payload: {
        text: "Need to gather context",
      },
    },
    {
      schemaVersion: 1,
      seq: 4,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "assistant.tool.call",
      source: {
        providerEventType: "tool_use",
        cursor: { kind: "byte-offset", value: 4 },
        emitIndex: 0,
      },
      payload: {
        toolCallId: "tool-7",
        name: "search",
        description: "find status helpers",
        input: { q: "renderStatusText" },
      },
    },
    {
      schemaVersion: 1,
      seq: 5,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "assistant.tool.result",
      source: {
        providerEventType: "tool_result",
        cursor: { kind: "byte-offset", value: 5 },
        emitIndex: 0,
      },
      payload: {
        toolCallId: "tool-7",
        result: 42,
      },
    },
    {
      schemaVersion: 1,
      seq: 6,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "assistant.decision.prompt",
      source: {
        providerEventType: "tool_use",
        cursor: { kind: "byte-offset", value: 6 },
        emitIndex: 0,
      },
      payload: {
        prompt: "Which file should we start with?",
        providerQuestionId: "question-7",
        options: [
          { label: "mapper", description: "session_twin_mapper.ts" },
        ],
        multiSelect: false,
      },
    },
    {
      schemaVersion: 1,
      seq: 7,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "user.decision.response",
      source: {
        providerEventType: "tool_result",
        cursor: { kind: "byte-offset", value: 7 },
        emitIndex: 0,
      },
      time: {
        capturedAt: "2026-02-26T12:11:00.000Z",
      },
      payload: {
        selection: "mapper",
        providerQuestionId: "question-7",
      },
    },
    {
      schemaVersion: 1,
      seq: 8,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "system.message",
      source: {
        providerEventType: "system",
        cursor: { kind: "byte-offset", value: 8 },
        emitIndex: 0,
      },
      payload: {
        text: "System reminder",
      },
    },
    {
      schemaVersion: 1,
      seq: 9,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "provider.info",
      source: {
        providerEventType: "provider.info",
        cursor: { kind: "byte-offset", value: 9 },
        emitIndex: 0,
      },
      payload: {
        text: "syncing",
        subtype: "lifecycle",
        level: "info",
      },
    },
    {
      schemaVersion: 1,
      seq: 10,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "assistant.tool.call",
      source: {
        providerEventType: "tool_use",
        cursor: { kind: "byte-offset", value: 10 },
        emitIndex: 0,
      },
      payload: {
        toolCallId: "tool-invalid",
      },
    },
    {
      schemaVersion: 1,
      seq: 11,
      session: {
        provider: "claude",
        providerSessionId: "provider-session-7",
        sessionId: "kato-session-7",
      },
      kind: "provider.raw",
      source: {
        providerEventType: "provider.raw",
        cursor: { kind: "byte-offset", value: 11 },
        emitIndex: 0,
      },
      payload: {
        rawType: "unmodeled",
      },
    },
  ];

  const roundTrip = mapTwinEventsToConversation(events);

  assertEquals(roundTrip.length, 8);
  assertEquals(roundTrip[0]?.kind, "message.assistant");
  if (roundTrip[0]?.kind !== "message.assistant") {
    throw new Error("expected assistant message");
  }
  assertEquals(roundTrip[0].timestamp, "2026-02-26T12:10:00.000Z");
  assertEquals(roundTrip[0].model, "claude-sonnet");
  assertEquals(roundTrip[0].phase, "final");

  assertEquals(roundTrip[1]?.kind, "thinking");

  assertEquals(roundTrip[2]?.kind, "tool.call");
  if (roundTrip[2]?.kind !== "tool.call") {
    throw new Error("expected tool call");
  }
  assertEquals(roundTrip[2].description, "find status helpers");
  assertEquals(roundTrip[2].input, { q: "renderStatusText" });

  assertEquals(roundTrip[3]?.kind, "tool.result");
  if (roundTrip[3]?.kind !== "tool.result") {
    throw new Error("expected tool result");
  }
  assertEquals(roundTrip[3].result, "42");

  assertEquals(roundTrip[4]?.kind, "decision");
  if (roundTrip[4]?.kind !== "decision") {
    throw new Error("expected prompt decision");
  }
  assertEquals(
    roundTrip[4].decisionId,
    "kato-session-7:6:assistant.decision.prompt",
  );
  assertEquals(roundTrip[4].decisionKey, "decision-6");
  assertEquals(roundTrip[4].metadata, {
    providerQuestionId: "question-7",
    options: [
      { label: "mapper", description: "session_twin_mapper.ts" },
    ],
    multiSelect: false,
  });

  assertEquals(roundTrip[5]?.kind, "decision");
  if (roundTrip[5]?.kind !== "decision") {
    throw new Error("expected response decision");
  }
  assertEquals(roundTrip[5].timestamp, "2026-02-26T12:11:00.000Z");
  assertEquals(
    roundTrip[5].decisionId,
    "kato-session-7:7:user.decision.response",
  );
  assertEquals(roundTrip[5].basisEventIds, [
    "kato-session-7:7:user.decision.response",
  ]);

  assertEquals(roundTrip[6]?.kind, "message.system");
  assertEquals(roundTrip[7], {
    eventId: "kato-session-7:9:provider.info",
    provider: "claude",
    sessionId: "kato-session-7",
    timestamp: "",
    kind: "provider.info",
    content: "syncing",
    subtype: "lifecycle",
    level: "info",
    source: {
      providerEventType: "provider.info",
      rawCursor: { kind: "byte-offset", value: 9 },
    },
  });

  assertEquals(
    roundTrip.some((event) =>
      event.kind === "message.user" && event.content === "::stop"
    ),
    false,
  );
});
