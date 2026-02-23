import { assertEquals, assertExists } from "@std/assert";
import type { DaemonStatusSnapshot, Message } from "@kato/shared";
import {
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  type RecordingPipelineLike,
  runDaemonRuntimeLoop,
} from "../apps/daemon/src/mod.ts";

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
