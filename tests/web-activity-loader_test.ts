import { assertEquals, assertExists } from "@std/assert";
import { basename, join } from "@std/path";
import {
  createDefaultSharedBehaviorConfig,
  createDefaultUserConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  PersistentSessionStateStore,
  resolveDefaultSharedConfigPath,
  resolveDefaultUserConfigPath,
  resolveDefaultWorkspaceRegistryPath,
  SharedBehaviorConfigFileStore,
  UserConfigFileStore,
  WorkspaceRegistryFileStore,
} from "../apps/runtime/src/mod.ts";
import { loadRecordingsPageData } from "../apps/web/src/loaders/recordings.ts";
import { loadSessionsPageData } from "../apps/web/src/loaders/sessions.ts";
import { loadWorkspacesPageData } from "../apps/web/src/loaders/workspaces.ts";
import { withLockedEnvironment } from "./test_env.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

function makeWorkspaceOutput(options: {
  workspaceId: string;
  workspaceAlias: string;
  workspaceRoot: string;
  configPath: string;
  resolvedPath: string;
  relativePathHint?: string;
  desiredState: "on" | "off";
  activeRecordingCycleId?: string;
  recordingCycles: Array<{
    recordingCycleId: string;
    startedCursor: number;
    stoppedCursor?: number;
    startedAt?: string;
    stoppedAt?: string;
    startedBySeq?: number;
    stoppedBySeq?: number;
  }>;
}) {
  return {
    workspaceId: options.workspaceId,
    workspaceAliasSnapshot: options.workspaceAlias,
    desiredState: options.desiredState,
    currentDestination: {
      kind: "workspace-relative" as const,
      relativePathFromWorkspaceRoot: options.relativePathHint ??
        `notes/${basename(options.resolvedPath)}`,
    },
    currentResolvedPath: options.resolvedPath,
    sourceConfigPath: options.configPath,
    workspaceRootSnapshot: options.workspaceRoot,
    resolvedDefaultOutputDir: join(options.workspaceRoot, "notes"),
    filenameTemplate: "{provider}.md",
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(),
    ...(options.activeRecordingCycleId
      ? { activeRecordingCycleId: options.activeRecordingCycleId }
      : {}),
    writeCursor: 1,
    createdAt: "2026-03-07T15:00:00.000Z",
    recordingCycles: options.recordingCycles.map((cycle) => ({ ...cycle })),
  };
}

async function createSessionFixture(options: {
  katoDir: string;
  sessionId: string;
  providerSessionId: string;
  snippet: string;
  updatedAt: string;
  sourceFilePath: string;
  workspaceOutputs?: ReturnType<typeof makeWorkspaceOutput>[];
  lastObservedMtimeMs?: number;
  nextTwinSeq?: number;
  commandCursor?: number;
}) {
  const store = new PersistentSessionStateStore({
    katoDir: options.katoDir,
    now: () => new Date("2026-03-07T16:00:00.000Z"),
    makeSessionId: () => options.sessionId,
  });
  const metadata = await store.getOrCreateSessionMetadata({
    provider: "codex",
    providerSessionId: options.providerSessionId,
    sourceFilePath: options.sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  metadata.snippet = options.snippet;
  metadata.updatedAt = options.updatedAt;
  metadata.workspaceOutputs = options.workspaceOutputs;
  metadata.lastObservedMtimeMs = options.lastObservedMtimeMs;
  if (options.nextTwinSeq !== undefined) {
    metadata.nextTwinSeq = options.nextTwinSeq;
  }
  if (options.commandCursor !== undefined) {
    metadata.commandCursor = options.commandCursor;
  }
  await store.saveSessionMetadata(metadata);
}

Deno.test("loadSessionsPageData integrates live sessions with persistent recording history", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-activity-sessions-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const statusPath = join(katoDir, "shared", "status.json");
        const alphaRoot = join(homeDir, "alpha");
        const betaRoot = join(homeDir, "beta");
        const alphaConfigPath = join(
          alphaRoot,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        const betaConfigPath = join(
          betaRoot,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.mkdir(alphaRoot, { recursive: true });
        await Deno.mkdir(betaRoot, { recursive: true });
        await Deno.writeTextFile(alphaConfigPath, "workspaceId: ws-alpha\n");
        await Deno.writeTextFile(betaConfigPath, "workspaceId: ws-beta\n");

        const alphaOutputPath = join(alphaRoot, "notes", "alpha.md");
        const betaOutputPath = join(betaRoot, "notes", "beta.md");
        const sessionFixturesDir = join(homeDir, "session-fixtures");

        await createSessionFixture({
          katoDir,
          sessionId: "sess-live",
          providerSessionId: "provider-live",
          snippet: "live session",
          updatedAt: "2026-03-07T15:59:00.000Z",
          sourceFilePath: join(sessionFixturesDir, "provider-live.jsonl"),
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: alphaOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-live",
              recordingCycles: [{
                recordingCycleId: "cycle-live",
                startedCursor: 5,
                startedAt: "2026-03-07T15:30:00.000Z",
                startedBySeq: 5,
              }],
            }),
          ],
        });

        await createSessionFixture({
          katoDir,
          sessionId: "sess-stale",
          providerSessionId: "provider-stale",
          snippet: "stale session",
          updatedAt: "2026-03-07T14:00:00.000Z",
          sourceFilePath: join(sessionFixturesDir, "provider-stale.jsonl"),
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-beta",
              workspaceAlias: "beta",
              workspaceRoot: betaRoot,
              configPath: betaConfigPath,
              resolvedPath: betaOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-stale",
              recordingCycles: [{
                recordingCycleId: "cycle-old",
                startedCursor: 1,
                stoppedCursor: 3,
                startedAt: "2026-03-07T13:00:00.000Z",
                stoppedAt: "2026-03-07T13:30:00.000Z",
                startedBySeq: 1,
                stoppedBySeq: 3,
              }, {
                recordingCycleId: "cycle-stale",
                startedCursor: 4,
                startedAt: "2026-03-07T13:45:00.000Z",
                startedBySeq: 4,
              }],
            }),
          ],
        });

        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-07T16:00:00.000Z",
            heartbeatAt: "2026-03-07T16:00:00.000Z",
            daemonRunning: true,
            providers: [{
              provider: "codex",
              activeSessions: 1,
              lastEventAt: "2026-03-07T15:59:30.000Z",
            }],
            recordings: {
              activeRecordings: 1,
              destinations: 1,
            },
            sessions: [{
              provider: "codex",
              sessionId: "sess-live",
              providerSessionId: "provider-live",
              updatedAt: "2026-03-07T15:59:30.000Z",
              lastEventAt: "2026-03-07T15:59:30.000Z",
              stale: false,
              snippet: "live session",
              recordings: [{
                workspaceAlias: "alpha",
                outputPath: alphaOutputPath,
                startedAt: "2026-03-07T15:30:00.000Z",
                lastWriteAt: "2026-03-07T15:59:30.000Z",
              }],
            }],
          }),
        );

        const data = await loadSessionsPageData();

        assertEquals(data.sessionCount, 2);
        assertEquals(data.activeSessionCount, 1);
        assertEquals(data.staleSessionCount, 1);
        assertEquals(data.inactiveSessionCount, 0);
        assertEquals(data.activeRecordingCount, 1);
        assertEquals(data.staleRecordingCount, 1);
        assertEquals(data.stoppedRecordingCount, 0);
        assertEquals(data.rows[0]?.sessionId, "sess-live");
        assertEquals(data.rows[0]?.state, "active");
        assertEquals(data.rows[0]?.recordings[0]?.state, "engaged-active");
        assertEquals(
          data.rows[0]?.recordings[0]?.displayOutputPath,
          "notes/alpha.md",
        );
        assertEquals(
          data.rows[0]?.recordings[0]?.lastWriteAt,
          "2026-03-07T15:59:30.000Z",
        );
        assertEquals(data.rows[1]?.sessionId, "sess-stale");
        assertEquals(data.rows[1]?.state, "stale");
        assertEquals(data.rows[1]?.recordings.length, 1);
        assertEquals(data.rows[1]?.recordings[0]?.state, "engaged-stale");
        assertEquals(
          data.rows[1]?.recordings[0]?.displayOutputPath,
          "notes/beta.md",
        );
        assertEquals(
          data.rows[1]?.recordings[0]?.workspaceHref,
          "/workspaces#workspace-ws-beta",
        );

        const filtered = await loadSessionsPageData({
          workspaceFilter: "ws-beta",
        });
        assertEquals(filtered.sessionCount, 1);
        assertEquals(filtered.activeRecordingCount, 0);
        assertEquals(filtered.staleRecordingCount, 1);
        assertEquals(filtered.stoppedRecordingCount, 0);
        assertEquals(filtered.rows[0]?.sessionId, "sess-stale");
        assertEquals(filtered.rows[0]?.activeRecordingCount, 0);
        assertEquals(filtered.rows[0]?.staleRecordingCount, 1);
        assertEquals(filtered.rows[0]?.stoppedRecordingCount, 0);
        assertEquals(filtered.rows[0]?.recordings.length, 1);
        assertEquals(
          filtered.rows[0]?.recordings.map((recording) =>
            recording.workspaceId
          ),
          ["ws-beta"],
        );

        const recordings = await loadRecordingsPageData();
        assertEquals(recordings.activeRecordingCount, 1);
        assertEquals(recordings.staleRecordingCount, 1);
        assertEquals(recordings.stoppedRecordingCount, 1);
        assertEquals(recordings.rows.length, 3);
        assertEquals(recordings.rows[2]?.state, "stopped");
        assertEquals(recordings.rows[2]?.recordingCycleId, "cycle-old");
        assertEquals(recordings.rows[2]?.displayOutputPath, "notes/beta.md");

        const staleRecordings = await loadRecordingsPageData({
          stateFilter: "engaged-stale",
        });
        assertEquals(staleRecordings.activeRecordingCount, 1);
        assertEquals(staleRecordings.staleRecordingCount, 1);
        assertEquals(staleRecordings.stoppedRecordingCount, 1);
        assertEquals(staleRecordings.rows.length, 1);
        assertEquals(
          staleRecordings.rows[0]?.displayOutputPath,
          "notes/beta.md",
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadWorkspacesPageData groups recordings by workspace and links back to sessions", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-activity-workspaces-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const statusPath = join(katoDir, "shared", "status.json");
        const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
        const sharedConfigPath = resolveDefaultSharedConfigPath(katoDir);
        const alphaRoot = join(homeDir, "alpha");
        const betaRoot = join(homeDir, "beta");
        const alphaConfigPath = join(
          alphaRoot,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        const betaConfigPath = join(
          betaRoot,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.mkdir(alphaRoot, { recursive: true });
        await Deno.mkdir(betaRoot, { recursive: true });
        await Deno.writeTextFile(alphaConfigPath, "workspaceId: ws-alpha\n");
        await Deno.writeTextFile(betaConfigPath, "workspaceId: ws-beta\n");

        const registry = new WorkspaceRegistryFileStore(registryPath);
        await registry.save([
          {
            workspaceId: "ws-alpha",
            alias: "alpha",
            workspaceRoot: alphaRoot,
            configPath: alphaConfigPath,
            registeredAt: "2026-03-07T15:00:00.000Z",
          },
          {
            workspaceId: "ws-beta",
            alias: "beta",
            workspaceRoot: betaRoot,
            configPath: betaConfigPath,
            registeredAt: "2026-03-07T15:05:00.000Z",
          },
        ]);

        const sharedConfigStore = new SharedBehaviorConfigFileStore(
          sharedConfigPath,
        );
        const sharedConfig = createDefaultSharedBehaviorConfig({
          allowedWriteRoots: [alphaRoot, betaRoot],
        });
        await sharedConfigStore.save(sharedConfig);
        const userConfigStore = new UserConfigFileStore(
          resolveDefaultUserConfigPath(),
        );
        await userConfigStore.save(
          createDefaultUserConfig({
            workspaceUsernames: {
              "ws-beta": "beta-user",
            },
          }),
        );

        const alphaOutputPath = join(alphaRoot, "notes", "alpha.md");
        const betaOutputPath = join(betaRoot, "notes", "beta.md");
        const sessionFixturesDir = join(homeDir, "session-fixtures");

        await createSessionFixture({
          katoDir,
          sessionId: "sess-mixed",
          providerSessionId: "provider-mixed",
          snippet: "workspace-linked session",
          updatedAt: "2026-03-07T15:59:00.000Z",
          sourceFilePath: join(sessionFixturesDir, "provider-mixed.jsonl"),
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: alphaOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-live",
              recordingCycles: [{
                recordingCycleId: "cycle-live",
                startedCursor: 5,
                startedAt: "2026-03-07T15:30:00.000Z",
                startedBySeq: 5,
              }],
            }),
            makeWorkspaceOutput({
              workspaceId: "ws-beta",
              workspaceAlias: "beta",
              workspaceRoot: betaRoot,
              configPath: betaConfigPath,
              resolvedPath: betaOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-stale",
              recordingCycles: [{
                recordingCycleId: "cycle-stopped",
                startedCursor: 1,
                stoppedCursor: 2,
                startedAt: "2026-03-07T14:00:00.000Z",
                stoppedAt: "2026-03-07T14:30:00.000Z",
                startedBySeq: 1,
                stoppedBySeq: 2,
              }, {
                recordingCycleId: "cycle-stale",
                startedCursor: 3,
                startedAt: "2026-03-07T14:45:00.000Z",
                startedBySeq: 3,
              }],
            }),
          ],
        });

        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-07T16:00:00.000Z",
            heartbeatAt: "2026-03-07T16:00:00.000Z",
            daemonRunning: true,
            providers: [{
              provider: "codex",
              activeSessions: 1,
              lastEventAt: "2026-03-07T15:59:30.000Z",
            }],
            recordings: {
              activeRecordings: 1,
              destinations: 1,
            },
            sessions: [{
              provider: "codex",
              sessionId: "sess-mixed",
              providerSessionId: "provider-mixed",
              updatedAt: "2026-03-07T15:59:30.000Z",
              lastEventAt: "2026-03-07T15:59:30.000Z",
              stale: false,
              snippet: "workspace-linked session",
              recordings: [{
                workspaceAlias: "alpha",
                outputPath: alphaOutputPath,
                startedAt: "2026-03-07T15:30:00.000Z",
                lastWriteAt: "2026-03-07T15:59:30.000Z",
              }],
            }],
          }),
        );

        const data = await loadWorkspacesPageData();

        const alphaRow = data.rows.find((row) =>
          row.workspaceId === "ws-alpha"
        );
        const betaRow = data.rows.find((row) => row.workspaceId === "ws-beta");
        assertExists(alphaRow);
        assertExists(betaRow);
        assertEquals(alphaRow.activeRecordingCount, 1);
        assertEquals(alphaRow.staleRecordingCount, 0);
        assertEquals(alphaRow.stoppedRecordingCount, 0);
        assertEquals(alphaRow.writePathCovered, true);
        assertEquals(
          alphaRow.recordings[0]?.displayOutputPath,
          "notes/alpha.md",
        );
        assertEquals(betaRow.activeRecordingCount, 1);
        assertEquals(betaRow.staleRecordingCount, 0);
        assertEquals(betaRow.stoppedRecordingCount, 0);
        assertEquals(betaRow.writePathCovered, true);
        assertEquals(betaRow.workspaceUsername, "beta-user");
        assertEquals(alphaRow.recordings[0]?.sessionId, "sess-mixed");
        assertEquals(betaRow.recordings[0]?.state, "engaged-active");
        assertEquals(betaRow.recordings.length, 1);
        assertEquals(betaRow.recordings[0]?.displayOutputPath, "notes/beta.md");
        assertEquals(
          alphaRow.recordings[0]?.sessionLink,
          "/ingestion?workspace=ws-alpha#session-sess-mixed",
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSessionsPageData handles ingestion continuation and recording fallbacks", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-activity-fallbacks-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const statusPath = join(katoDir, "shared", "status.json");
        const gammaRoot = join(homeDir, "gamma");
        const gammaConfigPath = join(
          gammaRoot,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        const externalDir = join(homeDir, "external");
        const continuationSourcePath = join(externalDir, "continuation.jsonl");
        const continuationOutputPath = join(externalDir, "continuation.md");
        const stoppedOutputPath = join(gammaRoot, "notes", "stopped.md");
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.mkdir(join(gammaRoot, "notes"), { recursive: true });
        await Deno.mkdir(externalDir, { recursive: true });
        await Deno.writeTextFile(gammaConfigPath, "workspaceId: ws-gamma\n");
        await Deno.writeTextFile(continuationSourcePath, "[]\n");
        const lastObservedAt = new Date("2026-03-07T16:00:00.000Z");
        const refreshedAt = new Date("2026-03-07T16:05:00.000Z");
        await Deno.utime(
          continuationSourcePath,
          refreshedAt,
          refreshedAt,
        );

        await createSessionFixture({
          katoDir,
          sessionId: "sess-continue",
          providerSessionId: "provider-continue",
          snippet: "needs continuation",
          updatedAt: "2026-03-07T15:59:00.000Z",
          sourceFilePath: continuationSourcePath,
          lastObservedMtimeMs: lastObservedAt.getTime(),
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-gamma",
              workspaceAlias: "gamma",
              workspaceRoot: gammaRoot,
              configPath: gammaConfigPath,
              resolvedPath: continuationOutputPath,
              relativePathHint: "../escape.md",
              desiredState: "on",
              recordingCycles: [{
                recordingCycleId: "cycle-older",
                startedCursor: 1,
                stoppedCursor: 2,
                startedAt: "2026-03-07T14:00:00.000Z",
                stoppedAt: "2026-03-07T14:30:00.000Z",
                startedBySeq: 1,
                stoppedBySeq: 2,
              }],
            }),
          ],
        });

        await createSessionFixture({
          katoDir,
          sessionId: "sess-stopped",
          providerSessionId: "provider-stopped",
          snippet: "stopped output",
          updatedAt: "2026-03-07T15:00:00.000Z",
          sourceFilePath: join(externalDir, "missing-source.jsonl"),
          lastObservedMtimeMs: lastObservedAt.getTime(),
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-gamma",
              workspaceAlias: "gamma",
              workspaceRoot: gammaRoot,
              configPath: gammaConfigPath,
              resolvedPath: stoppedOutputPath,
              desiredState: "off",
              recordingCycles: [{
                recordingCycleId: "cycle-oldest",
                startedCursor: 1,
                stoppedCursor: 2,
                startedAt: "2026-03-07T12:00:00.000Z",
                stoppedAt: "2026-03-07T12:30:00.000Z",
                startedBySeq: 1,
                stoppedBySeq: 2,
              }, {
                recordingCycleId: "cycle-newest",
                startedCursor: 3,
                stoppedCursor: 4,
                startedAt: "2026-03-07T13:00:00.000Z",
                stoppedAt: "2026-03-07T13:30:00.000Z",
                startedBySeq: 3,
                stoppedBySeq: 4,
              }],
            }),
          ],
        });

        await createSessionFixture({
          katoDir,
          sessionId: "sess-legacy",
          providerSessionId: "provider-legacy",
          snippet: "legacy manual ingestion",
          updatedAt: "2026-03-07T14:00:00.000Z",
          sourceFilePath: join(externalDir, "legacy-source.jsonl"),
          nextTwinSeq: 2,
          commandCursor: 0,
        });

        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-07T16:00:00.000Z",
            heartbeatAt: "2026-03-07T16:00:00.000Z",
            daemonRunning: true,
            providers: [],
            recordings: {
              activeRecordings: 0,
              destinations: 0,
            },
            sessions: [],
          }),
        );

        const allSessions = await loadSessionsPageData();
        assertEquals(allSessions.sessionCount, 3);
        assertEquals(allSessions.activeSessionCount, 0);
        assertEquals(allSessions.staleSessionCount, 3);

        const continuationRow = allSessions.rows.find((row) =>
          row.sessionId === "sess-continue"
        );
        assertExists(continuationRow);
        assertEquals(continuationRow.ingestionAction, "continue");
        assertEquals(continuationRow.recordings.length, 1);
        assertEquals(continuationRow.recordings[0]?.state, "engaged-stale");
        assertEquals(
          continuationRow.recordings[0]?.displayOutputPath,
          continuationOutputPath,
        );

        const stoppedRow = allSessions.rows.find((row) =>
          row.sessionId === "sess-stopped"
        );
        assertExists(stoppedRow);
        assertEquals(stoppedRow.ingestionAction, "none");
        assertEquals(stoppedRow.recordings[0]?.state, "stopped");
        assertEquals(
          stoppedRow.recordings[0]?.recordingCycleId,
          "cycle-newest",
        );

        const legacyRow = allSessions.rows.find((row) =>
          row.sessionId === "sess-legacy"
        );
        assertExists(legacyRow);
        assertEquals(legacyRow.state, "stale");
        assertEquals(legacyRow.canOpenIngestView, true);
        assertEquals(legacyRow.ingestionAction, "none");

        const filtered = await loadSessionsPageData({
          workspaceFilter: "ws-gamma",
        });
        assertEquals(filtered.workspaceFilter, "ws-gamma");
        assertEquals(filtered.workspaceFilterId, "ws-gamma");
        assertEquals(filtered.workspaceFilterAlias, undefined);
        assertEquals(filtered.sessionCount, 2);
        assertEquals(
          filtered.rows.map((row) => row.sessionId),
          ["sess-continue", "sess-stopped"],
        );

        const recordings = await loadRecordingsPageData({
          workspaceFilter: "ws-gamma",
        });
        assertEquals(recordings.activeRecordingCount, 0);
        assertEquals(recordings.staleRecordingCount, 1);
        assertEquals(recordings.stoppedRecordingCount, 3);
        assertEquals(recordings.rows.length, 4);
        assertEquals(
          recordings.rows
            .filter((row) => row.sessionId === "sess-continue")
            .map((row) => row.state),
          ["engaged-stale", "stopped"],
        );
        assertEquals(
          recordings.rows
            .filter((row) => row.sessionId === "sess-stopped")
            .map((row) => row.recordingCycleId),
          ["cycle-newest", "cycle-oldest"],
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
