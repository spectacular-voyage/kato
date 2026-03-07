import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import {
  AuditLogger,
  type LogRecord,
  PersistentSessionStateStore,
  type RecordingPipelineLike,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";
import { handleExportControlRequest } from "../apps/daemon/src/orchestrator/runtime_export_request.ts";
import { makeTestTempDir } from "./test_temp.ts";

class CaptureSink {
  records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

function makeDebugLoggers(nowIso = "2026-02-22T10:00:00.000Z"): {
  sink: CaptureSink;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
} {
  const sink = new CaptureSink();
  return {
    sink,
    operationalLogger: new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date(nowIso),
    }),
    auditLogger: new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date(nowIso),
      }),
    ),
  };
}

function makeAssistantEvent(
  id: string,
  content: string,
  timestamp = "2026-02-22T10:00:00.000Z",
): ConversationEvent {
  return {
    eventId: id,
    provider: "codex",
    sessionId: "provider-session-42",
    timestamp,
    kind: "message.assistant",
    role: "assistant",
    content,
    source: {
      providerEventType: "assistant",
      providerEventId: id,
    },
  } as ConversationEvent;
}

function makeRecordingPipeline(
  exported: Array<{
    provider: string;
    sessionId: string;
    targetPath: string;
    format?: "markdown" | "jsonl";
    title: string;
    outputOverrides?: unknown;
  }>,
): RecordingPipelineLike {
  return {
    activateRecording() {
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
        ...(input.format ? { format: input.format } : {}),
        title: input.title ?? "",
        ...(input.outputOverrides
          ? { outputOverrides: input.outputOverrides }
          : {}),
      });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: input.format ?? "markdown",
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
      return { activeRecordings: 0, destinations: 0 };
    },
  };
}

async function createSessionStateStore(
  root: string,
  entries: Array<{
    provider: string;
    providerSessionId: string;
    sessionId: string;
    sourceFilePath: string;
  }>,
): Promise<PersistentSessionStateStore> {
  const pendingSessionIds = entries.map((entry) => entry.sessionId);
  const store = new PersistentSessionStateStore({
    katoDir: join(root, ".kato"),
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    makeSessionId: () => {
      const next = pendingSessionIds.shift();
      if (!next) {
        throw new Error("unexpected session id request");
      }
      return next;
    },
  });

  for (const entry of entries) {
    await store.getOrCreateSessionMetadata({
      provider: entry.provider,
      providerSessionId: entry.providerSessionId,
      sourceFilePath: entry.sourceFilePath,
      initialCursor: { kind: "byte-offset", value: 0 },
    });
  }

  return store;
}

async function readExportsLog(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const text = await Deno.readTextFile(path);
  return text.trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
}

Deno.test("handleExportControlRequest resolves short selectors, uses snapshot provider, and merges output overrides", async () => {
  const tempDir = await makeTestTempDir("daemon-export-request-success-");

  try {
    const exportsLogPath = join(tempDir, "exports.jsonl");
    const sessionStateStore = await createSessionStateStore(tempDir, [{
      provider: "codex",
      providerSessionId: "provider-session-42",
      sessionId: "2ee6e8b4-1111-2222-3333-444444444444",
      sourceFilePath: join(tempDir, "provider-session-42.jsonl"),
    }]);
    const exported: Array<{
      provider: string;
      sessionId: string;
      targetPath: string;
      format?: "markdown" | "jsonl";
      title: string;
      outputOverrides?: unknown;
    }> = [];
    const loadedSessions: string[] = [];
    const { sink, operationalLogger, auditLogger } = makeDebugLoggers();

    await handleExportControlRequest({
      request: {
        requestId: "req-export-short",
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: "export",
        payload: {
          sessionId: "codex/2ee6e8b4",
          resolvedOutputPath: join(tempDir, "session-short.jsonl"),
          format: "jsonl",
          resolvedExportMarkdownFrontmatter: {
            includeFrontmatterInMarkdownRecordings: false,
            includeSessionIds: true,
          },
          resolvedExportFeatureFlags: {
            writerIncludeCommentary: false,
            writerIncludeThinking: true,
          },
          resolvedExportTimezone: "America/New_York",
        },
      },
      recordingPipeline: makeRecordingPipeline(exported),
      sessionStateStore,
      loadSessionSnapshot(sessionId: string) {
        loadedSessions.push(sessionId);
        return Promise.resolve({
          provider: "codex",
          events: [makeAssistantEvent("m1", "export me")],
        });
      },
      exportEnabled: true,
      defaultCliExportOutputOverrides: {
        includeFrontmatter: true,
        renderOptions: {
          includeThinking: false,
          includeToolCalls: true,
        },
      },
      exportsLogPath,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      operationalLogger,
      auditLogger,
      resolveTitle(_events, requestedSessionId) {
        return `title:${requestedSessionId}`;
      },
    });

    assertEquals(loadedSessions, ["provider-session-42"]);
    assertEquals(exported, [{
      provider: "codex",
      sessionId: "codex/2ee6e8b4",
      targetPath: join(tempDir, "session-short.jsonl"),
      format: "jsonl",
      title: "title:codex/2ee6e8b4",
      outputOverrides: {
        includeFrontmatter: false,
        includeSessionIds: true,
        renderOptions: {
          includeThinking: true,
          includeToolCalls: true,
          includeCommentary: false,
          headingTimestampTimezone: "America/New_York",
        },
      },
    }]);

    const history = await readExportsLog(exportsLogPath);
    assertEquals(history.length, 1);
    assertEquals(history[0]?.status, "succeeded");
    assertEquals(history[0]?.provider, "codex");
    assertEquals(history[0]?.matchedBy, "session_id_prefix");
    assertEquals(
      sink.records.some((record) =>
        record.level === "warn" || record.level === "error"
      ),
      false,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("handleExportControlRequest skips ambiguous short selectors and records failure", async () => {
  const tempDir = await makeTestTempDir("daemon-export-request-ambiguous-");

  try {
    const exportsLogPath = join(tempDir, "exports.jsonl");
    const sessionStateStore = await createSessionStateStore(tempDir, [{
      provider: "codex",
      providerSessionId: "provider-session-a",
      sessionId: "2ee6e8b4-1111-2222-3333-444444444444",
      sourceFilePath: join(tempDir, "provider-session-a.jsonl"),
    }, {
      provider: "codex",
      providerSessionId: "provider-session-b",
      sessionId: "2ee6e8b4-9999-8888-7777-666666666666",
      sourceFilePath: join(tempDir, "provider-session-b.jsonl"),
    }]);
    const exported: Array<{ sessionId: string }> = [];
    const { sink, operationalLogger, auditLogger } = makeDebugLoggers();

    await handleExportControlRequest({
      request: {
        requestId: "req-export-ambiguous",
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: "export",
        payload: {
          sessionId: "2ee6e8b4",
          resolvedOutputPath: join(tempDir, "ambiguous.md"),
        },
      },
      recordingPipeline: makeRecordingPipeline(
        exported as Array<{
          provider: string;
          sessionId: string;
          targetPath: string;
          title: string;
          format?: "markdown" | "jsonl";
          outputOverrides?: unknown;
        }>,
      ),
      sessionStateStore,
      loadSessionSnapshot() {
        throw new Error("loadSessionSnapshot should not be called");
      },
      exportEnabled: true,
      exportsLogPath,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      operationalLogger,
      auditLogger,
      resolveTitle() {
        return "unused";
      },
    });

    assertEquals(exported.length, 0);
    const history = await readExportsLog(exportsLogPath);
    assertEquals(history.length, 1);
    assertEquals(history[0]?.status, "failed");
    assertEquals(history[0]?.reason, "session_selector_ambiguous");
    assertEquals(history[0]?.matchedBy, "session_id_prefix");
    assertEquals(
      sink.records.some((record) =>
        record.event === "daemon.control.export.session_ambiguous" &&
        record.channel === "operational"
      ),
      true,
    );
    assertEquals(
      sink.records.some((record) =>
        record.event === "daemon.control.export.session_ambiguous" &&
        record.channel === "security-audit"
      ),
      true,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("handleExportControlRequest skips missing session snapshots and records failure", async () => {
  const tempDir = await makeTestTempDir("daemon-export-request-missing-");

  try {
    const exportsLogPath = join(tempDir, "exports.jsonl");
    const exported: Array<{
      provider: string;
      sessionId: string;
      targetPath: string;
      title: string;
      format?: "markdown" | "jsonl";
      outputOverrides?: unknown;
    }> = [];
    const { sink, operationalLogger, auditLogger } = makeDebugLoggers();

    await handleExportControlRequest({
      request: {
        requestId: "req-export-missing",
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: "export",
        payload: {
          sessionId: "missing-session",
          resolvedOutputPath: join(tempDir, "missing.md"),
        },
      },
      recordingPipeline: makeRecordingPipeline(exported),
      loadSessionSnapshot() {
        return Promise.resolve(undefined);
      },
      exportEnabled: true,
      exportsLogPath,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      operationalLogger,
      auditLogger,
      resolveTitle() {
        return "unused";
      },
    });

    assertEquals(exported.length, 0);
    const history = await readExportsLog(exportsLogPath);
    assertEquals(history.length, 1);
    assertEquals(history[0]?.status, "failed");
    assertEquals(history[0]?.reason, "session_snapshot_not_found");
    assertEquals(
      sink.records.some((record) =>
        record.event === "daemon.control.export.session_missing" &&
        record.channel === "operational"
      ),
      true,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("handleExportControlRequest skips empty session snapshots and records failure", async () => {
  const tempDir = await makeTestTempDir("daemon-export-request-empty-");

  try {
    const exportsLogPath = join(tempDir, "exports.jsonl");
    const exported: Array<{
      provider: string;
      sessionId: string;
      targetPath: string;
      title: string;
      format?: "markdown" | "jsonl";
      outputOverrides?: unknown;
    }> = [];
    const { sink, operationalLogger, auditLogger } = makeDebugLoggers();

    await handleExportControlRequest({
      request: {
        requestId: "req-export-empty",
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: "export",
        payload: {
          sessionId: "empty-session",
          resolvedOutputPath: join(tempDir, "empty.md"),
        },
      },
      recordingPipeline: makeRecordingPipeline(exported),
      loadSessionSnapshot() {
        return Promise.resolve({
          provider: "codex",
          events: [],
        });
      },
      exportEnabled: true,
      exportsLogPath,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      operationalLogger,
      auditLogger,
      resolveTitle() {
        return "unused";
      },
    });

    assertEquals(exported.length, 0);
    const history = await readExportsLog(exportsLogPath);
    assertEquals(history.length, 1);
    assertEquals(history[0]?.status, "failed");
    assertEquals(history[0]?.reason, "session_snapshot_empty");
    assertEquals(
      sink.records.some((record) =>
        record.event === "daemon.control.export.empty" &&
        record.channel === "operational"
      ),
      true,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("handleExportControlRequest skips disabled exports and records failure", async () => {
  const tempDir = await makeTestTempDir("daemon-export-request-disabled-");

  try {
    const exportsLogPath = join(tempDir, "exports.jsonl");
    const exported: Array<{
      provider: string;
      sessionId: string;
      targetPath: string;
      title: string;
      format?: "markdown" | "jsonl";
      outputOverrides?: unknown;
    }> = [];
    const { sink, operationalLogger, auditLogger } = makeDebugLoggers();

    await handleExportControlRequest({
      request: {
        requestId: "req-export-disabled",
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: "export",
        payload: {
          sessionId: "session-42",
          resolvedOutputPath: join(tempDir, "disabled.md"),
        },
      },
      recordingPipeline: makeRecordingPipeline(exported),
      exportEnabled: false,
      exportsLogPath,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      operationalLogger,
      auditLogger,
      resolveTitle() {
        return "unused";
      },
    });

    assertEquals(exported.length, 0);
    const history = await readExportsLog(exportsLogPath);
    assertEquals(history.length, 1);
    assertEquals(history[0]?.status, "failed");
    assertEquals(history[0]?.reason, "export_disabled");
    const disabledRecord = sink.records.find((record) =>
      record.event === "daemon.control.export.disabled"
    );
    assertExists(disabledRecord);
    assertEquals(disabledRecord.channel, "operational");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
