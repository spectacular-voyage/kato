import { assertEquals } from "@std/assert";
import type {
  ConversationEvent,
  DaemonStatusSnapshot,
  SessionMetadataV1,
} from "@kato/shared";
import {
  createDefaultUserConfig,
  type DaemonControlRequest,
  type DaemonControlRequestDraft,
  type LogRecord,
  type PersistentSessionStateStore,
  type RecordingPipelineLike,
  runDaemonRuntimeLoop,
  type RuntimeSessionSnapshot,
  StructuredLogger,
  type WorkspaceCatalogLike,
  type WorkspaceProfileResolverLike,
} from "../apps/daemon/src/mod.ts";
import {
  resolveWorkspaceOutputWriteStart,
  setWorkspaceOutputWritePosition,
  type WorkspaceOutputState,
} from "../apps/daemon/src/orchestrator/runtime_workspace_output_state.ts";
import { resolveTestTempPath } from "./test_temp.ts";

const WORKSPACE_ROOT = resolveTestTempPath("write-position", "workspace");
const OUTPUT_PATH = resolveTestTempPath("write-position", "output.md");

function event(
  id: string,
  offset: number | undefined,
  timestamp = "2026-11-08T12:00:00.000Z",
): ConversationEvent {
  return {
    eventId: id,
    provider: "claude",
    sessionId: "sess-1",
    timestamp,
    kind: "message.assistant",
    role: "assistant",
    content: id,
    source: {
      providerEventType: "assistant",
      providerEventId: id,
      ...(offset !== undefined
        ? { rawCursor: { kind: "byte-offset" as const, value: offset } }
        : {}),
    },
  } as unknown as ConversationEvent;
}

function makeOutput(
  overrides: Partial<WorkspaceOutputState> = {},
): WorkspaceOutputState {
  return {
    workspaceId: "workspace-1",
    workspaceAliasSnapshot: "proj",
    desiredState: "on",
    currentDestination: {
      kind: "absolute-explicit",
      absolutePath: OUTPUT_PATH,
    },
    currentResolvedPath: OUTPUT_PATH,
    workspaceRootSnapshot: WORKSPACE_ROOT,
    resolvedDefaultOutputDir: WORKSPACE_ROOT,
    filenameTemplate: "{provider}.md",
    writerFeatureFlags: {
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
      writerIncludeToolCalls: true,
      writerIncludeToolResults: false,
      writerIncludeDecisionPrompt: true,
      writerIncludeDecisionOptions: true,
      writerIncludeDecisionSelection: true,
      writerItalicizeUserMessages: false,
    },
    activeRecordingCycleId: "cycle-1",
    writeCursor: 0,
    createdAt: "2026-11-08T11:00:00.000Z",
    recordingCycles: [{
      recordingCycleId: "cycle-1",
      startedCursor: 0,
      startedAt: "2026-11-08T11:00:00.000Z",
      lastWriteAt: "2026-11-08T11:00:00.000Z",
    }],
    ...overrides,
  } as WorkspaceOutputState;
}

Deno.test("resolveWorkspaceOutputWriteStart resumes after the written source position", () => {
  const output = makeOutput({
    writeCursor: 3,
    writeSourceCursor: { kind: "byte-offset", value: 30 },
  });
  // Same snapshot: nothing pending.
  const same = [event("e1", 10), event("e2", 20), event("e3", 30)];
  assertEquals(resolveWorkspaceOutputWriteStart(output, same), 3);
  // Retention window shifted (length unchanged): only the new event.
  const shifted = [event("e2", 20), event("e3", 30), event("e4", 40)];
  assertEquals(resolveWorkspaceOutputWriteStart(output, shifted), 2);
  // Snapshot rebuilt after a restart from newer content only.
  const rebuilt = [event("e5", 50), event("e6", 60)];
  assertEquals(resolveWorkspaceOutputWriteStart(output, rebuilt), 0);
  // Events without positional cursors fall back to the stored index.
  const opaque = [event("x1", undefined), event("x2", undefined)];
  assertEquals(resolveWorkspaceOutputWriteStart(output, opaque), 2);
});

Deno.test("resolveWorkspaceOutputWriteStart migrates older outputs by last write time", () => {
  const lastWriteAt = "2026-11-08T12:00:00.000Z";
  const legacy = makeOutput({
    writeCursor: 10000,
    recordingCycles: [{
      recordingCycleId: "cycle-1",
      startedCursor: 0,
      startedAt: "2026-11-08T11:00:00.000Z",
      lastWriteAt,
    }],
  });
  const events = [
    event("old-1", 10, "2026-11-08T11:59:00.000Z"),
    event("old-2", 20, "2026-11-08T12:00:00.000Z"),
    event("new-1", 30, "2026-11-08T12:00:01.000Z"),
    event("new-2", 40, "2026-11-08T12:05:00.000Z"),
  ];
  assertEquals(resolveWorkspaceOutputWriteStart(legacy, events), 2);
  // Everything timestamped is older than the last write: nothing pending,
  // even though the stale index would have pointed into the snapshot.
  const legacyMidIndex = makeOutput({
    writeCursor: 1,
    recordingCycles: legacy.recordingCycles,
  });
  assertEquals(
    resolveWorkspaceOutputWriteStart(legacyMidIndex, events.slice(0, 2)),
    2,
  );
  // writeCursor 0 (e.g. auto-record) means nothing was written: all pending.
  const fresh = makeOutput({
    writeCursor: 0,
    recordingCycles: [{
      recordingCycleId: "cycle-1",
      startedCursor: 0,
      startedAt: "2026-11-08T13:00:00.000Z",
      lastWriteAt: "2026-11-08T13:00:00.000Z",
    }],
  });
  assertEquals(resolveWorkspaceOutputWriteStart(fresh, events), 0);
});

Deno.test("setWorkspaceOutputWritePosition anchors to the last positional event written", () => {
  const output = makeOutput();
  const events = [event("e1", 10), event("e2", 20), event("x", undefined)];
  setWorkspaceOutputWritePosition(output, events, 3);
  assertEquals(output.writeCursor, 3);
  assertEquals(output.writeSourceCursor, { kind: "byte-offset", value: 20 });
  setWorkspaceOutputWritePosition(output, events, 1);
  assertEquals(output.writeSourceCursor, { kind: "byte-offset", value: 10 });
  setWorkspaceOutputWritePosition(output, events, 0);
  assertEquals(output.writeCursor, 0);
  assertEquals(output.writeSourceCursor, undefined);
});

function makeMetadata(): SessionMetadataV1 {
  return {
    schemaVersion: 1,
    sessionKey: "claude:sess-1",
    provider: "claude",
    providerSessionId: "sess-1",
    sessionId: "kato-sess-1",
    createdAt: "2026-11-08T11:00:00.000Z",
    updatedAt: "2026-11-08T11:00:00.000Z",
    sourceFilePath: resolveTestTempPath("write-position", "sess-1.jsonl"),
    ingestCursor: { kind: "byte-offset", value: 0 },
    twinPath: resolveTestTempPath("write-position", "sess-1.twin.jsonl"),
    nextTwinSeq: 1,
    recentFingerprints: [],
    commandCursor: 1,
    workspaceOutputs: [makeOutput()],
  };
}

interface Phase {
  events: ConversationEvent[];
  truncatedEvents?: number;
}

/**
 * Runs the real daemon loop once per phase; each phase is that iteration's
 * view of the in-memory snapshot. Returns what was appended per write.
 */
async function runRecordingPhases(
  phases: Phase[],
  initialMetadata: SessionMetadataV1 = makeMetadata(),
): Promise<{
  appended: string[][];
  metadata: SessionMetadataV1;
  logs: LogRecord[];
}> {
  let phase = 0;
  const snapshotFor = (): RuntimeSessionSnapshot => ({
    provider: "claude",
    sessionId: "sess-1",
    cursor: { kind: "byte-offset", value: 0 },
    events: phases[phase]!.events,
    conversationSchemaVersion: 2,
    metadata: {
      updatedAt: "2026-11-08T12:00:00.000Z",
      eventCount: phases[phase]!.events.length,
      truncatedEvents: phases[phase]!.truncatedEvents ?? 0,
      fileModifiedAtMs: phase + 1,
    },
  });

  let metadata = structuredClone(initialMetadata);
  const appended: string[][] = [];
  const logs: LogRecord[] = [];

  const controlStore = {
    list() {
      phase += 1;
      if (phase < phases.length) {
        return Promise.resolve([] as DaemonControlRequest[]);
      }
      phase = phases.length - 1;
      return Promise.resolve([{
        requestId: "req-stop",
        requestedAt: "2026-11-08T12:00:00.000Z",
        command: "stop" as const,
      }]);
    },
    enqueue(_draft: DaemonControlRequestDraft) {
      return Promise.reject(new Error("enqueue should not be called"));
    },
    markProcessed() {
      return Promise.resolve();
    },
  };

  let status: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-11-08T12:00:00.000Z",
    heartbeatAt: "2026-11-08T12:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
  };
  const statusStore = {
    load: () => Promise.resolve(structuredClone(status)),
    save(next: DaemonStatusSnapshot) {
      status = structuredClone(next);
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = {
    upsert() {
      throw new Error("upsert should not be called");
    },
    get: (sessionId: string) =>
      sessionId === "sess-1" ? snapshotFor() : undefined,
    list: () => [snapshotFor()],
  };

  const sessionStateStore = {
    listSessionMetadata: () => Promise.resolve([structuredClone(metadata)]),
    listSessionMetadataForKeys(keys: Iterable<string>) {
      const wanted = new Set(keys);
      return Promise.resolve(
        wanted.has(metadata.sessionKey) ? [structuredClone(metadata)] : [],
      );
    },
    getOrCreateSessionMetadata: () =>
      Promise.resolve(structuredClone(metadata)),
    saveSessionMetadata(next: SessionMetadataV1) {
      metadata = structuredClone(next);
      return Promise.resolve();
    },
    deleteSessionTwinFiles: () => Promise.resolve({ deleted: 0, failed: 0 }),
  };

  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      throw new Error("activateRecording should not be called");
    },
    captureSnapshot() {
      throw new Error("captureSnapshot should not be called");
    },
    exportSnapshot() {
      throw new Error("exportSnapshot should not be called");
    },
    appendToActiveRecording: () =>
      Promise.resolve({ appended: false, deduped: false }),
    appendToDestination(input) {
      appended.push(
        input.events.map((entry) => (entry as { content: string }).content),
      );
      return Promise.resolve({
        mode: "append",
        outputPath: input.targetPath,
        wrote: true,
        deduped: false,
      });
    },
    stopRecording: () => false,
    getActiveRecording: () => undefined,
    listActiveRecordings: () => [],
    getRecordingSummary: () => ({ activeRecordings: 0, destinations: 0 }),
  };

  const workspaceCatalog: WorkspaceCatalogLike = {
    getByAlias: () => Promise.resolve(undefined),
    getByWorkspaceId: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    refreshIfChanged: () => Promise.resolve(),
  };
  const workspaceProfileResolver: WorkspaceProfileResolverLike = {
    resolveForCommand: () => Promise.reject(new Error("not used")),
  };

  await runDaemonRuntimeLoop({
    now: () => new Date("2026-11-08T12:00:00.000Z"),
    heartbeatIntervalMs: 60_000,
    pollIntervalMs: 0,
    statusStore,
    controlStore,
    recordingPipeline,
    sessionSnapshotStore,
    sessionStateStore:
      sessionStateStore as unknown as PersistentSessionStateStore,
    workspaceCatalog,
    workspaceProfileResolver,
    operationalLogger: new StructuredLogger([{
      write: (record: LogRecord) => {
        logs.push(record);
      },
    }], { channel: "operational", minLevel: "debug" }),
    userConfig: createDefaultUserConfig({
      defaultUsername: "",
      workspaceUsernames: {},
      excludeMeFromParticipantList: false,
    }),
    daemonFeatureFlags: {
      daemonExportEnabled: true,
      captureIncludeSystemEvents: false,
    },
  });
  return { appended, metadata, logs };
}

Deno.test("persistent recording pass keeps appending across snapshot truncation and restart rebuilds", async () => {
  const { appended, metadata, logs } = await runRecordingPhases([
    { events: [event("e1", 10), event("e2", 20), event("e3", 30)] },
    // Retention dropped e1 as e4 arrived: same length as before.
    {
      events: [event("e2", 20), event("e3", 30), event("e4", 40)],
      truncatedEvents: 1,
    },
    // Daemon restarted: snapshot rebuilt from content after the cursor only.
    { events: [event("e5", 50)] },
    { events: [event("e5", 50), event("e6", 60)] },
  ]);

  assertEquals(appended, [["e1", "e2", "e3"], ["e4"], ["e5"], ["e6"]]);
  assertEquals(metadata.workspaceOutputs?.[0]?.writeSourceCursor, {
    kind: "byte-offset",
    value: 60,
  });
  assertEquals(
    logs.filter((record) => record.event === "recording.append.gap").length,
    0,
  );
});

Deno.test("persistent recording pass logs a gap when retention dropped unwritten events", async () => {
  const { appended, logs } = await runRecordingPhases([
    { events: [event("e1", 10)] },
    // e2..e4 arrived and e2 fell out of the retained window before any write.
    {
      events: [event("e3", 30), event("e4", 40)],
      truncatedEvents: 2,
    },
  ]);
  assertEquals(appended, [["e1"], ["e3", "e4"]]);
  const gaps = logs.filter((record) => record.event === "recording.append.gap");
  assertEquals(gaps.length, 1);
  assertEquals(gaps[0]!.attributes?.["writeSourceCursor"], 10);
});

Deno.test("persistent recording pass migrates an older output by last write time", async () => {
  const metadata = makeMetadata();
  metadata.workspaceOutputs = [makeOutput({
    writeCursor: 10000,
    recordingCycles: [{
      recordingCycleId: "cycle-1",
      startedCursor: 0,
      startedAt: "2026-11-08T11:00:00.000Z",
      lastWriteAt: "2026-11-08T12:00:00.000Z",
    }],
  })];
  const { appended, metadata: saved } = await runRecordingPhases([
    {
      events: [
        event("written", 10, "2026-11-08T11:59:59.000Z"),
        event("missed", 20, "2026-11-08T12:00:05.000Z"),
      ],
    },
    {
      events: [
        event("written", 10, "2026-11-08T11:59:59.000Z"),
        event("missed", 20, "2026-11-08T12:00:05.000Z"),
        event("next", 30, "2026-11-08T12:01:00.000Z"),
      ],
    },
  ], metadata);
  assertEquals(appended, [["missed"], ["next"]]);
  assertEquals(saved.workspaceOutputs?.[0]?.writeSourceCursor, {
    kind: "byte-offset",
    value: 30,
  });
});
