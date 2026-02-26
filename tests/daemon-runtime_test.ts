import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent, DaemonStatusSnapshot } from "@kato/shared";
import {
  AuditLogger,
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  InMemorySessionSnapshotStore,
  type LogRecord,
  PersistentSessionStateStore,
  type ProviderIngestionRunner,
  type RecordingPipelineLike,
  runDaemonRuntimeLoop,
  SessionSnapshotMemoryBudgetExceededError,
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

Deno.test("runDaemonRuntimeLoop resolves export short session selectors via session state metadata", async () => {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const stateDir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "daemon-runtime-export-resolve-",
  });

  try {
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
        requestId: "req-export-short",
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: "export" as const,
        payload: {
          sessionId: "2ee6e8b4",
          resolvedOutputPath: ".kato/test-runtime/session-short.md",
        },
      },
      {
        requestId: "req-export-prefixed-short",
        requestedAt: "2026-02-22T10:00:01.000Z",
        command: "export" as const,
        payload: {
          sessionId: "codex/2ee6e8b4",
          resolvedOutputPath: ".kato/test-runtime/session-prefixed-short.md",
        },
      },
      {
        requestId: "req-stop",
        requestedAt: "2026-02-22T10:00:02.000Z",
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

    const exportedSessionIds: string[] = [];
    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot(input) {
        exportedSessionIds.push(input.sessionId);
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

    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "2ee6e8b4-1111-2222-3333-444444444444",
    });
    await sessionStateStore.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "provider-session-42",
      sourceFilePath: "/tmp/provider-session-42.jsonl",
      initialCursor: { kind: "byte-offset", value: 0 },
    });

    const loadedSnapshots: string[] = [];
    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      sessionStateStore,
      loadSessionSnapshot(sessionId: string) {
        loadedSnapshots.push(sessionId);
        return Promise.resolve({
          provider: "codex",
          events: [makeEvent("m1", "message.assistant", "export me")],
        });
      },
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(loadedSnapshots, [
      "provider-session-42",
      "provider-session-42",
    ]);
    assertEquals(exportedSessionIds, ["2ee6e8b4", "codex/2ee6e8b4"]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
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

Deno.test("runDaemonRuntimeLoop skips export when session snapshot has no events", async () => {
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

// Note: `lastMessageAt` is the external ProviderStatus field name (status.json API surface,
// intentionally kept for backward compatibility). Internally the snapshot store uses `lastEventAt`.
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
        "2026-02-22T09:59:59.000Z",
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

Deno.test(
  "runDaemonRuntimeLoop applies in-chat ::capture on first seen snapshot when event is newer than daemon start",
  async () => {
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

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-first-seen-capture",
            cursor: { kind: "byte-offset", value: 10 },
            events: [
              makeEvent(
                "m1",
                "message.user",
                "::capture notes/first-seen.md",
                "2026-02-22T10:00:01.000Z",
              ),
            ],
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
      requestedAt: "2026-02-22T10:00:03.000Z",
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

    const callOrder: string[] = [];
    const captureTargets: string[] = [];
    const rotatedTargets: string[] = [];
    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording(input) {
        callOrder.push("record");
        rotatedTargets.push(input.targetPath);
        const nowIso = "2026-02-22T10:00:01.000Z";
        return Promise.resolve({
          recordingId: "rec-first-seen",
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
    assertEquals(captureTargets, ["notes/first-seen.md"]);
    assertEquals(rotatedTargets, ["notes/first-seen.md"]);
  },
);

Deno.test(
  "runDaemonRuntimeLoop does not replay in-chat commands older than daemon start on first seen snapshot",
  async () => {
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

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-prestart-capture",
            cursor: { kind: "byte-offset", value: 10 },
            events: [
              makeEvent(
                "old-capture",
                "message.user",
                "::capture notes/old-command.md",
                "2026-02-22T09:59:59.000Z",
              ),
            ],
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
      requestedAt: "2026-02-22T10:00:03.000Z",
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

    let captureCalls = 0;
    let recordCalls = 0;
    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording() {
        recordCalls += 1;
        throw new Error("should not be called");
      },
      captureSnapshot() {
        captureCalls += 1;
        throw new Error("should not be called");
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

    assertEquals(captureCalls, 0);
    assertEquals(recordCalls, 0);
  },
);

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
        "::export\n::record notes/should-not-run.md",
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

Deno.test("runDaemonRuntimeLoop populates memory stats in status snapshot", async () => {
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
        memory: snapshot.memory ? { ...snapshot.memory } : undefined,
      };
      statusHistory.push({
        ...currentStatus,
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

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 50,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  // Add some data to verify stats
  sessionSnapshotStore.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e1", "message.user", "test")],
  });

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:06.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
    daemonMaxMemoryMb: 50,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertExists(last.memory);
  assertEquals(last.memory?.daemonMaxMemoryBytes, 50 * 1024 * 1024);
  assertExists(last.memory?.process);
  assertExists(last.memory?.snapshots);
  assertEquals(last.memory?.snapshots.sessionCount, 1);
  assertEquals(last.memory?.snapshots.overBudget, false);
});

Deno.test("runDaemonRuntimeLoop logs memory samples and evictions", async () => {
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

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 50,
    retention: { maxSessions: 1, maxEventsPerSession: 100 },
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  sessionSnapshotStore.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e1", "message.user", "first")],
  });
  sessionSnapshotStore.upsert({
    provider: "p1",
    sessionId: "s2",
    cursor: { kind: "byte-offset", value: 1 },
    events: [makeEvent("e2", "message.user", "second")],
  });

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
    sessionSnapshotStore,
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
    daemonMaxMemoryMb: 50,
  });

  assert(
    sink.records.some((record) =>
      record.event === "daemon.memory.sample" &&
      record.channel === "operational"
    ),
  );
  const evictionRecord = sink.records.find((record) =>
    record.event === "daemon.memory.evicted" &&
    record.channel === "operational"
  );
  assertExists(evictionRecord);
  const evictions = evictionRecord.attributes?.["evictions"];
  assertEquals(typeof evictions, "number");
  assert((evictions as number) > 0);
});

Deno.test("runDaemonRuntimeLoop shuts down cleanly on fatal memory-budget error", async () => {
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

  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(_requestId: string) {
      throw new Error("markProcessed should not be called in this test");
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

  const calls: string[] = [];
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      calls.push("start");
      return Promise.resolve();
    },
    poll() {
      calls.push("poll");
      return Promise.reject(
        new SessionSnapshotMemoryBudgetExceededError(
          "session-over-budget",
          1024,
          512,
        ),
      );
    },
    stop() {
      calls.push("stop");
      return Promise.resolve();
    },
  };

  await assertRejects(
    () =>
      runDaemonRuntimeLoop({
        statusStore,
        controlStore,
        ingestionRunners: [ingestionRunner],
        now: () => new Date("2026-02-22T10:00:00.000Z"),
        pid: 4242,
        heartbeatIntervalMs: 50,
        pollIntervalMs: 10,
        operationalLogger,
        auditLogger,
      }),
    SessionSnapshotMemoryBudgetExceededError,
  );

  assertEquals(calls, ["start", "poll", "stop"]);
  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.daemonRunning, false);
  assert(
    sink.records.some((record) =>
      record.event === "daemon.memory_budget.exceeded" &&
      record.channel === "operational"
    ),
  );
  assert(
    sink.records.some((record) =>
      record.event === "daemon.memory_budget.exceeded" &&
      record.channel === "security-audit"
    ),
  );
});

Deno.test("runDaemonRuntimeLoop persists recording state via sessionStateStore", async () => {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const stateDir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "daemon-runtime-persistent-",
  });
  try {
    const statusHistory: DaemonStatusSnapshot[] = [];
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
          ...(currentStatus.sessions
            ? { sessions: [...currentStatus.sessions] }
            : {}),
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
          ...(snapshot.sessions ? { sessions: [...snapshot.sessions] } : {}),
        };
        statusHistory.push(currentStatus);
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-persist-1234",
    });

    const makeLocalEvent = (
      id: string,
      kind: "message.user" | "message.assistant",
      content: string,
      timestamp: string,
    ): ConversationEvent => ({
      eventId: id,
      provider: "codex",
      sessionId: "session-persist",
      timestamp,
      kind,
      role: kind === "message.user" ? "user" : "assistant",
      content,
      source: {
        providerEventType: kind === "message.user" ? "user" : "assistant",
        providerEventId: id,
      },
    } as ConversationEvent);

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        const startCommand = makeLocalEvent(
          "u-start",
          "message.user",
          "::start /tmp/persistent-recording.md",
          "2026-02-22T10:00:00.000Z",
        );
        const assistantMessage = makeLocalEvent(
          "a-1",
          "message.assistant",
          "captured assistant event",
          "2026-02-22T10:00:01.000Z",
        );
        const stopCommand = makeLocalEvent(
          "u-stop",
          "message.user",
          "::stop",
          "2026-02-22T10:00:02.000Z",
        );

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-persist",
            cursor: { kind: "byte-offset", value: 1 },
            events: [startCommand],
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
            sessionId: "session-persist",
            cursor: { kind: "byte-offset", value: 2 },
            events: [startCommand, assistantMessage],
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
            sessionId: "session-persist",
            cursor: { kind: "byte-offset", value: 3 },
            events: [startCommand, assistantMessage, stopCommand],
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
        return Promise.resolve(
          pollCount >= 4 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const appendCalls: number[] = [];
    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      appendToDestination(input) {
        appendCalls.push(input.events.length);
        return Promise.resolve({
          mode: "append",
          outputPath: input.targetPath,
          wrote: true,
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
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(appendCalls, [1]);
    const metadataList = await sessionStateStore.listSessionMetadata();
    assertEquals(metadataList.length, 1);
    const recording = metadataList[0]?.recordings[0];
    assertExists(recording);
    assertEquals(recording?.desiredState, "off");
    assertEquals(recording?.writeCursor, 2);

    const lastStatus = statusHistory[statusHistory.length - 1];
    assertExists(lastStatus);
    const session = lastStatus.sessions?.[0];
    assertExists(session);
    assertEquals(session?.providerSessionId, "session-persist");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop performs session twin cleanup at shutdown", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
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

  const requests = [{
    requestId: "req-stop-cleanup",
    requestedAt: "2026-02-22T10:00:00.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called");
    },
    markProcessed(requestId: string) {
      const idx = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (idx >= 0) {
        requests.splice(0, idx + 1);
      }
      return Promise.resolve();
    },
  };

  const callOrder: string[] = [];
  const sessionStateStore = {
    listSessionMetadata() {
      callOrder.push("list");
      return Promise.resolve([]);
    },
    deleteSessionTwinFiles() {
      callOrder.push("cleanup");
      return Promise.resolve({ deleted: 0, failed: 0 });
    },
  } as unknown as PersistentSessionStateStore;

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionStateStore,
    cleanSessionStatesOnShutdown: true,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assert(callOrder.length > 0);
  assertEquals(callOrder[0], "list");
  assert(callOrder.includes("cleanup"));
});

Deno.test("runDaemonRuntimeLoop maintains independent write cursors for multiple recordings", async () => {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const stateDir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "daemon-runtime-multi-recording-",
  });
  try {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
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
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-multi-rec-1234",
    });

    const mk = (
      id: string,
      kind: "message.user" | "message.assistant",
      content: string,
      timestamp: string,
    ): ConversationEvent => ({
      eventId: id,
      provider: "codex",
      sessionId: "session-multi-rec",
      timestamp,
      kind,
      role: kind === "message.user" ? "user" : "assistant",
      content,
      source: {
        providerEventType: kind === "message.user" ? "user" : "assistant",
        providerEventId: id,
      },
    } as ConversationEvent);

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        const e1 = mk(
          "u-start-a",
          "message.user",
          "::start /tmp/multi-a.md",
          "2026-02-22T10:00:00.000Z",
        );
        const e2 = mk(
          "a-1",
          "message.assistant",
          "first message",
          "2026-02-22T10:00:01.000Z",
        );
        const e3 = mk(
          "u-start-b",
          "message.user",
          "::start /tmp/multi-b.md",
          "2026-02-22T10:00:02.000Z",
        );
        const e4 = mk(
          "a-2",
          "message.assistant",
          "second message",
          "2026-02-22T10:00:03.000Z",
        );

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-multi-rec",
            cursor: { kind: "byte-offset", value: 1 },
            events: [e1, e2],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 2,
          });
        }
        if (pollCount === 2) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-multi-rec",
            cursor: { kind: "byte-offset", value: 2 },
            events: [e1, e2, e3, e4],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:01.000Z",
            sessionsUpdated: 1,
            eventsObserved: 2,
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
      requestId: "req-stop-multi-recording",
      requestedAt: "2026-02-22T10:00:05.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 3 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const appendByDestination = new Map<string, string[]>();
    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      appendToDestination(input) {
        const ids = input.events.map((event) => event.eventId);
        const current = appendByDestination.get(input.targetPath) ?? [];
        appendByDestination.set(input.targetPath, [...current, ...ids]);
        return Promise.resolve({
          mode: "append",
          outputPath: input.targetPath,
          wrote: true,
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
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(
      appendByDestination.get("/tmp/multi-a.md"),
      ["a-1", "u-start-b", "a-2"],
    );
    assertEquals(appendByDestination.get("/tmp/multi-b.md"), ["a-2"]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop applies ambiguous bare ::stop to both id and destination matches", async () => {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const stateDir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "daemon-runtime-ambiguous-stop-",
  });
  try {
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

    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
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
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-ambiguous-stop-1234",
    });
    const metadata = await sessionStateStore.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-ambiguous-stop",
      sourceFilePath: "/tmp/mock-session.jsonl",
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    metadata.recordings = [
      {
        recordingId: "deadbeef-1111-1111-1111-111111111111",
        destination: "deadbeef",
        desiredState: "on",
        writeCursor: 0,
        periods: [{ startedCursor: 0 }],
      },
      {
        recordingId: "deadbeef-2222-2222-2222-222222222222",
        destination: "/tmp/other-destination.md",
        desiredState: "on",
        writeCursor: 0,
        periods: [{ startedCursor: 0 }],
      },
    ];
    await sessionStateStore.saveSessionMetadata(metadata);

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-ambiguous-stop",
            cursor: { kind: "byte-offset", value: 1 },
            events: [{
              eventId: "u-stop-ambiguous",
              provider: "codex",
              sessionId: "session-ambiguous-stop",
              timestamp: "2026-02-22T10:00:00.000Z",
              kind: "message.user",
              role: "user",
              content: "::stop deadbeef",
              source: {
                providerEventType: "user",
                providerEventId: "u-stop-ambiguous",
              },
            } as ConversationEvent],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop-ambiguous-case",
      requestedAt: "2026-02-22T10:00:02.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 2 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
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
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
      operationalLogger,
      auditLogger,
    });

    const after = await sessionStateStore.listSessionMetadata();
    const item = after.find((entry) =>
      entry.providerSessionId === "session-ambiguous-stop"
    );
    assertExists(item);
    assertEquals(
      item!.recordings.map((recording) => recording.desiredState),
      ["off", "off"],
    );
    assert(
      sink.records.some((record) =>
        record.event === "recording.command.stop.ambiguous" &&
        record.channel === "operational"
      ),
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop uses default destination for empty ::start", async () => {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const stateDir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "daemon-runtime-default-destination-",
  });
  try {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
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
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "defaultdest-session-abcdef12",
    });

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-default-destination",
            cursor: { kind: "byte-offset", value: 1 },
            events: [{
              eventId: "u-start-default",
              provider: "codex",
              sessionId: "session-default-destination",
              timestamp: "2026-02-22T10:00:00.000Z",
              kind: "message.user",
              role: "user",
              content: "::start",
              source: {
                providerEventType: "user",
                providerEventId: "u-start-default",
              },
            } as ConversationEvent, {
              eventId: "a-default-1",
              provider: "codex",
              sessionId: "session-default-destination",
              timestamp: "2026-02-22T10:00:01.000Z",
              kind: "message.assistant",
              role: "assistant",
              content: "assistant output",
              source: {
                providerEventType: "assistant",
                providerEventId: "a-default-1",
              },
            } as ConversationEvent],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 2,
          });
        }
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop-default-destination",
      requestedAt: "2026-02-22T10:00:02.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 2 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      appendToDestination() {
        return Promise.resolve({
          mode: "append",
          outputPath: "/tmp/default-path.md",
          wrote: true,
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
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    const metadata = await sessionStateStore.listSessionMetadata();
    const session = metadata.find((entry) =>
      entry.providerSessionId === "session-default-destination"
    );
    assertExists(session);
    const recording = session!.recordings[0];
    assertExists(recording);
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    const expectedRoot = home
      ? join(home, ".kato", "recordings")
      : join(".kato", "recordings");
    assert(
      recording!.destination.startsWith(expectedRoot),
      `expected recording destination to start with ${expectedRoot}, got ${
        recording!.destination
      }`,
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop initializes missing session metadata from default cursor", async () => {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const stateDir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "daemon-runtime-default-cursor-",
  });
  try {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
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

    let pollCount = 0;
    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-default-cursor-1234",
    });
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-default-cursor",
            cursor: { kind: "byte-offset", value: 42 },
            events: [makeEvent("a1", "message.assistant", "assistant-1")],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop-default-cursor",
      requestedAt: "2026-02-22T10:00:02.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 2 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const recordingPipeline: RecordingPipelineLike = {
      startOrRotateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
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
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    const metadata = await sessionStateStore.listSessionMetadata();
    const session = metadata.find((entry) =>
      entry.providerSessionId === "session-default-cursor"
    );
    assertExists(session);
    assertEquals(session!.ingestCursor, { kind: "byte-offset", value: 0 });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
