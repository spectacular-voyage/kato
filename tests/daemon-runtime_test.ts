import { assert, assertEquals, assertExists } from "@std/assert";
import type { ConversationEvent, DaemonStatusSnapshot } from "@kato/shared";
import {
  AuditLogger,
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  InMemorySessionSnapshotStore,
  type LogRecord,
  type ProviderIngestionRunner,
  type RecordingPipelineLike,
  runDaemonRuntimeLoop,
  type SessionSnapshotStore,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";

function makeEvent(
  id: string,
  kind: "message.user" | "message.assistant",
  content: string,
  timestamp = "2026-02-22T19:00:00.000Z",
): ConversationEvent {
  return {
    eventId: id,
    provider: "codex",
    sessionId: "session-1",
    timestamp,
    kind,
    role: kind === "message.user" ? "user" : "assistant",
    content,
    source: {
      providerEventType: kind === "message.user" ? "user" : "assistant",
      providerEventId: id,
    },
  } as unknown as ConversationEvent;
}

class CaptureSink {
  records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

Deno.test("runDaemonRuntimeLoop processes stop requests and updates status", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-1",
    requestedAt: "2026-02-22T10:00:00.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertExists(statusHistory[0]);
  assertEquals(statusHistory[0]?.daemonRunning, true);
  assertEquals(statusHistory[0]?.daemonPid, 4242);

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last?.daemonRunning, false);
  assertEquals(last?.daemonPid, undefined);
  assertEquals(requests.length, 0);
});

Deno.test("runDaemonRuntimeLoop routes export requests through recording pipeline", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "session-42",
        resolvedOutputPath: ".kato/test-runtime/session-42.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{
    provider: string;
    sessionId: string;
    targetPath: string;
    eventCount: number;
  }> = [];

  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({
        provider: input.provider,
        sessionId: input.sessionId,
        targetPath: input.targetPath,
        eventCount: input.events.length,
      });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const loadedSessions: string[] = [];
  const sessionMessages = [
    makeEvent(
      "m1",
      "message.assistant",
      "export me",
      "2026-02-22T10:00:00.000Z",
    ),
  ];

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(sessionId: string) {
      loadedSessions.push(sessionId);
      return Promise.resolve({
        provider: "unknown",
        events: sessionMessages,
      });
    },
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(loadedSessions, ["session-42"]);
  assertEquals(exported.length, 1);
  assertEquals(exported[0], {
    provider: "unknown",
    sessionId: "session-42",
    targetPath: ".kato/test-runtime/session-42.md",
    eventCount: 1,
  });
  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last?.daemonRunning, false);
});

Deno.test("runDaemonRuntimeLoop uses provider-aware session snapshots when available", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "session-with-provider",
        resolvedOutputPath: ".kato/test-runtime/session-with-provider.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ provider: string; sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({
        provider: input.provider,
        sessionId: input.sessionId,
      });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const loadedSnapshots: string[] = [];
  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(sessionId: string) {
      loadedSnapshots.push(sessionId);
      return Promise.resolve({
        provider: "codex",
        events: [
          makeEvent(
            "m1",
            "message.assistant",
            "export me",
            "2026-02-22T10:00:00.000Z",
          ),
        ],
      });
    },
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(loadedSnapshots, ["session-with-provider"]);
  assertEquals(exported, [{
    provider: "codex",
    sessionId: "session-with-provider",
  }]);
});

Deno.test("runDaemonRuntimeLoop skips export when session snapshot is missing", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "missing-session",
        resolvedOutputPath: ".kato/test-runtime/missing-session.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const processed: string[] = [];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      processed.push(requestId);
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({ sessionId: input.sessionId });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(_sessionId: string) {
      return Promise.resolve(undefined);
    },
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(exported.length, 0);
  assertEquals(processed.includes("req-export"), true);
  assertEquals(processed.includes("req-stop"), true);
  assertEquals(
    sink.records.some((record) =>
      record.event === "daemon.control.export.session_missing" &&
      record.channel === "operational"
    ),
    true,
  );
});

Deno.test("runDaemonRuntimeLoop skips export when session snapshot has no messages", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "empty-session",
        resolvedOutputPath: ".kato/test-runtime/empty-session.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const processed: string[] = [];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      processed.push(requestId);
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({ sessionId: input.sessionId });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(_sessionId: string) {
      return Promise.resolve({
        provider: "codex",
        events: [],
      });
    },
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(exported.length, 0);
  assertEquals(processed.includes("req-export"), true);
  assertEquals(processed.includes("req-stop"), true);
  assertEquals(
    sink.records.some((record) =>
      record.event === "daemon.control.export.empty" &&
      record.channel === "operational"
    ),
    true,
  );
});

Deno.test("runDaemonRuntimeLoop skips export requests when export feature is disabled", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "session-42",
        resolvedOutputPath: ".kato/test-runtime/session-42.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const processed: string[] = [];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      processed.push(requestId);
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({ sessionId: input.sessionId });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const loadedSessions: string[] = [];
  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(sessionId: string) {
      loadedSessions.push(sessionId);
      return Promise.resolve({
        provider: "unknown",
        events: [],
      });
    },
    exportEnabled: false,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(loadedSessions.length, 0);
  assertEquals(exported.length, 0);
  assertEquals(processed.includes("req-export"), true);
  assertEquals(processed.includes("req-stop"), true);
});

Deno.test("runDaemonRuntimeLoop starts, polls, and stops ingestion runners", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const calls: string[] = [];
  const runner: ProviderIngestionRunner = {
    provider: "claude",
    start() {
      calls.push("start");
      return Promise.resolve();
    },
    poll() {
      calls.push("poll");
      return Promise.resolve({
        provider: "claude",
        polledAt: "2026-02-22T10:00:00.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      calls.push("stop");
      return Promise.resolve();
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    ingestionRunners: [runner],
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(calls, ["start", "poll", "stop"]);
});

Deno.test("runDaemonRuntimeLoop populates status.providers from session snapshot store", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore: SessionSnapshotStore = {
    upsert() {
      throw new Error("not used");
    },
    get() {
      return undefined;
    },
    list() {
      return [
        {
          provider: "codex",
          sessionId: "s1",
          cursor: { kind: "byte-offset", value: 12 },
          events: [
            makeEvent(
              "m1",
              "message.assistant",
              "hello",
              "2026-02-22T10:00:00.000Z",
            ),
          ],
          conversationSchemaVersion: 2,
          metadata: {
            updatedAt: "2026-02-22T10:00:00.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:00.000Z",
          },
        },
        {
          provider: "codex",
          sessionId: "s2",
          cursor: { kind: "byte-offset", value: 24 },
          events: [
            makeEvent(
              "m2",
              "message.assistant",
              "world",
              "2026-02-22T10:00:05.000Z",
            ),
          ],
          conversationSchemaVersion: 2,
          metadata: {
            updatedAt: "2026-02-22T10:00:05.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:05.000Z",
          },
        },
        {
          provider: "claude",
          sessionId: "s3",
          cursor: { kind: "byte-offset", value: 8 },
          events: [
            makeEvent(
              "m3",
              "message.assistant",
              "hi",
              "2026-02-22T10:00:03.000Z",
            ),
          ],
          conversationSchemaVersion: 2,
          metadata: {
            updatedAt: "2026-02-22T10:00:03.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:03.000Z",
          },
        },
      ];
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:06.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.providers, [
    {
      provider: "claude",
      activeSessions: 1,
      lastMessageAt: "2026-02-22T10:00:03.000Z",
    },
    {
      provider: "codex",
      activeSessions: 2,
      lastMessageAt: "2026-02-22T10:00:05.000Z",
    },
  ]);
});

Deno.test("runDaemonRuntimeLoop omits lastMessageAt when provider sessions have no message timestamps", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore: SessionSnapshotStore = {
    upsert() {
      throw new Error("not used");
    },
    get() {
      return undefined;
    },
    list() {
      return [{
        provider: "codex",
        sessionId: "s1",
        cursor: { kind: "byte-offset", value: 12 },
        events: [
          makeEvent(
            "m1",
            "message.assistant",
            "hello",
            "2026-02-22T10:00:00.000Z",
          ),
        ],
        conversationSchemaVersion: 2,
        metadata: {
          updatedAt: "2026-02-22T10:00:00.000Z",
          eventCount: 1,
          truncatedEvents: 0,
        },
      }];
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:06.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.providers, [{
    provider: "codex",
    activeSessions: 1,
  }]);
});

Deno.test("runDaemonRuntimeLoop omits stale provider snapshots from status.providers", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore: SessionSnapshotStore = {
    upsert() {
      throw new Error("not used");
    },
    get() {
      return undefined;
    },
    list() {
      return [{
        provider: "codex",
        sessionId: "stale",
        cursor: { kind: "byte-offset", value: 10 },
        events: [
          makeEvent(
            "m1",
            "message.assistant",
            "stale",
            "2026-02-22T09:00:00.000Z",
          ),
        ],
        conversationSchemaVersion: 2,
        metadata: {
          updatedAt: "2026-02-22T09:00:00.000Z",
          eventCount: 1,
          truncatedEvents: 0,
          lastEventAt: "2026-02-22T09:00:00.000Z",
        },
      }];
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    providerStatusStaleAfterMs: 1_000,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.providers, []);
});

Deno.test("runDaemonRuntimeLoop applies in-chat ::record commands from newly ingested messages", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  let pollCount = 0;
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      return Promise.resolve();
    },
    poll() {
      pollCount += 1;

      const baselineMessage = makeEvent(
        "m1",
        "message.user",
        "::record @notes/old.md\nold command",
        "2026-02-22T10:00:00.000Z",
      );
      const newCommandMessage = makeEvent(
        "m2",
        "message.user",
        "::record @notes/new.md\nnew command",
        "2026-02-22T10:00:01.000Z",
      );
      const assistantReply = makeEvent(
        "m3",
        "message.assistant",
        "recording now",
        "2026-02-22T10:00:02.000Z",
      );

      if (pollCount === 1) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-1",
          cursor: { kind: "byte-offset", value: 10 },
          events: [baselineMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:00.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 2) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-1",
          cursor: { kind: "byte-offset", value: 20 },
          events: [baselineMessage, newCommandMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 3) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-1",
          cursor: { kind: "byte-offset", value: 30 },
          events: [baselineMessage, newCommandMessage, assistantReply],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:02.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      return Promise.resolve({
        provider: "codex",
        polledAt: "2026-02-22T10:00:03.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:05.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      if (pollCount >= 3) {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const rotatedTargets: string[] = [];
  const appendedMessageIds: string[] = [];
  let activeRecording = false;
  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording(input) {
      activeRecording = true;
      rotatedTargets.push(input.targetPath);
      const nowIso = "2026-02-22T10:00:01.000Z";
      return Promise.resolve({
        recordingId: "rec-1",
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath: input.targetPath,
        startedAt: nowIso,
        lastWriteAt: nowIso,
      });
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot() {
      throw new Error("not used");
    },
    appendToActiveRecording(input) {
      if (!activeRecording) {
        return Promise.resolve({
          appended: false,
          deduped: false,
        });
      }

      for (const event of input.events) {
        appendedMessageIds.push(event.eventId);
      }
      return Promise.resolve({
        appended: true,
        deduped: false,
      });
    },
    stopRecording() {
      activeRecording = false;
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: activeRecording ? 1 : 0,
        destinations: activeRecording ? 1 : 0,
      };
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    ingestionRunners: [ingestionRunner],
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(rotatedTargets, ["notes/new.md"]);
  assertEquals(appendedMessageIds, ["m2", "m3"]);
});

Deno.test("runDaemonRuntimeLoop applies in-chat ::capture then activates recording on same path", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  let pollCount = 0;
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      return Promise.resolve();
    },
    poll() {
      pollCount += 1;

      const baselineMessage = makeEvent(
        "m1",
        "message.user",
        "plain baseline",
        "2026-02-22T10:00:00.000Z",
      );
      const captureCommandMessage = makeEvent(
        "m2",
        "message.user",
        "::capture @notes/captured.md\ncapture now",
        "2026-02-22T10:00:01.000Z",
      );
      const assistantReply = makeEvent(
        "m3",
        "message.assistant",
        "captured and now recording",
        "2026-02-22T10:00:02.000Z",
      );

      if (pollCount === 1) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-capture",
          cursor: { kind: "byte-offset", value: 10 },
          events: [baselineMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:00.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 2) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-capture",
          cursor: { kind: "byte-offset", value: 20 },
          events: [baselineMessage, captureCommandMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 3) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-capture",
          cursor: { kind: "byte-offset", value: 30 },
          events: [baselineMessage, captureCommandMessage, assistantReply],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:02.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      return Promise.resolve({
        provider: "codex",
        polledAt: "2026-02-22T10:00:03.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:05.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      if (pollCount >= 3) {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const callOrder: string[] = [];
  const captureTargets: string[] = [];
  const rotatedTargets: string[] = [];
  const appendedMessageIds: string[] = [];
  let activeRecording = false;
  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording(input) {
      callOrder.push("record");
      activeRecording = true;
      rotatedTargets.push(input.targetPath);
      const nowIso = "2026-02-22T10:00:01.000Z";
      return Promise.resolve({
        recordingId: "rec-capture",
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath: input.targetPath,
        startedAt: nowIso,
        lastWriteAt: nowIso,
      });
    },
    captureSnapshot(input) {
      callOrder.push("capture");
      captureTargets.push(input.targetPath);
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    exportSnapshot() {
      throw new Error("not used");
    },
    appendToActiveRecording(input) {
      if (!activeRecording) {
        return Promise.resolve({
          appended: false,
          deduped: false,
        });
      }

      for (const event of input.events) {
        appendedMessageIds.push(event.eventId);
      }
      return Promise.resolve({
        appended: true,
        deduped: false,
      });
    },
    stopRecording() {
      activeRecording = false;
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: activeRecording ? 1 : 0,
        destinations: activeRecording ? 1 : 0,
      };
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    ingestionRunners: [ingestionRunner],
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(callOrder, ["capture", "record"]);
  assertEquals(captureTargets, ["notes/captured.md"]);
  assertEquals(rotatedTargets, ["notes/captured.md"]);
  assertEquals(appendedMessageIds, ["m2", "m3"]);
});

Deno.test("runDaemonRuntimeLoop fails closed when in-chat command parsing reports errors", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  let pollCount = 0;
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      return Promise.resolve();
    },
    poll() {
      pollCount += 1;

      const baselineMessage = makeEvent(
        "base",
        "message.user",
        "hello",
        "2026-02-22T10:00:00.000Z",
      );
      const invalidCommandMessage = makeEvent(
        "invalid",
        "message.user",
        "::record\n::record notes/should-not-run.md",
        "2026-02-22T10:00:01.000Z",
      );

      if (pollCount === 1) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-parse-error",
          cursor: { kind: "byte-offset", value: 10 },
          events: [baselineMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:00.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 2) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-parse-error",
          cursor: { kind: "byte-offset", value: 20 },
          events: [baselineMessage, invalidCommandMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      return Promise.resolve({
        provider: "codex",
        polledAt: "2026-02-22T10:00:02.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:05.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      if (pollCount >= 2) {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  let startOrRotateCalls = 0;
  const recordingPipeline: RecordingPipelineLike = {
    startOrRotateRecording() {
      startOrRotateCalls += 1;
      throw new Error("should not be called");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot() {
      throw new Error("not used");
    },
    appendToActiveRecording() {
      return Promise.resolve({
        appended: false,
        deduped: false,
      });
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    ingestionRunners: [ingestionRunner],
    sessionSnapshotStore,
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(startOrRotateCalls, 0);
  assert(
    sink.records.some((record) =>
      record.event === "recording.command.parse_error" &&
      record.channel === "operational"
    ),
  );
  assert(
    sink.records.some((record) =>
      record.event === "recording.command.parse_error" &&
      record.channel === "security-audit"
    ),
  );
});
