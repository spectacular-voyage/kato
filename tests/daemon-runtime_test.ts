import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type {
  ConversationEvent,
  DaemonStatusSnapshot,
  SessionMetadataV1,
} from "@kato/shared";
import {
  AuditLogger,
  createDefaultWorkspaceMarkdownFrontmatterConfig,
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  InMemorySessionSnapshotStore,
  type LogRecord,
  mapConversationEventsToTwin,
  PersistentSessionStateStore,
  type ProviderIngestionRunner,
  RecordingPipeline,
  type RecordingPipelineLike,
  type RegisteredWorkspace,
  type ResolvedWorkspaceProfile,
  runDaemonRuntimeLoop,
  SessionSnapshotMemoryBudgetExceededError,
  StructuredLogger,
  WorkspaceCatalog,
  type WorkspaceCatalogLike,
  WorkspaceProfileResolver,
  type WorkspaceProfileResolverLike,
  type WorkspaceRegistryStoreLike,
  type WritePathPolicyGateLike,
} from "../apps/daemon/src/mod.ts";
import {
  makeTestTempDir,
  makeTestTempPath,
  removePathIfPresent as removeDirIfPresent,
  resolveTestTempPath,
} from "./test_temp.ts";

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
}

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

function makeEventForSession(
  sessionId: string,
  id: string,
  kind: "message.user" | "message.assistant",
  content: string,
  timestamp = "2026-02-22T19:00:00.000Z",
): ConversationEvent {
  return {
    eventId: id,
    provider: "codex",
    sessionId,
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

const TEST_WORKSPACE_ALIAS = "My.Proj";
const TEST_WORKSPACE_ID = "workspace-my-proj";
const TEST_WORKSPACE_REGISTERED_AT = "2026-02-22T09:55:00.000Z";
const DAEMON_RUNTIME_MOCK_SOURCE_PATH = resolveTestTempPath(
  "daemon-runtime",
  "mock-source.jsonl",
);
const DAEMON_RUNTIME_MOCK_SESSION_PATH = resolveTestTempPath(
  "daemon-runtime",
  "mock-session.jsonl",
);
const DAEMON_RUNTIME_CAPTURE_PATH = resolveTestTempPath(
  "daemon-runtime",
  "captured.md",
);
const DAEMON_RUNTIME_FIRST_SEEN_CAPTURE_PATH = resolveTestTempPath(
  "daemon-runtime",
  "first-seen.md",
);
const DAEMON_RUNTIME_CAPTURE_FROM_TWIN_PATH = resolveTestTempPath(
  "daemon-runtime",
  "capture-from-twin.md",
);
const DAEMON_RUNTIME_OTHER_DESTINATION_PATH = resolveTestTempPath(
  "daemon-runtime",
  "other-destination.md",
);

type SessionMetadataEntry = Awaited<
  ReturnType<PersistentSessionStateStore["listSessionMetadata"]>
>[number];
type SessionWorkspaceOutputState = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number];

interface TestWorkspaceFixture {
  entry: RegisteredWorkspace;
  profile: ResolvedWorkspaceProfile;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
}

function cloneRegisteredWorkspace(
  entry: RegisteredWorkspace,
): RegisteredWorkspace {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    registeredAt: entry.registeredAt,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

function cloneWorkspaceProfile(
  profile: ResolvedWorkspaceProfile,
): ResolvedWorkspaceProfile {
  return {
    workspaceId: profile.workspaceId,
    alias: profile.alias,
    workspaceRoot: profile.workspaceRoot,
    configPath: profile.configPath,
    resolvedDefaultOutputDir: profile.resolvedDefaultOutputDir,
    defaultOutputDirTemplate: profile.defaultOutputDirTemplate,
    filenameTemplate: profile.filenameTemplate,
    workspaceTimezone: profile.workspaceTimezone,
    markdownFrontmatter: { ...profile.markdownFrontmatter },
    writerFeatureFlags: { ...profile.writerFeatureFlags },
  };
}

function makeMutableWorkspaceRegistryStore(
  initial: RegisteredWorkspace[] = [],
): {
  store: WorkspaceRegistryStoreLike;
  setEntries(entries: RegisteredWorkspace[]): Promise<void>;
} {
  let entries = initial.map(cloneRegisteredWorkspace);
  let mtime = 0;

  return {
    store: {
      load() {
        return Promise.resolve(entries.map(cloneRegisteredWorkspace));
      },
      save(nextEntries: RegisteredWorkspace[]) {
        entries = nextEntries.map(cloneRegisteredWorkspace);
        mtime += 1;
        return Promise.resolve();
      },
      statMtimeMs() {
        return Promise.resolve(mtime);
      },
    },
    setEntries(nextEntries: RegisteredWorkspace[]) {
      entries = nextEntries.map(cloneRegisteredWorkspace);
      mtime += 1;
      return Promise.resolve();
    },
  };
}

async function createRuntimeWorkspaceEntry(
  baseDir: string,
  options: {
    workspaceId: string;
    alias: string;
    directoryName: string;
    configLines?: string[];
    registeredAt?: string;
  },
): Promise<RegisteredWorkspace> {
  const workspaceRoot = join(baseDir, options.directoryName);
  const configPath = join(
    workspaceRoot,
    DEFAULT_WORKSPACE_CONFIG_FILENAME,
  );
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.writeTextFile(
    configPath,
    `${
      (options.configLines ?? [`workspaceId: ${options.workspaceId}`]).join(
        "\n",
      )
    }\n`,
  );
  return {
    workspaceId: options.workspaceId,
    alias: options.alias,
    workspaceRoot,
    configPath,
    registeredAt: options.registeredAt ?? "2026-02-22T09:55:00.000Z",
  };
}

function makeAllowAllPathPolicyGate(): WritePathPolicyGateLike {
  return {
    evaluateWritePath(targetPath: string) {
      return Promise.resolve({
        decision: "allow" as const,
        targetPath,
        reason: "allowed-for-test",
        canonicalTargetPath: targetPath,
      });
    },
  };
}

async function createTestWorkspaceFixture(
  baseDir: string,
): Promise<TestWorkspaceFixture> {
  const workspaceRoot = join(baseDir, "workspace");
  const configPath = join(
    workspaceRoot,
    DEFAULT_WORKSPACE_CONFIG_FILENAME,
  );
  const resolvedDefaultOutputDir = join(workspaceRoot, "notes");
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(resolvedDefaultOutputDir, { recursive: true });

  const entry: RegisteredWorkspace = {
    workspaceId: TEST_WORKSPACE_ID,
    alias: TEST_WORKSPACE_ALIAS,
    workspaceRoot,
    configPath,
    registeredAt: TEST_WORKSPACE_REGISTERED_AT,
  };
  const profile: ResolvedWorkspaceProfile = {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    resolvedDefaultOutputDir,
    defaultOutputDirTemplate: "notes",
    filenameTemplate: "{provider}-{sessionShortId}.md",
    workspaceTimezone: "local",
    markdownFrontmatter: createDefaultWorkspaceMarkdownFrontmatterConfig(),
    writerFeatureFlags: {
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
      writerIncludeToolCalls: true,
      writerItalicizeUserMessages: false,
    },
  };

  return {
    entry,
    profile,
    workspaceCatalog: {
      getByAlias(alias: string) {
        return Promise.resolve(
          alias === entry.alias ? cloneRegisteredWorkspace(entry) : undefined,
        );
      },
      getByWorkspaceId(workspaceId: string) {
        return Promise.resolve(
          workspaceId === entry.workspaceId
            ? cloneRegisteredWorkspace(entry)
            : undefined,
        );
      },
      list() {
        return Promise.resolve([cloneRegisteredWorkspace(entry)]);
      },
      refreshIfChanged() {
        return Promise.resolve();
      },
    },
    workspaceProfileResolver: {
      resolveForCommand() {
        return Promise.resolve(cloneWorkspaceProfile(profile));
      },
    },
  };
}

function makeWorkspaceOutputState(
  fixture: TestWorkspaceFixture,
  options: {
    currentResolvedPath: string;
    desiredState?: "on" | "off";
    writeCursor?: number;
    activeRecordingCycleId?: string;
    recordingCycles?: SessionWorkspaceOutputState["recordingCycles"];
    currentDestination?: SessionWorkspaceOutputState["currentDestination"];
  },
): SessionWorkspaceOutputState {
  return {
    workspaceId: fixture.profile.workspaceId,
    workspaceAliasSnapshot: fixture.profile.alias,
    desiredState: options.desiredState ?? "off",
    currentDestination: options.currentDestination ?? {
      kind: "absolute-explicit",
      absolutePath: options.currentResolvedPath,
    },
    currentResolvedPath: options.currentResolvedPath,
    sourceConfigPath: fixture.profile.configPath,
    workspaceRootSnapshot: fixture.profile.workspaceRoot,
    resolvedDefaultOutputDir: fixture.profile.resolvedDefaultOutputDir,
    filenameTemplate: fixture.profile.filenameTemplate,
    writerFeatureFlags: { ...fixture.profile.writerFeatureFlags },
    ...(options.activeRecordingCycleId
      ? { activeRecordingCycleId: options.activeRecordingCycleId }
      : {}),
    writeCursor: options.writeCursor ?? 0,
    createdAt: "2026-02-22T09:59:00.000Z",
    recordingCycles: options.recordingCycles
      ? options.recordingCycles.map((cycle) => ({ ...cycle }))
      : [],
  };
}

function findWorkspaceOutputState(
  metadata: SessionMetadataEntry,
  workspaceId: string = TEST_WORKSPACE_ID,
): SessionWorkspaceOutputState {
  const output = metadata.workspaceOutputs?.find((entry) =>
    entry.workspaceId === workspaceId
  );
  assertExists(output);
  return output;
}

interface PersistentInChatScenarioOptions {
  events: ConversationEvent[];
  recordingPipeline: RecordingPipelineLike;
  snapshotSnippetOverride?: string;
  prepopulate?: (
    sessionStateStore: PersistentSessionStateStore,
    workspace: TestWorkspaceFixture,
  ) => Promise<void>;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

async function runPersistentInChatScenario(
  options: PersistentInChatScenarioOptions,
): Promise<{
  stateDir: string;
  currentStatus: DaemonStatusSnapshot;
  workspace: TestWorkspaceFixture;
  metadataList: Awaited<
    ReturnType<PersistentSessionStateStore["listSessionMetadata"]>
  >;
}> {
  const stateDir = await makeTestTempDir("daemon-runtime-inchat-redesign-");
  const workspace = await createTestWorkspaceFixture(stateDir);

  const nowIso = "2026-02-22T10:00:00.000Z";
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: nowIso,
    heartbeatAt: nowIso,
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
    now: () => new Date(nowIso),
  });
  const sessionStateStore = new PersistentSessionStateStore({
    katoDir: join(stateDir, ".kato"),
    now: () => new Date(nowIso),
    makeSessionId: () => "kato-session-inchat-redesign-1234",
  });
  if (options.prepopulate) {
    await options.prepopulate(sessionStateStore, workspace);
  }

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
          sessionId: "session-1",
          cursor: { kind: "byte-offset", value: 1 },
          events: options.events,
          ...(options.snapshotSnippetOverride
            ? { snippetOverride: options.snapshotSnippetOverride }
            : {}),
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: nowIso,
          sessionsUpdated: 1,
          eventsObserved: options.events.length,
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
    requestId: "req-stop-inchat-redesign",
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

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline: options.recordingPipeline,
    ingestionRunners: [ingestionRunner],
    sessionSnapshotStore,
    sessionStateStore,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
    now: () => new Date(nowIso),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
    workspaceCatalog: workspace.workspaceCatalog,
    workspaceProfileResolver: workspace.workspaceProfileResolver,
  });

  const metadataList = await sessionStateStore.listSessionMetadata();
  return { stateDir, currentStatus, workspace, metadataList };
}

type ScenarioMetadataList = SessionMetadataEntry[];

async function makeWritableScenarioDir(prefix: string): Promise<string> {
  return await makeTestTempDir(prefix);
}

async function withStateDirCleanup(
  run: (setStateDir: (stateDir: string | undefined) => void) => Promise<void>,
): Promise<void> {
  let stateDir: string | undefined;

  try {
    await run((nextStateDir) => {
      stateDir = nextStateDir;
    });
  } finally {
    await removeDirIfPresent(stateDir);
  }
}

async function withScenarioDirs(
  prefix: string,
  run: (
    scenarioDir: string,
    setStateDir: (stateDir: string | undefined) => void,
  ) => Promise<void>,
): Promise<void> {
  const scenarioDir = await makeWritableScenarioDir(prefix);
  await withStateDirCleanup(async (setStateDir) => {
    try {
      await run(scenarioDir, setStateDir);
    } finally {
      await removeDirIfPresent(scenarioDir);
    }
  });
}

function makePersistentInChatRecordingPipeline(
  overrides: Partial<RecordingPipelineLike> = {},
): RecordingPipelineLike {
  const nowIso = "2026-02-22T10:00:00.000Z";
  return {
    activateRecording(input) {
      return Promise.resolve({
        recordingId: input.recordingId ?? "rec-default",
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath: input.targetPath,
        startedAt: nowIso,
        lastWriteAt: nowIso,
      });
    },
    captureSnapshot(input) {
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
    exportSnapshot(input) {
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
      return Promise.resolve({
        appended: false,
        deduped: false,
      });
    },
    appendToDestination(input) {
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
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
    ...overrides,
  };
}

async function prepopulateScenarioSessionMetadata(
  sessionStateStore: PersistentSessionStateStore,
  mutate: (metadata: ScenarioMetadataList[number]) => void,
): Promise<void> {
  const metadata = await sessionStateStore.getOrCreateSessionMetadata({
    provider: "codex",
    providerSessionId: "session-1",
    sourceFilePath: DAEMON_RUNTIME_MOCK_SOURCE_PATH,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  mutate(metadata);
  await sessionStateStore.saveSessionMetadata(metadata);
}

function makeSingleWorkspaceOutputPrepopulate(
  buildOptions: (
    workspace: TestWorkspaceFixture,
  ) => Parameters<typeof makeWorkspaceOutputState>[1],
): PersistentInChatScenarioOptions["prepopulate"] {
  return async (sessionStateStore, workspace) => {
    await prepopulateScenarioSessionMetadata(sessionStateStore, (metadata) => {
      metadata.workspaceOutputs = [
        makeWorkspaceOutputState(workspace, buildOptions(workspace)),
      ];
    });
  };
}

function findScenarioMetadata(metadataList: ScenarioMetadataList) {
  const session = metadataList.find((entry) =>
    entry.providerSessionId === "session-1"
  );
  assertExists(session);
  return session;
}

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat rejects bare ::init as unsupported",
  async () => {
    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    await withStateDirCleanup(async (setStateDir) => {
      const result = await runPersistentInChatScenario({
        events: [makeEvent("u-init-bare", "message.user", "::init")],
        recordingPipeline: makePersistentInChatRecordingPipeline(),
        operationalLogger,
      });
      setStateDir(result.stateDir);

      const session = findScenarioMetadata(result.metadataList);
      assertEquals(session.workspaceOutputs ?? [], []);
      assert(
        sink.records.some((record) =>
          record.event === "recording.command.parse_error"
        ),
      );
    });
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat rejects ::init-<alias> as unsupported and preserves existing binding",
  async () => {
    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    await withScenarioDirs(
      "daemon-runtime-init-unsupported-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "existing.md");
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-init-scoped",
              "message.user",
              `::init-${TEST_WORKSPACE_ALIAS} notes/new.md`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline(),
          operationalLogger,
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
          })),
        });
        setStateDir(result.stateDir);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, destination);
        assert(
          sink.records.some((record) =>
            record.event === "recording.command.parse_error"
          ),
        );
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat failed ::record-<alias> leaves the workspace binding path unchanged",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-record-fail-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "pointer.md");
        let appendCalls = 0;
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-record-fail",
              "message.user",
              `::record-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            appendToDestination() {
              appendCalls += 1;
              throw new Error("append failed");
            },
          }),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
          })),
        });
        setStateDir(result.stateDir);

        assert(appendCalls >= 1);
        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, destination);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::record-<alias> is a no-op for an already-active workspace cycle on the same destination",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-record-s2-noop-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "active.md");
        let appendCalls = 0;
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-record-s2-noop",
              "message.user",
              `::record-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            appendToDestination() {
              appendCalls += 1;
              return Promise.resolve({
                mode: "append",
                outputPath: destination,
                wrote: true,
                deduped: false,
              });
            },
          }),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-active",
            recordingCycles: [{
              recordingCycleId: "cycle-active",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        assertEquals(appendCalls, 0);
        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.desiredState, "on");
        assertEquals(output.recordingCycles.length, 1);
        assertEquals(output.activeRecordingCycleId, "cycle-active");
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::stop preserves the workspace binding and closes the active cycle",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-stop-s2-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "active.md");
        const result = await runPersistentInChatScenario({
          events: [makeEvent("u-stop-s2", "message.user", "::stop")],
          recordingPipeline: makePersistentInChatRecordingPipeline(),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-active",
            recordingCycles: [{
              recordingCycleId: "cycle-active",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, destination);
        assertEquals(output.desiredState, "off");
        assertEquals(output.recordingCycles[0]?.stoppedCursor, 1);
        assertEquals(output.activeRecordingCycleId, undefined);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> without an argument resolves a new default destination",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-no-arg-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "pointer.md");
        const captureTargets: string[] = [];
        const captureRecordingCycleIds: string[][] = [];
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-pointer",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(input) {
              captureTargets.push(input.targetPath);
              captureRecordingCycleIds.push(input.recordingCycleIds ?? []);
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
          }),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-pointer",
            recordingCycles: [{
              recordingCycleId: "cycle-pointer",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        const expectedTargetPath = join(
          result.workspace.profile.resolvedDefaultOutputDir,
          "codex-session.md",
        );
        assertEquals(captureTargets, [expectedTargetPath]);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(captureRecordingCycleIds.length, 1);
        assertEquals(captureRecordingCycleIds[0]?.length, 1);
        assertEquals(output.currentResolvedPath, expectedTargetPath);
        assertEquals(output.desiredState, "on");
        assertExists(output.activeRecordingCycleId);
        assertEquals(
          captureRecordingCycleIds[0]?.[0],
          output.activeRecordingCycleId,
        );
        assert(output.activeRecordingCycleId !== "cycle-pointer");
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> without an argument resolves a unique default destination on collisions",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-no-arg-collision-",
      async (_scenarioDir, setStateDir) => {
        const captureTargets: string[] = [];
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-1",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS}`,
            ),
            makeEvent(
              "u-capture-2",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            async captureSnapshot(input) {
              captureTargets.push(input.targetPath);
              await Deno.writeTextFile(
                input.targetPath,
                `capture #${captureTargets.length}`,
              );
              return {
                outputPath: input.targetPath,
                writeResult: {
                  mode: "overwrite",
                  outputPath: input.targetPath,
                  wrote: true,
                  deduped: false,
                },
                format: "markdown" as const,
              };
            },
          }),
        });
        setStateDir(result.stateDir);

        const firstTarget = join(
          result.workspace.profile.resolvedDefaultOutputDir,
          "codex-session.md",
        );
        const secondTarget = join(
          result.workspace.profile.resolvedDefaultOutputDir,
          "codex-session-2.md",
        );
        assertEquals(captureTargets, [firstTarget, secondTarget]);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, secondTarget);
        assertEquals(output.desiredState, "on");
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> retries with next suffix when capture writer reports AlreadyExists",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-race-retry-",
      async (_scenarioDir, setStateDir) => {
        const captureTargets: string[] = [];
        let attempts = 0;
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-race",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            async captureSnapshot(input) {
              attempts += 1;
              captureTargets.push(input.targetPath);
              if (attempts === 1) {
                await Deno.writeTextFile(input.targetPath, "occupied by race");
                throw new Deno.errors.AlreadyExists(
                  "capture destination exists",
                );
              }
              await Deno.writeTextFile(input.targetPath, "capture #2");
              return {
                outputPath: input.targetPath,
                writeResult: {
                  mode: "overwrite",
                  outputPath: input.targetPath,
                  wrote: true,
                  deduped: false,
                },
                format: "markdown" as const,
              };
            },
          }),
        });
        setStateDir(result.stateDir);

        const firstTarget = join(
          result.workspace.profile.resolvedDefaultOutputDir,
          "codex-session.md",
        );
        const secondTarget = join(
          result.workspace.profile.resolvedDefaultOutputDir,
          "codex-session-2.md",
        );
        assertEquals(captureTargets, [firstTarget, secondTarget]);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, secondTarget);
        assertEquals(output.desiredState, "on");
        assertExists(output.activeRecordingCycleId);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> does not retry on generic already-exists message errors",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-generic-already-exists-",
      async (scenarioDir, setStateDir) => {
        const oldDestination = join(scenarioDir, "old.md");
        let captureCalls = 0;
        const { sink, operationalLogger, auditLogger } = makeDebugLoggers();

        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-generic-message",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(input) {
              captureCalls += 1;
              if (captureCalls === 1) {
                throw new Error(
                  `backend write target already exists: ${input.targetPath}`,
                );
              }
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
          }),
          operationalLogger,
          auditLogger,
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: oldDestination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-before-generic-error",
            recordingCycles: [{
              recordingCycleId: "cycle-before-generic-error",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        assertEquals(captureCalls, 1);
        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, oldDestination);
        assertEquals(output.desiredState, "on");
        assertEquals(
          output.activeRecordingCycleId,
          "cycle-before-generic-error",
        );
        assertEquals(output.recordingCycles.length, 1);
        assert(
          sink.records.some((record) =>
            record.event === "recording.command.failed" &&
            String(record.attributes?.["command"] ?? "") === "capture"
          ),
        );
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> prefers stored snapshot snippet for title",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-title-snippet-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "pointer.md");
        const captureTitles: string[] = [];
        const storedSnippet =
          "Can we add workspaces alias to status? In the live display,…";
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-title",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          snapshotSnippetOverride: storedSnippet,
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(input) {
              assertExists(input.title);
              captureTitles.push(input.title);
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
          }),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-pointer",
            recordingCycles: [{
              recordingCycleId: "cycle-pointer",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        assertEquals(captureTitles, [storedSnippet]);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> ignores stale active cycle ids when workspace output is off",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-stale-cycle-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "pointer.md");
        const captureRecordingCycleIds: Array<string[] | undefined> = [];
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-stale-cycle",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(input) {
              captureRecordingCycleIds.push(input.recordingCycleIds);
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
          }),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
            desiredState: "off",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-stale",
            recordingCycles: [{
              recordingCycleId: "cycle-stale",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(captureRecordingCycleIds.length, 1);
        assertEquals(captureRecordingCycleIds[0]?.length, 1);
        assertEquals(
          output.currentResolvedPath,
          join(
            result.workspace.profile.resolvedDefaultOutputDir,
            "codex-session.md",
          ),
        );
        assertEquals(output.desiredState, "on");
        assertExists(output.activeRecordingCycleId);
        assertEquals(
          captureRecordingCycleIds[0]?.[0],
          output.activeRecordingCycleId,
        );
        assert(output.activeRecordingCycleId !== "cycle-stale");
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat reuses the same workspace output when commands target the same destination",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-idempotent-id-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "same.md");
        const captureRecordingCycleIds: string[][] = [];
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-record-same-path",
              "message.user",
              `::record-${TEST_WORKSPACE_ALIAS} ${destination}`,
            ),
            makeEvent(
              "u-record-same",
              "message.user",
              `::record-${TEST_WORKSPACE_ALIAS}`,
            ),
            makeEvent(
              "u-capture-same",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS} ${destination}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(input) {
              captureRecordingCycleIds.push(input.recordingCycleIds ?? []);
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
          }),
        });
        setStateDir(result.stateDir);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(session.workspaceOutputs?.length ?? 0, 1);
        assertEquals(output.currentResolvedPath, destination);
        assertEquals(output.recordingCycles.length, 1);
        assertEquals(captureRecordingCycleIds.length, 1);
        assertEquals(
          captureRecordingCycleIds[0],
          [output.recordingCycles[0]?.recordingCycleId],
        );
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat distinct destinations allocate distinct recording cycle ids",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-distinct-ids-",
      async (scenarioDir, setStateDir) => {
        const destinationA = join(scenarioDir, "a.md");
        const destinationB = join(scenarioDir, "b.md");
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-record-a",
              "message.user",
              `::record-${TEST_WORKSPACE_ALIAS} ${destinationA}`,
            ),
            makeEvent(
              "u-record-b",
              "message.user",
              `::record-${TEST_WORKSPACE_ALIAS} ${destinationB}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline(),
        });
        setStateDir(result.stateDir);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, destinationB);
        assertEquals(output.recordingCycles.length, 2);
        assert(
          output.recordingCycles[0]!.recordingCycleId !==
            output.recordingCycles[1]!.recordingCycleId,
        );
        assertEquals(output.recordingCycles[0]?.stoppedCursor, 2);
        assertEquals(output.recordingCycles[1]?.startedCursor, 2);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> with an explicit path switches the active workspace binding",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-switch-",
      async (scenarioDir, setStateDir) => {
        const oldDestination = join(scenarioDir, "old.md");
        const newDestination = join(scenarioDir, "new.md");
        const captureTargets: string[] = [];
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-switch",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS} ${newDestination}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(input) {
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
          }),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: oldDestination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-old",
            recordingCycles: [{
              recordingCycleId: "cycle-old",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        assertEquals(captureTargets, [newDestination]);
        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, newDestination);
        assertEquals(output.desiredState, "on");
        assertExists(output.activeRecordingCycleId);
        assert(output.activeRecordingCycleId !== "cycle-old");
        assertEquals(output.recordingCycles.length, 2);
        assertEquals(output.recordingCycles[0]?.recordingCycleId, "cycle-old");
        assertEquals(output.recordingCycles[0]?.stoppedCursor, 1);
        assertEquals(output.recordingCycles[1]?.startedCursor, 1);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::export-<alias> leaves the workspace binding and active state unchanged",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-export-invariant-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "active.md");
        const exportTarget = join(scenarioDir, "export.md");
        const exportTargets: string[] = [];
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-export",
              "message.user",
              `::export-${TEST_WORKSPACE_ALIAS} ${exportTarget}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            exportSnapshot(input) {
              exportTargets.push(input.targetPath);
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
          }),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: destination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-active",
            recordingCycles: [{
              recordingCycleId: "cycle-active",
              startedCursor: 0,
            }],
          })),
        });
        setStateDir(result.stateDir);

        assertEquals(exportTargets, [exportTarget]);
        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, destination);
        assertEquals(output.desiredState, "on");
        assertEquals(output.activeRecordingCycleId, "cycle-active");
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> fails on existing destination without mutating state",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-existing-target-",
      async (scenarioDir, setStateDir) => {
        const oldDestination = join(scenarioDir, "old.md");
        const existingDestination = join(scenarioDir, "existing.md");
        await Deno.writeTextFile(existingDestination, "already-here");

        let captureCalls = 0;
        const { sink, operationalLogger, auditLogger } = makeDebugLoggers();

        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-existing",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS} ${existingDestination}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(_input) {
              captureCalls += 1;
              throw new Error("captureSnapshot should not be called");
            },
          }),
          operationalLogger,
          auditLogger,
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: oldDestination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-existing-before",
            recordingCycles: [{
              recordingCycleId: "cycle-existing-before",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        assertEquals(captureCalls, 0);
        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, oldDestination);
        assertEquals(output.desiredState, "on");
        assertEquals(output.activeRecordingCycleId, "cycle-existing-before");
        assertEquals(output.recordingCycles.length, 1);
        assertEquals(output.recordingCycles[0]?.stoppedCursor, undefined);
        assert(
          sink.records.some((record) =>
            record.event === "recording.command.failed" &&
            String(record.attributes?.["command"] ?? "") === "capture"
          ),
        );
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat executes one-message ::stop then ::record-<alias> path retarget then ::record-<alias> in order",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-sequential-",
      async (scenarioDir, setStateDir) => {
        const oldDestination = join(scenarioDir, "old.md");
        const newDestination = join(scenarioDir, "new.md");
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-sequential",
              "message.user",
              `::stop\n::record-${TEST_WORKSPACE_ALIAS} ${newDestination}\n::record-${TEST_WORKSPACE_ALIAS}`,
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline(),
          prepopulate: makeSingleWorkspaceOutputPrepopulate(() => ({
            currentResolvedPath: oldDestination,
            desiredState: "on",
            writeCursor: 1,
            activeRecordingCycleId: "cycle-old",
            recordingCycles: [{
              recordingCycleId: "cycle-old",
              startedCursor: 0,
              startedAt: "2026-02-22T09:59:00.000Z",
            }],
          })),
        });
        setStateDir(result.stateDir);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(output.currentResolvedPath, newDestination);
        assertEquals(output.desiredState, "on");
        assertEquals(output.recordingCycles.length, 2);
        assertEquals(output.recordingCycles[0]?.stoppedCursor, 1);
        assertEquals(output.recordingCycles[1]?.startedCursor, 1);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat keeps active destination appends when first-seen stale commands are skipped",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-first-seen-stale-command-active-output-",
      async (scenarioDir, setStateDir) => {
        const persistentDestination = join(scenarioDir, "active.md");
        let captureCalls = 0;
        const appendTargets: string[] = [];
        const appendEventCounts: number[] = [];
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-stale-command",
              "message.user",
              `::capture-${TEST_WORKSPACE_ALIAS} ${
                join(scenarioDir, "stale.md")
              }`,
              "2026-02-22T09:59:40.000Z",
            ),
            makeEvent(
              "a-followup",
              "message.assistant",
              "assistant follow-up",
              "2026-02-22T10:00:01.000Z",
            ),
          ],
          recordingPipeline: makePersistentInChatRecordingPipeline({
            captureSnapshot(input) {
              captureCalls += 1;
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
            appendToDestination(input) {
              appendTargets.push(input.targetPath);
              appendEventCounts.push(input.events.length);
              return Promise.resolve({
                mode: "append",
                outputPath: input.targetPath,
                wrote: true,
                deduped: false,
              });
            },
          }),
          prepopulate: async (sessionStateStore, workspace) => {
            await prepopulateScenarioSessionMetadata(sessionStateStore, (
              metadata,
            ) => {
              metadata.commandCursor = 0;
              delete metadata.commandCursorAnchor;
              metadata.lastObservedMtimeMs = new Date(
                "2026-02-22T10:00:04.000Z",
              ).getTime();
              metadata.workspaceOutputs = [
                makeWorkspaceOutputState(workspace, {
                  currentResolvedPath: persistentDestination,
                  desiredState: "on",
                  writeCursor: 0,
                  activeRecordingCycleId: "cycle-live",
                  recordingCycles: [{
                    recordingCycleId: "cycle-live",
                    startedCursor: 0,
                    startedAt: "2026-02-22T09:59:00.000Z",
                  }],
                }),
              ];
            });
          },
        });
        setStateDir(result.stateDir);

        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(captureCalls, 0);
        assertEquals(appendTargets, [persistentDestination]);
        assertEquals(appendEventCounts, [2]);
        assertEquals(session.commandCursor, 2);
        assertEquals(session.commandCursorAnchor?.eventId, "a-followup");
        assertEquals(output.currentResolvedPath, persistentDestination);
        assertEquals(output.desiredState, "on");
        assertEquals(output.activeRecordingCycleId, "cycle-live");
        assertEquals(output.writeCursor, 2);
        assertEquals(output.recordingCycles.length, 1);
        assertEquals(output.recordingCycles[0]?.stoppedCursor, undefined);
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop applies live workspace register and unregister updates without breaking active workspace outputs",
  async () => {
    await withStateDirCleanup(async (setStateDir) => {
      const stateDir = await makeTestTempDir("daemon-runtime-live-register-");
      setStateDir(stateDir);

      const workspace = await createRuntimeWorkspaceEntry(stateDir, {
        workspaceId: "ws-live-register",
        alias: "Live.Proj",
        directoryName: "live-proj",
      });
      const destination = join(stateDir, "live-register.md");
      const { store, setEntries } = makeMutableWorkspaceRegistryStore();
      const workspaceCatalog = new WorkspaceCatalog(store);
      const workspaceProfileResolver = new WorkspaceProfileResolver();
      const appendTargets: string[] = [];

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
      const sessionStateStore = new PersistentSessionStateStore({
        katoDir: join(stateDir, ".kato"),
        now: () => new Date("2026-02-22T10:00:00.000Z"),
        makeSessionId: () => "kato-session-live-register-1234",
      });
      const recordingPipeline = makePersistentInChatRecordingPipeline({
        appendToDestination(input) {
          appendTargets.push(input.targetPath);
          return Promise.resolve({
            mode: "append",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          });
        },
      });

      const firstEvent = makeEvent(
        "u-live-register",
        "message.user",
        `::record-${workspace.alias} ${destination}`,
      );
      const secondEvent = makeEvent(
        "a-live-continue",
        "message.assistant",
        "still writing",
      );
      const thirdEvent = makeEvent(
        "u-live-stop",
        "message.user",
        `::stop-${workspace.alias}`,
      );

      let pollCount = 0;
      const stopRequests = [{
        requestId: "req-stop-live-register",
        requestedAt: "2026-02-22T10:00:03.000Z",
        command: "stop" as const,
      }];
      const controlStore: DaemonControlRequestStoreLike = {
        list() {
          return Promise.resolve(
            pollCount >= 3
              ? stopRequests.map((request) => ({ ...request }))
              : [],
          );
        },
        enqueue(_request) {
          throw new Error("enqueue should not be called in this test");
        },
        markProcessed(requestId: string) {
          const index = stopRequests.findIndex((request) =>
            request.requestId === requestId
          );
          if (index >= 0) {
            stopRequests.splice(0, index + 1);
          }
          return Promise.resolve();
        },
      };

      const ingestionRunner: ProviderIngestionRunner = {
        provider: "codex",
        start() {
          return Promise.resolve();
        },
        async poll() {
          pollCount += 1;
          if (pollCount === 1) {
            await setEntries([workspace]);
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 1 },
              events: [firstEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:00.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          if (pollCount === 2) {
            await setEntries([]);
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 2 },
              events: [firstEvent, secondEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:01.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          if (pollCount === 3) {
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 3 },
              events: [firstEvent, secondEvent, thirdEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:02.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          return {
            provider: "codex",
            polledAt: "2026-02-22T10:00:03.000Z",
            sessionsUpdated: 0,
            eventsObserved: 0,
          };
        },
        stop() {
          return Promise.resolve();
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
        workspaceCatalog,
        workspaceProfileResolver,
      });

      const metadataList = await sessionStateStore.listSessionMetadata();
      const session = findScenarioMetadata(metadataList);
      const output = findWorkspaceOutputState(session, workspace.workspaceId);

      assertEquals(appendTargets, [destination, destination, destination]);
      assertEquals(output.currentResolvedPath, destination);
      assertEquals(output.desiredState, "on");
      assertExists(output.activeRecordingCycleId);
      assertEquals(output.recordingCycles.length, 1);
      assertEquals(output.recordingCycles[0]?.stoppedCursor, undefined);
      assertEquals(
        await workspaceCatalog.getByAlias(workspace.alias),
        undefined,
      );
    });
  },
);

Deno.test(
  "runDaemonRuntimeLoop reloads workspace config for future commands without retargeting existing active outputs",
  async () => {
    await withStateDirCleanup(async (setStateDir) => {
      const stateDir = await makeTestTempDir("daemon-runtime-live-config-");
      setStateDir(stateDir);

      const workspace = await createRuntimeWorkspaceEntry(stateDir, {
        workspaceId: "ws-live-config",
        alias: "Config.Proj",
        directoryName: "config-proj",
        configLines: [
          "workspaceId: ws-live-config",
          "defaultOutputDir: notes-old",
        ],
      });
      const { store } = makeMutableWorkspaceRegistryStore([workspace]);
      const workspaceCatalog = new WorkspaceCatalog(store);
      const workspaceProfileResolver = new WorkspaceProfileResolver();
      const appendCalls: Array<{ sessionId: string; targetPath: string }> = [];

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
      let nextSessionId = 0;
      const sessionStateStore = new PersistentSessionStateStore({
        katoDir: join(stateDir, ".kato"),
        now: () => new Date("2026-02-22T10:00:00.000Z"),
        makeSessionId: () => `kato-session-live-config-${++nextSessionId}`,
      });
      const recordingPipeline = makePersistentInChatRecordingPipeline({
        appendToDestination(input) {
          appendCalls.push({
            sessionId: input.sessionId,
            targetPath: input.targetPath,
          });
          return Promise.resolve({
            mode: "append",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          });
        },
      });

      const firstEvent = makeEventForSession(
        "session-1",
        "u-config-record-1",
        "message.user",
        `::record-${workspace.alias}`,
      );
      const secondEvent = makeEventForSession(
        "session-1",
        "a-config-followup",
        "message.assistant",
        "still on old output",
      );
      const thirdEvent = makeEventForSession(
        "session-2",
        "u-config-record-2",
        "message.user",
        `::record-${workspace.alias}`,
      );

      let pollCount = 0;
      const stopRequests = [{
        requestId: "req-stop-live-config",
        requestedAt: "2026-02-22T10:00:03.000Z",
        command: "stop" as const,
      }];
      const controlStore: DaemonControlRequestStoreLike = {
        list() {
          return Promise.resolve(
            pollCount >= 3
              ? stopRequests.map((request) => ({ ...request }))
              : [],
          );
        },
        enqueue(_request) {
          throw new Error("enqueue should not be called in this test");
        },
        markProcessed(requestId: string) {
          const index = stopRequests.findIndex((request) =>
            request.requestId === requestId
          );
          if (index >= 0) {
            stopRequests.splice(0, index + 1);
          }
          return Promise.resolve();
        },
      };

      const ingestionRunner: ProviderIngestionRunner = {
        provider: "codex",
        start() {
          return Promise.resolve();
        },
        async poll() {
          pollCount += 1;
          if (pollCount === 1) {
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 1 },
              events: [firstEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:00.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          if (pollCount === 2) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            await Deno.writeTextFile(
              workspace.configPath,
              [
                "workspaceId: ws-live-config",
                "defaultOutputDir: notes-new",
              ].join("\n") + "\n",
            );
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 2 },
              events: [firstEvent, secondEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:01.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          if (pollCount === 3) {
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 2 },
              events: [firstEvent, secondEvent],
            });
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-2",
              cursor: { kind: "byte-offset", value: 1 },
              events: [thirdEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:02.000Z",
              sessionsUpdated: 2,
              eventsObserved: 1,
            };
          }
          return {
            provider: "codex",
            polledAt: "2026-02-22T10:00:03.000Z",
            sessionsUpdated: 0,
            eventsObserved: 0,
          };
        },
        stop() {
          return Promise.resolve();
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
        workspaceCatalog,
        workspaceProfileResolver,
      });

      const metadataList = await sessionStateStore.listSessionMetadata();
      const sessionOne = metadataList.find((entry) =>
        entry.providerSessionId === "session-1"
      );
      const sessionTwo = metadataList.find((entry) =>
        entry.providerSessionId === "session-2"
      );
      assertExists(sessionOne);
      assertExists(sessionTwo);

      const outputOne = findWorkspaceOutputState(
        sessionOne,
        workspace.workspaceId,
      );
      const outputTwo = findWorkspaceOutputState(
        sessionTwo,
        workspace.workspaceId,
      );
      const oldPrefix = join(workspace.workspaceRoot, "notes-old");
      const newPrefix = join(workspace.workspaceRoot, "notes-new");
      const sessionOneTargets = appendCalls
        .filter((call) => call.sessionId === "session-1")
        .map((call) => call.targetPath);
      const sessionTwoTargets = appendCalls
        .filter((call) => call.sessionId === "session-2")
        .map((call) => call.targetPath);

      assert(outputOne.currentResolvedPath.startsWith(oldPrefix));
      assert(outputTwo.currentResolvedPath.startsWith(newPrefix));
      assert(outputOne.currentResolvedPath !== outputTwo.currentResolvedPath);
      assertEquals(
        sessionOneTargets.every((targetPath) =>
          targetPath === outputOne.currentResolvedPath
        ),
        true,
      );
      assertEquals(sessionTwoTargets, [outputTwo.currentResolvedPath]);
    });
  },
);

Deno.test(
  "runDaemonRuntimeLoop applies alias, root, and config-path mutations for existing workspace entries live",
  async () => {
    await withStateDirCleanup(async (setStateDir) => {
      const stateDir = await makeTestTempDir("daemon-runtime-live-mutation-");
      setStateDir(stateDir);

      const workspace = await createRuntimeWorkspaceEntry(stateDir, {
        workspaceId: "ws-live-mutation",
        alias: "Stable.Proj",
        directoryName: "stable-proj",
      });
      const renamedWorkspace: RegisteredWorkspace = {
        ...workspace,
        alias: "Renamed.Proj",
        workspaceRoot: join(stateDir, "renamed-proj"),
        configPath: join(
          stateDir,
          "renamed-proj",
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        ),
        updatedAt: "2026-02-22T10:00:01.000Z",
      };
      const firstDestination = join(stateDir, "stable-one.md");
      const renamedDestination = join(stateDir, "renamed-one.md");
      const secondDestination = join(stateDir, "renamed-two.md");
      await Deno.mkdir(renamedWorkspace.workspaceRoot, { recursive: true });
      await Deno.writeTextFile(
        renamedWorkspace.configPath,
        `workspaceId: ${workspace.workspaceId}\n`,
      );
      const { store, setEntries } = makeMutableWorkspaceRegistryStore([
        workspace,
      ]);
      const workspaceCatalog = new WorkspaceCatalog(store);
      const workspaceProfileResolver = new WorkspaceProfileResolver();
      const appendTargets: string[] = [];

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
      const sessionStateStore = new PersistentSessionStateStore({
        katoDir: join(stateDir, ".kato"),
        now: () => new Date("2026-02-22T10:00:00.000Z"),
        makeSessionId: () => "kato-session-live-mutation-1234",
      });
      const recordingPipeline = makePersistentInChatRecordingPipeline({
        appendToDestination(input) {
          appendTargets.push(input.targetPath);
          return Promise.resolve({
            mode: "append",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          });
        },
      });

      const firstEvent = makeEvent(
        "u-mutation-old",
        "message.user",
        `::record-${workspace.alias} ${firstDestination}`,
      );
      const secondEvent = makeEvent(
        "u-mutation-new",
        "message.user",
        `::record-${renamedWorkspace.alias} ${renamedDestination}`,
      );
      const thirdEvent = makeEvent(
        "u-mutation-old-again",
        "message.user",
        `::record-${renamedWorkspace.alias} ${secondDestination}`,
      );

      let pollCount = 0;
      const stopRequests = [{
        requestId: "req-stop-live-mutation",
        requestedAt: "2026-02-22T10:00:03.000Z",
        command: "stop" as const,
      }];
      const controlStore: DaemonControlRequestStoreLike = {
        list() {
          return Promise.resolve(
            pollCount >= 3
              ? stopRequests.map((request) => ({ ...request }))
              : [],
          );
        },
        enqueue(_request) {
          throw new Error("enqueue should not be called in this test");
        },
        markProcessed(requestId: string) {
          const index = stopRequests.findIndex((request) =>
            request.requestId === requestId
          );
          if (index >= 0) {
            stopRequests.splice(0, index + 1);
          }
          return Promise.resolve();
        },
      };

      const ingestionRunner: ProviderIngestionRunner = {
        provider: "codex",
        start() {
          return Promise.resolve();
        },
        async poll() {
          pollCount += 1;
          if (pollCount === 1) {
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 1 },
              events: [firstEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:00.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          if (pollCount === 2) {
            await setEntries([renamedWorkspace]);
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 2 },
              events: [firstEvent, secondEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:01.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          if (pollCount === 3) {
            sessionSnapshotStore.upsert({
              provider: "codex",
              sessionId: "session-1",
              cursor: { kind: "byte-offset", value: 3 },
              events: [firstEvent, secondEvent, thirdEvent],
            });
            return {
              provider: "codex",
              polledAt: "2026-02-22T10:00:02.000Z",
              sessionsUpdated: 1,
              eventsObserved: 1,
            };
          }
          return {
            provider: "codex",
            polledAt: "2026-02-22T10:00:03.000Z",
            sessionsUpdated: 0,
            eventsObserved: 0,
          };
        },
        stop() {
          return Promise.resolve();
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
        workspaceCatalog,
        workspaceProfileResolver,
      });

      const metadataList = await sessionStateStore.listSessionMetadata();
      const session = findScenarioMetadata(metadataList);
      const output = findWorkspaceOutputState(session, workspace.workspaceId);
      const oldAlias = await workspaceCatalog.getByAlias(workspace.alias);
      const liveRenamedAlias = await workspaceCatalog.getByAlias(
        renamedWorkspace.alias,
      );

      assertEquals(
        appendTargets.filter((targetPath) => targetPath === firstDestination)
          .length,
        1,
      );
      assertEquals(
        appendTargets.filter((targetPath) => targetPath === renamedDestination)
          .length,
        1,
      );
      assertEquals(appendTargets[appendTargets.length - 1], secondDestination);
      assertEquals(output.currentResolvedPath, secondDestination);
      assertEquals(output.workspaceAliasSnapshot, renamedWorkspace.alias);
      assertEquals(
        output.workspaceRootSnapshot,
        renamedWorkspace.workspaceRoot,
      );
      assertEquals(output.sourceConfigPath, renamedWorkspace.configPath);
      assertEquals(output.recordingCycles.length, 3);
      assertEquals(oldAlias, undefined);
      assertExists(liveRenamedAlias);
      assertEquals(
        liveRenamedAlias.workspaceRoot,
        renamedWorkspace.workspaceRoot,
      );
    });
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::capture-<alias> writes plural frontmatter and appends trailing content end to end",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-capture-frontmatter-e2e-",
      async (scenarioDir, setStateDir) => {
        const oldDestination = join(scenarioDir, "capture-frontmatter-old.md");
        const destination = join(scenarioDir, "capture-frontmatter.md");
        const recordingPipeline = new RecordingPipeline({
          pathPolicyGate: makeAllowAllPathPolicyGate(),
          now: () => new Date("2026-02-22T10:00:00.000Z"),
        });
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-capture-frontmatter-e2e",
              "message.user",
              `Before capture\n::capture-${TEST_WORKSPACE_ALIAS} ${destination}\nAfter capture`,
            ),
          ],
          recordingPipeline,
          prepopulate: async (sessionStateStore, workspace) => {
            workspace.profile.workspaceTimezone = "America/Los_Angeles";
            await prepopulateScenarioSessionMetadata(
              sessionStateStore,
              (metadata) => {
                metadata.workspaceOutputs = [
                  makeWorkspaceOutputState(workspace, {
                    currentResolvedPath: oldDestination,
                    desiredState: "on",
                    writeCursor: 0,
                    activeRecordingCycleId: "cycle-capture-e2e",
                    recordingCycles: [{
                      recordingCycleId: "cycle-capture-e2e",
                      startedCursor: 0,
                      startedAt: "2026-02-22T09:59:00.000Z",
                    }],
                  }),
                ];
              },
            );
          },
        });
        setStateDir(result.stateDir);

        const content = await Deno.readTextFile(destination);
        const session = findScenarioMetadata(result.metadataList);
        const output = findWorkspaceOutputState(session);
        assertEquals(content.includes("kato-sessionIds:"), false);
        assertEquals(content.includes("kato-workspaceIds:"), false);
        assertExists(output.activeRecordingCycleId);
        const idLine = content.split("\n").find((line) =>
          line.startsWith("id: ")
        );
        assertExists(idLine);
        assert(/^id: [a-z0-9-]+-[a-z0-9]{6}$/.test(idLine));
        assertEquals(content.includes("kato-recordingIds:"), false);
        assert(content.includes("Before capture"));
        assert(content.includes("After capture"));
        assert(content.includes("# User_2026-02-22_1100_00"));
        assert(
          content.indexOf("Before capture") < content.indexOf("After capture"),
        );
      },
    );
  },
);

Deno.test(
  "runDaemonRuntimeLoop persistent in-chat ::export-<alias> writes plural frontmatter and appends trailing content end to end",
  async () => {
    await withScenarioDirs(
      "daemon-runtime-export-frontmatter-e2e-",
      async (scenarioDir, setStateDir) => {
        const destination = join(scenarioDir, "export-frontmatter.md");
        const recordingPipeline = new RecordingPipeline({
          pathPolicyGate: makeAllowAllPathPolicyGate(),
          now: () => new Date("2026-02-22T10:00:00.000Z"),
        });
        const result = await runPersistentInChatScenario({
          events: [
            makeEvent(
              "u-export-frontmatter-e2e",
              "message.user",
              `Before export\n::export-${TEST_WORKSPACE_ALIAS} ${destination}\nAfter export`,
            ),
          ],
          recordingPipeline,
        });
        setStateDir(result.stateDir);

        const content = await Deno.readTextFile(destination);
        assertEquals(content.includes("kato-sessionIds:"), false);
        assertEquals(content.includes("kato-workspaceIds:"), false);
        assertEquals(content.includes("kato-recordingIds:"), false);
        assert(content.includes("Before export"));
        assert(content.includes("After export"));
        assert(
          content.indexOf("Before export") < content.indexOf("After export"),
        );
      },
    );
  },
);

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

Deno.test("runDaemonRuntimeLoop clears queued control requests at startup", async () => {
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

  const startupRequests = [{
    requestId: "req-startup-export",
    requestedAt: "2026-02-22T10:00:00.000Z",
    command: "export" as const,
    payload: {
      sessionId: "session-old",
      resolvedOutputPath: ".kato/test-runtime/old.md",
    },
  }, {
    requestId: "req-startup-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const liveRequests = [{
    requestId: "req-live-stop",
    requestedAt: "2026-02-22T10:00:02.000Z",
    command: "stop" as const,
  }];
  let listCallCount = 0;
  const processedRequestIds: string[] = [];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      listCallCount += 1;
      if (listCallCount === 1) {
        return Promise.resolve(
          startupRequests.map((request) => ({ ...request })),
        );
      }
      if (listCallCount === 2) {
        return Promise.resolve(liveRequests.map((request) => ({ ...request })));
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      processedRequestIds.push(requestId);
      if (requestId === "req-startup-stop") {
        startupRequests.splice(0, startupRequests.length);
      }
      if (requestId === "req-live-stop") {
        liveRequests.splice(0, liveRequests.length);
      }
      return Promise.resolve();
    },
  };

  let exportCalls = 0;
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot() {
      exportCalls += 1;
      throw new Error("stale startup export should not execute");
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

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
    clearControlQueueOnStartup: true,
  });

  assertEquals(processedRequestIds, ["req-startup-stop", "req-live-stop"]);
  assertEquals(exportCalls, 0);
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

  const tempDir = await makeTestTempDir("daemon-runtime-exports-");

  try {
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
      exportsLogPath: join(tempDir, "exports.jsonl"),
    });

    const exportsLines =
      (await Deno.readTextFile(join(tempDir, "exports.jsonl")))
        .trim()
        .split("\n");
    assertEquals(exportsLines.length, 1);
    const entry = JSON.parse(exportsLines[0]!) as {
      requestId: string;
      status: string;
      provider: string;
    };
    assertEquals(entry.requestId, "req-export");
    assertEquals(entry.status, "succeeded");
    assertEquals(entry.provider, "unknown");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }

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

Deno.test("runDaemonRuntimeLoop applies in-chat ::record-<alias> commands from newly ingested messages", async () => {
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
  const inChatCommandDir = makeTestTempPath("in-chat-record-commands-");
  const oldPath = join(inChatCommandDir, "old.md");
  const newPath = join(inChatCommandDir, "new.md");
  await removeDirIfPresent(inChatCommandDir);
  await Deno.mkdir(inChatCommandDir, { recursive: true });
  try {
    const workspace = await createTestWorkspaceFixture(inChatCommandDir);
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
          `::record-${TEST_WORKSPACE_ALIAS} ${oldPath}\nold command`,
          "2026-02-22T09:59:59.000Z",
        );
        const newCommandMessage = makeEvent(
          "m2",
          "message.user",
          `::record-${TEST_WORKSPACE_ALIAS} ${newPath}\nnew command`,
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

    const activatedTargets: string[] = [];
    const activatedRecordingIds: string[] = [];
    const appendedMessageIds: string[] = [];
    let activeRecording = false;
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording(input) {
        activeRecording = true;
        activatedTargets.push(input.targetPath);
        const recordingId = input.recordingId ?? "rec-1";
        activatedRecordingIds.push(recordingId);
        const nowIso = "2026-02-22T10:00:01.000Z";
        return Promise.resolve({
          recordingId,
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
        if (!activeRecording || input.recordingKey !== TEST_WORKSPACE_ID) {
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
      workspaceCatalog: workspace.workspaceCatalog,
      workspaceProfileResolver: workspace.workspaceProfileResolver,
    });

    assertEquals(activatedTargets, [newPath]);
    assertEquals(activatedRecordingIds.length, 1);
    assert(activatedRecordingIds[0].length > 0);
    assertEquals(appendedMessageIds, ["m2", "m3"]);
  } finally {
    await removeDirIfPresent(inChatCommandDir);
  }
});

Deno.test("runDaemonRuntimeLoop in-chat dedupe keeps distinct same-content events when ids are missing but cursors differ", async () => {
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
  const inChatCommandDir = makeTestTempPath("in-chat-dedupe-cursor-");
  const path = join(inChatCommandDir, "active.md");
  await removeDirIfPresent(inChatCommandDir);
  await Deno.mkdir(inChatCommandDir, { recursive: true });
  try {
    const workspace = await createTestWorkspaceFixture(inChatCommandDir);
    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        const baselineCommand = makeEvent(
          "m1",
          "message.user",
          `::record-${TEST_WORKSPACE_ALIAS} ${path}`,
          "2026-02-22T10:00:00.000Z",
        );
        const sameContentA: ConversationEvent = {
          eventId: "m2",
          provider: "codex",
          sessionId: "session-1",
          timestamp: "2026-02-22T10:00:01.000Z",
          kind: "message.assistant",
          role: "assistant",
          content: "same-content",
          source: {
            providerEventType: "assistant",
            rawCursor: { kind: "byte-offset", value: 20 },
          },
        } as ConversationEvent;
        const sameContentB: ConversationEvent = {
          eventId: "m3",
          provider: "codex",
          sessionId: "session-1",
          timestamp: "2026-02-22T10:00:01.000Z",
          kind: "message.assistant",
          role: "assistant",
          content: "same-content",
          source: {
            providerEventType: "assistant",
            rawCursor: { kind: "byte-offset", value: 21 },
          },
        } as ConversationEvent;

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-1",
            cursor: { kind: "byte-offset", value: 10 },
            events: [baselineCommand],
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
            cursor: { kind: "byte-offset", value: 30 },
            events: [baselineCommand, sameContentA, sameContentB],
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
      requestId: "req-stop-dedupe-cursor",
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

    const appendedMessageIds: string[] = [];
    let activeRecording = false;
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording(input) {
        activeRecording = true;
        const nowIso = "2026-02-22T10:00:00.000Z";
        return Promise.resolve({
          recordingId: input.recordingId ?? "rec-dedupe",
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
        if (!activeRecording || input.recordingKey !== TEST_WORKSPACE_ID) {
          return Promise.resolve({ appended: false, deduped: false });
        }
        for (const event of input.events) {
          appendedMessageIds.push(event.eventId);
        }
        return Promise.resolve({ appended: true, deduped: false });
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
      workspaceCatalog: workspace.workspaceCatalog,
      workspaceProfileResolver: workspace.workspaceProfileResolver,
    });

    assertEquals(appendedMessageIds, ["m1", "m2", "m3"]);
  } finally {
    await removeDirIfPresent(inChatCommandDir);
  }
});

Deno.test("runDaemonRuntimeLoop applies in-chat ::capture-<alias> and activates recording", async () => {
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
  const workspace = await createTestWorkspaceFixture(
    makeTestTempPath("runtime-live-capture-"),
  );

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
        `::capture-${TEST_WORKSPACE_ALIAS} ${DAEMON_RUNTIME_CAPTURE_PATH}\ncapture now`,
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
  const captureRecordingCycleIds: string[][] = [];
  const activatedTargets: string[] = [];
  const activatedRecordingIds: Array<string | undefined> = [];
  const appendedMessageIds: string[] = [];
  let activeRecording = false;
  let activeRecordingKey: string | undefined;
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording(input) {
      callOrder.push("record");
      activeRecording = true;
      activeRecordingKey = input.recordingKey;
      activatedTargets.push(input.targetPath);
      activatedRecordingIds.push(input.recordingId);
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
      captureRecordingCycleIds.push(input.recordingCycleIds ?? []);
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
      if (!activeRecording || input.recordingKey !== activeRecordingKey) {
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
    stopRecording(_provider, _sessionId, recordingKey) {
      if (recordingKey && recordingKey !== activeRecordingKey) {
        return false;
      }
      activeRecording = false;
      activeRecordingKey = undefined;
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
    workspaceCatalog: workspace.workspaceCatalog,
    workspaceProfileResolver: workspace.workspaceProfileResolver,
  });

  assertEquals(callOrder, ["capture", "record"]);
  assertEquals(captureTargets.length, 1);
  assertEquals(
    toPosixPath(captureTargets[0] ?? ""),
    toPosixPath(DAEMON_RUNTIME_CAPTURE_PATH),
  );
  assertEquals(captureRecordingCycleIds.length, 1);
  assertEquals(captureRecordingCycleIds[0]?.length, 1);
  assertEquals(activatedTargets.length, 1);
  assertEquals(
    toPosixPath(activatedTargets[0] ?? ""),
    toPosixPath(DAEMON_RUNTIME_CAPTURE_PATH),
  );
  assertEquals(activatedRecordingIds.length, 1);
  assertEquals(activatedRecordingIds[0], captureRecordingCycleIds[0]?.[0]);
  assertEquals(appendedMessageIds, ["m2", "m3"]);
});

Deno.test(
  "runDaemonRuntimeLoop applies in-chat ::capture-<alias> on first seen snapshot when the event is newer than daemon start",
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
    const workspace = await createTestWorkspaceFixture(
      makeTestTempPath("runtime-first-seen-capture-"),
    );

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
                `::capture-${TEST_WORKSPACE_ALIAS} ${DAEMON_RUNTIME_FIRST_SEEN_CAPTURE_PATH}`,
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
    const activatedTargets: string[] = [];
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording(input) {
        callOrder.push("record");
        activatedTargets.push(input.targetPath);
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
      workspaceCatalog: workspace.workspaceCatalog,
      workspaceProfileResolver: workspace.workspaceProfileResolver,
    });

    assertEquals(callOrder, ["capture", "record"]);
    assertEquals(captureTargets.length, 1);
    assertEquals(
      toPosixPath(captureTargets[0] ?? ""),
      toPosixPath(DAEMON_RUNTIME_FIRST_SEEN_CAPTURE_PATH),
    );
    assertEquals(activatedTargets.length, 1);
    assertEquals(
      toPosixPath(activatedTargets[0] ?? ""),
      toPosixPath(DAEMON_RUNTIME_FIRST_SEEN_CAPTURE_PATH),
    );
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
    const workspace = await createTestWorkspaceFixture(
      makeTestTempPath("runtime-prestart-capture-"),
    );

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
                `::capture-${TEST_WORKSPACE_ALIAS} notes/old-command.md`,
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
      activateRecording() {
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
      workspaceCatalog: workspace.workspaceCatalog,
      workspaceProfileResolver: workspace.workspaceProfileResolver,
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
  const workspace = await createTestWorkspaceFixture(
    makeTestTempPath("runtime-parse-error-"),
  );

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
        `::export\n::record-${TEST_WORKSPACE_ALIAS} notes/should-not-run.md`,
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

  let activateCalls = 0;
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      activateCalls += 1;
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
    workspaceCatalog: workspace.workspaceCatalog,
    workspaceProfileResolver: workspace.workspaceProfileResolver,
  });

  assertEquals(activateCalls, 0);
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
  const stateDir = await makeTestTempDir("daemon-runtime-persistent-");
  try {
    const workspace = await createTestWorkspaceFixture(stateDir);
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
    const persistentDestination = join(stateDir, "persistent-recording.md");

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
          `::record-${TEST_WORKSPACE_ALIAS} ${persistentDestination}`,
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
      activateRecording() {
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
      workspaceCatalog: workspace.workspaceCatalog,
      workspaceProfileResolver: workspace.workspaceProfileResolver,
    });

    assertEquals(appendCalls, [1, 1]);
    const metadataList = await sessionStateStore.listSessionMetadata();
    assertEquals(metadataList.length, 1);
    const output = findWorkspaceOutputState(metadataList[0]!);
    assertEquals(output.currentResolvedPath, persistentDestination);
    assertEquals(output.desiredState, "off");
    assertEquals(output.writeCursor, 2);
    assertEquals(output.recordingCycles.length, 1);
    assertEquals(output.recordingCycles[0]?.stoppedCursor, 3);

    const lastStatus = statusHistory[statusHistory.length - 1];
    assertExists(lastStatus);
    const session = lastStatus.sessions?.[0];
    assertExists(session);
    assertEquals(session?.providerSessionId, "session-persist");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop captures from twin start when snapshot is truncated", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-capture-twin-start-");

  try {
    const workspace = await createTestWorkspaceFixture(stateDir);
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
      retention: {
        maxSessions: 200,
        maxEventsPerSession: 2,
      },
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-capture-twin-start-1234",
    });

    const provider = "codex";
    const providerSessionId = "session-capture-twin-start";
    const makeLocalEvent = (
      id: string,
      kind: "message.user" | "message.assistant",
      content: string,
      timestamp: string,
    ): ConversationEvent => ({
      eventId: id,
      provider,
      sessionId: providerSessionId,
      timestamp,
      kind,
      role: kind === "message.user" ? "user" : "assistant",
      content,
      source: {
        providerEventType: kind === "message.user" ? "user" : "assistant",
        providerEventId: id,
      },
    } as ConversationEvent);

    const firstUserMessage = makeLocalEvent(
      "u-history-1",
      "message.user",
      "early context",
      "2026-02-22T10:00:00.000Z",
    );
    const firstAssistantMessage = makeLocalEvent(
      "a-history-1",
      "message.assistant",
      "early reply",
      "2026-02-22T10:00:01.000Z",
    );
    const captureCommand = makeLocalEvent(
      "u-capture-tail",
      "message.user",
      `::capture-${TEST_WORKSPACE_ALIAS} ${DAEMON_RUNTIME_CAPTURE_FROM_TWIN_PATH}`,
      "2026-02-22T10:00:02.000Z",
    );
    const fullConversation = [
      firstUserMessage,
      firstAssistantMessage,
      captureCommand,
    ];

    const metadata = await sessionStateStore.getOrCreateSessionMetadata({
      provider,
      providerSessionId,
      sourceFilePath: DAEMON_RUNTIME_MOCK_SOURCE_PATH,
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    const twinEvents = mapConversationEventsToTwin({
      provider,
      providerSessionId,
      sessionId: metadata.sessionId,
      events: fullConversation,
      mode: "live",
      capturedAt: "2026-02-22T10:00:03.000Z",
    });
    await sessionStateStore.appendTwinEvents(metadata, twinEvents);

    sessionSnapshotStore.upsert({
      provider,
      sessionId: providerSessionId,
      cursor: { kind: "byte-offset", value: 3 },
      events: fullConversation,
    });

    const requests = [{
      requestId: "req-stop-capture-from-twin-start",
      requestedAt: "2026-02-22T10:00:05.000Z",
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

    let capturedSummary: Array<{ kind: string; content?: string }> = [];
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        throw new Error("not used");
      },
      captureSnapshot(input) {
        capturedSummary = input.events.map((event) => {
          if (
            event.kind === "message.user" ||
            event.kind === "message.assistant" ||
            event.kind === "message.system" ||
            event.kind === "thinking" ||
            event.kind === "provider.info"
          ) {
            return { kind: event.kind, content: event.content };
          }
          return { kind: event.kind };
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
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      appendToDestination() {
        return Promise.resolve({
          mode: "append",
          outputPath: DAEMON_RUNTIME_CAPTURE_FROM_TWIN_PATH,
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
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
      workspaceCatalog: workspace.workspaceCatalog,
      workspaceProfileResolver: workspace.workspaceProfileResolver,
    });

    assertEquals(capturedSummary, [
      { kind: "message.user", content: "early context" },
      { kind: "message.assistant", content: "early reply" },
      {
        kind: "message.user",
        content:
          `::capture-${TEST_WORKSPACE_ALIAS} ${DAEMON_RUNTIME_CAPTURE_FROM_TWIN_PATH}`,
      },
    ]);
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

Deno.test("runDaemonRuntimeLoop caches session metadata lookups between refresh intervals", async () => {
  let metadataReads = 0;
  let controlPolls = 0;
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: { activeRecordings: 0, destinations: 0 },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      controlPolls += 1;
      if (controlPolls >= 5) {
        return Promise.resolve([{
          requestId: "req-stop-cache-test",
          requestedAt: "2026-02-22T10:00:00.000Z",
          command: "stop" as const,
        }]);
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called");
    },
    markProcessed(_requestId: string) {
      return Promise.resolve();
    },
  };
  const sessionStateStore = {
    listSessionMetadata() {
      metadataReads += 1;
      return Promise.resolve([]);
    },
  } as unknown as PersistentSessionStateStore;

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionStateStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 1,
    sessionMetadataRefreshIntervalMs: 10_000,
  });

  assert(controlPolls >= 5);
  assertEquals(metadataReads, 3);
});

Deno.test("runDaemonRuntimeLoop treats ::stop with an argument as a parse error and leaves state unchanged", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-ambiguous-stop-");
  try {
    const workspace = await createTestWorkspaceFixture(stateDir);
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
      sourceFilePath: DAEMON_RUNTIME_MOCK_SESSION_PATH,
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    metadata.workspaceOutputs = [
      makeWorkspaceOutputState(workspace, {
        currentResolvedPath: DAEMON_RUNTIME_OTHER_DESTINATION_PATH,
        desiredState: "on",
        activeRecordingCycleId: "deadbeef-1111-1111-1111-111111111111",
        recordingCycles: [{
          recordingCycleId: "deadbeef-1111-1111-1111-111111111111",
          startedCursor: 0,
        }],
      }),
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
      activateRecording() {
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
      item!.workspaceOutputs?.map((output) => output.desiredState),
      ["on"],
    );
    assert(
      sink.records.some((record) =>
        record.event === "recording.command.parse_error" &&
        record.channel === "operational"
      ),
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop initializes missing session metadata from default cursor", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-default-cursor-");
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
      activateRecording() {
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
