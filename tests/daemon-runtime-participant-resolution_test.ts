import { assertEquals } from "@std/assert";
import type {
  ConversationEvent,
  DaemonStatusSnapshot,
  SessionMetadataV1,
  UserConfig,
} from "@kato/shared";
import {
  createDefaultUserConfig,
  type DaemonControlRequest,
  type DaemonControlRequestDraft,
  type PersistentSessionStateStore,
  type RecordingPipelineLike,
  runDaemonRuntimeLoop,
  type RuntimeSessionSnapshot,
  type WorkspaceCatalogLike,
  type WorkspaceProfileResolverLike,
} from "../apps/daemon/src/mod.ts";

function makeAssistantEvent(sessionId: string): ConversationEvent {
  return {
    eventId: "evt-1",
    provider: "codex",
    sessionId,
    timestamp: "2026-03-03T10:00:00.000Z",
    kind: "message.assistant",
    role: "assistant",
    content: "hello",
    source: {
      providerEventType: "assistant",
      providerEventId: "evt-1",
    },
  } as unknown as ConversationEvent;
}

function makeSnapshot(sessionId: string): RuntimeSessionSnapshot {
  return {
    provider: "codex",
    sessionId,
    cursor: { kind: "opaque", value: "cursor-1" },
    events: [makeAssistantEvent(sessionId)],
    conversationSchemaVersion: 2,
    metadata: {
      updatedAt: "2026-03-03T10:00:00.000Z",
      eventCount: 1,
      truncatedEvents: 0,
      lastEventAt: "2026-03-03T10:00:00.000Z",
      fileModifiedAtMs: 1,
      snippet: "hello",
    },
  };
}

function makeMetadata(sessionId: string): SessionMetadataV1 {
  return {
    schemaVersion: 1,
    sessionKey: `codex:${sessionId}`,
    provider: "codex",
    providerSessionId: sessionId,
    sessionId: "session-short-1",
    createdAt: "2026-03-03T10:00:00.000Z",
    updatedAt: "2026-03-03T10:00:00.000Z",
    sourceFilePath: "/tmp/session.jsonl",
    ingestCursor: { kind: "opaque", value: "cursor-1" },
    twinPath: "/tmp/session.twin.jsonl",
    nextTwinSeq: 1,
    recentFingerprints: [],
    commandCursor: 1,
    workspaceOutputs: [
      {
        workspaceId: "workspace-1",
        workspaceAliasSnapshot: "My.Proj",
        desiredState: "on",
        currentDestination: {
          kind: "absolute-explicit",
          absolutePath: "/tmp/workspace-output.md",
        },
        currentResolvedPath: "/tmp/workspace-output.md",
        workspaceRootSnapshot: "/tmp/workspace",
        resolvedDefaultOutputDir: "/tmp/workspace/notes",
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
        createdAt: "2026-03-03T10:00:00.000Z",
        recordingCycles: [],
      },
    ],
  };
}

async function runWorkspaceResolutionScenario(
  userConfig: UserConfig,
): Promise<string | undefined> {
  const providerSessionId = "provider-session-1";
  const snapshot = makeSnapshot(providerSessionId);
  let metadata = makeMetadata(providerSessionId);

  let processedStop = false;
  const controlStore = {
    list() {
      if (processedStop) {
        return Promise.resolve([] as DaemonControlRequest[]);
      }
      return Promise.resolve([
        {
          requestId: "req-stop-1",
          requestedAt: "2026-03-03T10:00:00.000Z",
          command: "stop" as const,
        },
      ]);
    },
    enqueue(_draft: DaemonControlRequestDraft) {
      return Promise.reject(new Error("enqueue should not be called"));
    },
    markProcessed() {
      processedStop = true;
      return Promise.resolve();
    },
  };

  let status: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-03-03T10:00:00.000Z",
    heartbeatAt: "2026-03-03T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
  };
  const statusStore = {
    load() {
      return Promise.resolve({
        ...status,
        providers: [...status.providers],
        recordings: { ...status.recordings },
      });
    },
    save(next: DaemonStatusSnapshot) {
      status = {
        ...next,
        providers: [...next.providers],
        recordings: { ...next.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = {
    upsert() {
      throw new Error("upsert should not be called");
    },
    get(sessionId: string) {
      return sessionId === providerSessionId ? snapshot : undefined;
    },
    list() {
      return [snapshot];
    },
  };

  const sessionStateStore = {
    listSessionMetadata() {
      return Promise.resolve([metadata]);
    },
    getOrCreateSessionMetadata() {
      return Promise.resolve(metadata);
    },
    saveSessionMetadata(next: SessionMetadataV1) {
      metadata = {
        ...next,
        workspaceOutputs: next.workspaceOutputs?.map((output) => ({
          ...output,
          currentDestination: { ...output.currentDestination },
          writerFeatureFlags: { ...output.writerFeatureFlags },
          recordingCycles: output.recordingCycles.map((cycle) => ({
            ...cycle,
          })),
        })),
      };
      return Promise.resolve();
    },
    deleteSessionTwinFiles() {
      return Promise.resolve({ deleted: 0, failed: 0 });
    },
  };

  const capturedParticipantUsernames: Array<string | undefined> = [];
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
    appendToActiveRecording() {
      return Promise.resolve({ appended: false, deduped: false });
    },
    appendToDestination(input) {
      capturedParticipantUsernames.push(
        input.outputOverrides?.participantUsername,
      );
      return Promise.resolve({
        mode: "append",
        outputPath: input.targetPath,
        wrote: true,
        deduped: false,
      });
    },
    stopRecording() {
      return false;
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

  const workspaceCatalog: WorkspaceCatalogLike = {
    getByAlias() {
      return Promise.resolve(undefined);
    },
    getByWorkspaceId(workspaceId: string) {
      if (workspaceId !== "workspace-1") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        workspaceId: "workspace-1",
        alias: "My.Proj",
        workspaceRoot: "/tmp/workspace",
        configPath: "/tmp/workspace/kato-workspace-config.yaml",
        registeredAt: "2026-03-03T10:00:00.000Z",
      });
    },
    list() {
      return Promise.resolve([]);
    },
    refreshIfChanged() {
      return Promise.resolve();
    },
  };

  const workspaceProfileResolver: WorkspaceProfileResolverLike = {
    resolveForCommand() {
      return Promise.resolve({
        workspaceId: "workspace-1",
        alias: "My.Proj",
        workspaceRoot: "/tmp/workspace",
        configPath: "/tmp/workspace/kato-workspace-config.yaml",
        resolvedDefaultOutputDir: "/tmp/workspace/notes",
        filenameTemplate: "{provider}.md",
        workspaceTimezone: "local",
        markdownFrontmatter: {
          includeFrontmatterInMarkdownRecordings: true,
          includeUpdatedInFrontmatter: false,
          addParticipantUsernameToFrontmatter: true,
          includeSessionIds: true,
          includeWorkspaceIds: true,
          includeRecordingIds: true,
          includeConversationEventKinds: false,
        },
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
      });
    },
  };

  await runDaemonRuntimeLoop({
    now: () => new Date("2026-03-03T10:00:00.000Z"),
    heartbeatIntervalMs: 10,
    pollIntervalMs: 0,
    sessionMetadataRefreshIntervalMs: 10,
    statusStore,
    controlStore,
    recordingPipeline,
    sessionSnapshotStore,
    sessionStateStore:
      sessionStateStore as unknown as PersistentSessionStateStore,
    workspaceCatalog,
    workspaceProfileResolver,
    userConfig,
    daemonFeatureFlags: {
      daemonExportEnabled: true,
      captureIncludeSystemEvents: false,
    },
  });

  return capturedParticipantUsernames[0];
}

Deno.test("runDaemonRuntimeLoop persistent workspace append uses workspaceId username mapping", async () => {
  const participantUsername = await runWorkspaceResolutionScenario(
    createDefaultUserConfig({
      defaultUsername: "Default.User",
      workspaceUsernames: {
        "workspace-1": "Workspace.User",
      },
      excludeMeFromParticipantList: false,
    }),
  );

  assertEquals(participantUsername, "Workspace.User");
});

Deno.test("runDaemonRuntimeLoop persistent workspace append omits participant when no explicit username exists", async () => {
  const participantUsername = await runWorkspaceResolutionScenario(
    createDefaultUserConfig({
      defaultUsername: "",
      workspaceUsernames: {},
      excludeMeFromParticipantList: false,
    }),
  );

  assertEquals(participantUsername, undefined);
});
