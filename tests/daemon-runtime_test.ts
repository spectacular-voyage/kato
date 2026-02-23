import { assertEquals, assertExists } from "@std/assert";
import type { DaemonStatusSnapshot, Message } from "@kato/shared";
import {
  AuditLogger,
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  type LogRecord,
  type ProviderIngestionRunner,
  type RecordingPipelineLike,
  runDaemonRuntimeLoop,
  type SessionSnapshotStore,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";

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
    messageCount: number;
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
        messageCount: input.messages.length,
      });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
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
  const sessionMessages: Message[] = [{
    id: "m1",
    role: "assistant",
    content: "export me",
    timestamp: "2026-02-22T10:00:00.000Z",
    model: "claude-opus-4-6",
  }];

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionMessages(sessionId: string) {
      loadedSessions.push(sessionId);
      return Promise.resolve([...sessionMessages]);
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
    messageCount: 1,
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
        messages: [{
          id: "m1",
          role: "assistant",
          content: "export me",
          timestamp: "2026-02-22T10:00:00.000Z",
        }],
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
        messages: [],
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
    loadSessionMessages(sessionId: string) {
      loadedSessions.push(sessionId);
      return Promise.resolve([]);
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
        messagesObserved: 0,
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
          messages: [{
            id: "m1",
            role: "assistant",
            content: "hello",
            timestamp: "2026-02-22T10:00:00.000Z",
          }],
          metadata: {
            updatedAt: "2026-02-22T10:00:00.000Z",
            messageCount: 1,
            truncatedMessages: 0,
            lastMessageAt: "2026-02-22T10:00:00.000Z",
          },
        },
        {
          provider: "codex",
          sessionId: "s2",
          cursor: { kind: "byte-offset", value: 24 },
          messages: [{
            id: "m2",
            role: "assistant",
            content: "world",
            timestamp: "2026-02-22T10:00:05.000Z",
          }],
          metadata: {
            updatedAt: "2026-02-22T10:00:05.000Z",
            messageCount: 1,
            truncatedMessages: 0,
            lastMessageAt: "2026-02-22T10:00:05.000Z",
          },
        },
        {
          provider: "claude",
          sessionId: "s3",
          cursor: { kind: "byte-offset", value: 8 },
          messages: [{
            id: "m3",
            role: "assistant",
            content: "hi",
            timestamp: "2026-02-22T10:00:03.000Z",
          }],
          metadata: {
            updatedAt: "2026-02-22T10:00:03.000Z",
            messageCount: 1,
            truncatedMessages: 0,
            lastMessageAt: "2026-02-22T10:00:03.000Z",
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
        messages: [{
          id: "m1",
          role: "assistant",
          content: "hello",
          timestamp: "2026-02-22T10:00:00.000Z",
        }],
        metadata: {
          updatedAt: "2026-02-22T10:00:00.000Z",
          messageCount: 1,
          truncatedMessages: 0,
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
        messages: [{
          id: "m1",
          role: "assistant",
          content: "stale",
          timestamp: "2026-02-22T09:00:00.000Z",
        }],
        metadata: {
          updatedAt: "2026-02-22T09:00:00.000Z",
          messageCount: 1,
          truncatedMessages: 0,
          lastMessageAt: "2026-02-22T09:00:00.000Z",
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
