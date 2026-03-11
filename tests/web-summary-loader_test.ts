import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultRuntimeConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  PersistentSessionStateStore,
  resolveDefaultWorkspaceRegistryPath,
  RuntimeConfigFileStore,
  WorkspaceRegistryFileStore,
} from "../apps/runtime/src/mod.ts";
import {
  loadAppChromeStatus,
  loadSummaryPageData,
} from "../apps/web/src/loaders/status.ts";
import { withTestTempDir } from "./test_temp.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";

async function createSessionFixture(options: {
  katoDir: string;
  sessionId: string;
  providerSessionId: string;
  snippet: string;
  updatedAt: string;
  sourceFilePath: string;
  workspaceOutputs?: Array<{
    workspaceId: string;
    workspaceAliasSnapshot: string;
    desiredState: "on" | "off";
    currentResolvedPath: string;
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
  }>;
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
  metadata.workspaceOutputs = options.workspaceOutputs?.map((output) => ({
    workspaceId: output.workspaceId,
    workspaceAliasSnapshot: output.workspaceAliasSnapshot,
    desiredState: output.desiredState,
    currentDestination: {
      kind: "workspace-relative" as const,
      relativePathFromWorkspaceRoot: "notes/output.md",
    },
    currentResolvedPath: output.currentResolvedPath,
    sourceConfigPath: join(
      options.katoDir,
      `${output.workspaceId}-workspace-config.yaml`,
    ),
    workspaceRootSnapshot: join(options.katoDir, output.workspaceId),
    resolvedDefaultOutputDir: join(
      options.katoDir,
      output.workspaceId,
      "notes",
    ),
    filenameTemplate: "{provider}.md",
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(),
    ...(output.activeRecordingCycleId
      ? { activeRecordingCycleId: output.activeRecordingCycleId }
      : {}),
    writeCursor: 1,
    createdAt: "2026-03-07T15:00:00.000Z",
    recordingCycles: output.recordingCycles.map((cycle) => ({ ...cycle })),
  }));
  await store.saveSessionMetadata(metadata);
}

Deno.test("loadSummaryPageData reads the default shared status snapshot", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-summary-loader-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const statusPath = join(homeDir, ".kato", "shared", "status.json");
        const activeOutputAPath = join(homeDir, "outputs", "active-a.md");
        const activeOutputBPath = join(homeDir, "outputs", "active-b.md");
        await Deno.mkdir(join(homeDir, ".kato", "shared"), { recursive: true });
        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-07T16:00:00.000Z",
            heartbeatAt: "2026-03-07T16:00:00.000Z",
            daemonRunning: true,
            daemonPid: 4242,
            providers: [{
              provider: "codex",
              activeSessions: 1,
              lastEventAt: "2026-03-07T15:59:00.000Z",
            }],
            recordings: {
              activeRecordings: 2,
              destinations: 1,
            },
            sessions: [{
              provider: "codex",
              sessionId: "sess-001",
              updatedAt: "2026-03-07T15:59:00.000Z",
              lastEventAt: "2026-03-07T15:59:00.000Z",
              stale: false,
              snippet: "status summary",
              recordings: [{
                outputPath: activeOutputAPath,
                startedAt: "2026-03-07T15:30:00.000Z",
                lastWriteAt: "2026-03-07T15:59:00.000Z",
              }, {
                outputPath: activeOutputBPath,
                startedAt: "2026-03-07T15:35:00.000Z",
                lastWriteAt: "2026-03-07T15:59:00.000Z",
              }],
            }],
          }),
        );

        const data = await loadSummaryPageData({
          now: () => new Date("2026-03-07T16:00:02.000Z"),
        });

        assertEquals(data.daemon, "running");
        assertEquals(data.daemonPid, 4242);
        assertEquals(data.sessionCount, 1);
        assertEquals(data.generatingSessionCount, 1);
        assertEquals(data.staleGeneratingSessionCount, 0);
        assertEquals(data.inactiveSessionCount, 0);
        assertEquals(data.recordingCount, 2);
        assertEquals(data.staleRecordingCount, 0);
        assertEquals(data.stoppedRecordingCount, 0);
        assertEquals(data.providers.length, 1);
        assertEquals(data.sessions[0]?.sessionId, "sess-001");
        assertEquals(data.summarySessions.length, 1);
        assertEquals(data.summarySessions[0]?.sessionId, "sess-001");
        assertEquals(data.summarySessions[0]?.state, "active");
        assertEquals(data.stale, false);
        assertEquals(data.statusPath, statusPath);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSummaryPageData counts stale sessions from the full snapshot", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-summary-loader-stale-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const statusPath = join(katoDir, "shared", "status.json");
        const sessionFixturesDir = join(homeDir, "session-fixtures");
        const staleOutputAPath = join(homeDir, "outputs", "stale-a.md");
        const staleOutputBPath = join(homeDir, "outputs", "stale-b.md");
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await createSessionFixture({
          katoDir,
          sessionId: "sess-stale",
          providerSessionId: "provider-stale",
          snippet: "stale session",
          updatedAt: "2026-03-07T15:00:00.000Z",
          sourceFilePath: join(sessionFixturesDir, "provider-stale.jsonl"),
          workspaceOutputs: [{
            workspaceId: "ws-stale",
            workspaceAliasSnapshot: "stale",
            desiredState: "on",
            currentResolvedPath: staleOutputAPath,
            activeRecordingCycleId: "cycle-stale",
            recordingCycles: [{
              recordingCycleId: "cycle-old",
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
          }],
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
            sessions: [
              {
                provider: "codex",
                sessionId: "sess-active",
                updatedAt: "2026-03-07T15:59:00.000Z",
                lastEventAt: "2026-03-07T15:59:00.000Z",
                stale: false,
                snippet: "active session",
                recordings: [],
              },
              {
                provider: "codex",
                sessionId: "sess-stale",
                updatedAt: "2026-03-07T15:00:00.000Z",
                lastEventAt: "2026-03-07T15:00:00.000Z",
                stale: true,
                snippet: "stale session",
                recordings: [{
                  outputPath: staleOutputAPath,
                  startedAt: "2026-03-07T14:00:00.000Z",
                  lastWriteAt: "2026-03-07T15:00:00.000Z",
                }, {
                  outputPath: staleOutputBPath,
                  startedAt: "2026-03-07T14:15:00.000Z",
                  lastWriteAt: "2026-03-07T15:00:00.000Z",
                }],
              },
            ],
          }),
        );

        const data = await loadSummaryPageData({
          now: () => new Date("2026-03-07T16:00:02.000Z"),
        });

        assertEquals(data.sessionCount, 2);
        assertEquals(data.activeSessionCount, 1);
        assertEquals(data.staleSessionCount, 1);
        assertEquals(data.generatingSessionCount, 1);
        assertEquals(data.staleGeneratingSessionCount, 1);
        assertEquals(data.inactiveSessionCount, 0);
        assertEquals(data.recordingCount, 0);
        assertEquals(data.staleRecordingCount, 2);
        assertEquals(data.stoppedRecordingCount, 0);
        assertEquals(data.sessions.length, 1);
        assertEquals(data.sessions[0]?.sessionId, "sess-active");
        assertEquals(data.summarySessions.length, 2);
        assertEquals(data.summarySessions[0]?.sessionId, "sess-active");
        assertEquals(data.summarySessions[0]?.state, "active");
        assertEquals(data.summarySessions[1]?.sessionId, "sess-stale");
        assertEquals(data.summarySessions[1]?.state, "stale");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSummaryPageData merges daemon and web recent errors", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-summary-loader-errors-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const statusPath = join(katoDir, "shared", "status.json");
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.mkdir(join(katoDir, "daemon", "logs"), {
          recursive: true,
        });
        await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });

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

        await Deno.writeTextFile(
          join(katoDir, "daemon", "logs", "operational.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-07T15:59:00.000Z",
            level: "warn",
            channel: "operational",
            event: "daemon.test.warn",
            message: "daemon warning",
          }) + "\n",
        );
        await Deno.writeTextFile(
          join(katoDir, "web", "logs", "operational.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-07T16:00:01.000Z",
            level: "error",
            channel: "operational",
            event: "web.request.unhandled_error",
            message: "web request failed",
          }) + "\n",
        );

        const data = await loadSummaryPageData({
          now: () => new Date("2026-03-07T16:00:02.000Z"),
        });

        assertEquals(data.recentErrors.length, 2);
        assertEquals(data.recentErrors[0]?.scope, "web");
        assertEquals(
          data.recentErrors[0]?.event,
          "web.request.unhandled_error",
        );
        assertEquals(data.recentErrors[1]?.scope, "daemon");
        assertEquals(data.recentErrors[1]?.event, "daemon.test.warn");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSummaryPageData counts non-generating sessions as inactive", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-summary-loader-inactive-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const runtimeDir = join(katoDir, "daemon");
        const statusPath = join(katoDir, "shared", "status.json");
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.mkdir(runtimeDir, { recursive: true });

        const configStore = new RuntimeConfigFileStore(
          join(runtimeDir, "kato-daemon-config.yaml"),
        );
        await configStore.ensureInitialized(
          createDefaultRuntimeConfig({
            runtimeDir,
            katoDir,
            globalAutoGenerateSnapshots: false,
            providerAutoGenerateSnapshots: {
              claude: false,
              codex: false,
              gemini: false,
            },
          }),
        );

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
              lastEventAt: "2026-03-07T15:59:00.000Z",
            }],
            recordings: {
              activeRecordings: 0,
              destinations: 0,
            },
            sessions: [{
              provider: "codex",
              sessionId: "sess-inactive",
              updatedAt: "2026-03-07T15:59:00.000Z",
              lastEventAt: "2026-03-07T15:59:00.000Z",
              stale: false,
              snippet: "inactive session",
              recordings: [],
            }],
          }),
        );

        const data = await loadSummaryPageData({
          now: () => new Date("2026-03-07T16:00:02.000Z"),
        });

        assertEquals(data.generatingSessionCount, 0);
        assertEquals(data.staleGeneratingSessionCount, 0);
        assertEquals(data.inactiveSessionCount, 1);
        assertEquals(data.summarySessions.length, 1);
        assertEquals(data.summarySessions[0]?.sessionId, "sess-inactive");
        assertEquals(data.summarySessions[0]?.state, "inactive");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadAppChromeStatus distinguishes stale running snapshots from stopped daemons", async () => {
  const staleStatus = await loadAppChromeStatus({
    now: () => new Date("2026-03-07T16:00:30.000Z"),
    statusPath: join(".test-tmp", "status.json"),
    statusStore: {
      load: async () => ({
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
      save: async () => {},
    },
  });
  assertEquals(staleStatus.daemon, "running");
  assertEquals(staleStatus.snapshot, "stale");

  const stoppedStatus = await loadAppChromeStatus({
    now: () => new Date("2026-03-07T16:00:30.000Z"),
    statusPath: join(".test-tmp", "status.json"),
    statusStore: {
      load: async () => ({
        schemaVersion: 2,
        generatedAt: "2026-03-07T16:00:00.000Z",
        heartbeatAt: "not-a-timestamp",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
        sessions: [],
      }),
      save: async () => {},
    },
  });
  assertEquals(stoppedStatus.daemon, "stopped");
  assertEquals(stoppedStatus.snapshot, "current");
});

Deno.test("loadSummaryPageData reports workspace validation failures alongside active workspaces", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir(
        "web-summary-loader-workspaces-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const katoDir = join(homeDir, ".kato");
          const statusPath = join(katoDir, "shared", "status.json");
          const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
          const activeRoot = join(homeDir, "alpha");
          const mismatchRoot = join(homeDir, "beta");
          const missingRoot = join(homeDir, "ghost");
          const activeConfigPath = join(
            activeRoot,
            DEFAULT_WORKSPACE_CONFIG_FILENAME,
          );
          const mismatchConfigPath = join(
            mismatchRoot,
            DEFAULT_WORKSPACE_CONFIG_FILENAME,
          );
          const missingConfigPath = join(
            missingRoot,
            DEFAULT_WORKSPACE_CONFIG_FILENAME,
          );
          const activeOutputPath = join(activeRoot, "notes", "active.md");
          const sessionFixturesDir = join(homeDir, "session-fixtures");
          await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
          await Deno.mkdir(join(activeRoot, "notes"), { recursive: true });
          await Deno.mkdir(mismatchRoot, { recursive: true });
          await Deno.writeTextFile(
            activeConfigPath,
            "workspaceId: ws-active\n",
          );
          await Deno.writeTextFile(
            mismatchConfigPath,
            "workspaceId: ws-other\n",
          );

          const registry = new WorkspaceRegistryFileStore(registryPath);
          await registry.save([
            {
              workspaceId: "ws-active",
              alias: "alpha",
              workspaceRoot: activeRoot,
              configPath: activeConfigPath,
              registeredAt: "2026-03-07T15:00:00.000Z",
            },
            {
              workspaceId: "ws-mismatch",
              alias: "beta",
              workspaceRoot: mismatchRoot,
              configPath: mismatchConfigPath,
              registeredAt: "2026-03-07T15:05:00.000Z",
            },
            {
              workspaceId: "ws-missing",
              alias: "ghost",
              workspaceRoot: missingRoot,
              configPath: missingConfigPath,
              registeredAt: "2026-03-07T15:10:00.000Z",
            },
          ]);

          await createSessionFixture({
            katoDir,
            sessionId: "sess-active",
            providerSessionId: "provider-active",
            snippet: "workspace activity",
            updatedAt: "2026-03-07T15:59:00.000Z",
            sourceFilePath: join(sessionFixturesDir, "provider-active.jsonl"),
            workspaceOutputs: [{
              workspaceId: "ws-active",
              workspaceAliasSnapshot: "alpha",
              desiredState: "on",
              currentResolvedPath: activeOutputPath,
              activeRecordingCycleId: "cycle-live",
              recordingCycles: [{
                recordingCycleId: "cycle-live",
                startedCursor: 1,
                startedAt: "2026-03-07T15:30:00.000Z",
                startedBySeq: 1,
              }],
            }],
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
                activeRecordings: 1,
                destinations: 1,
              },
              sessions: [{
                provider: "codex",
                sessionId: "sess-active",
                updatedAt: "2026-03-07T15:59:30.000Z",
                lastEventAt: "2026-03-07T15:59:30.000Z",
                stale: false,
                snippet: "workspace activity",
                recordings: [{
                  outputPath: activeOutputPath,
                  startedAt: "2026-03-07T15:30:00.000Z",
                  lastWriteAt: "2026-03-07T15:59:30.000Z",
                }],
              }],
            }),
          );

          const data = await loadSummaryPageData({
            now: () => new Date("2026-03-07T16:00:02.000Z"),
          });

          assertEquals(data.workspaceSummary.activeCount, 1);
          assertEquals(data.workspaceSummary.staleCount, 0);
          assertEquals(data.workspaceSummary.inactiveCount, 0);
          assertEquals(data.workspaceSummary.invalidCount, 2);
          assertEquals(
            data.workspaceSummary.rows.map((row) => row.alias),
            ["alpha", "beta", "ghost"],
          );
          assertEquals(
            data.workspaceSummary.rows.find((row) =>
              row.workspaceId === "ws-active"
            )
              ?.valid,
            true,
          );
          assertEquals(
            data.workspaceSummary.rows.find((row) =>
              row.workspaceId === "ws-mismatch"
            )?.invalidReason,
            "workspaceId mismatch (registry=ws-mismatch, config=ws-other)",
          );
          assertEquals(
            data.workspaceSummary.rows.find((row) =>
              row.workspaceId === "ws-missing"
            )
              ?.invalidReason,
            "config file not found",
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSummaryPageData reports an invalid workspace registry as unavailable", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir(
        "web-summary-loader-registry-invalid-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const katoDir = join(homeDir, ".kato");
          const statusPath = join(katoDir, "shared", "status.json");
          const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
          await Deno.mkdir(join(homeDir, ".kato", "shared"), {
            recursive: true,
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
          await Deno.writeTextFile(
            registryPath,
            JSON.stringify({
              schemaVersion: 999,
              updatedAt: "2026-03-07T16:00:00.000Z",
              workspaces: [],
            }),
          );

          const data = await loadSummaryPageData({
            now: () => new Date("2026-03-07T16:00:02.000Z"),
          });

          assertEquals(
            data.workspaceSummary.unavailableReason,
            "Workspace registry has unsupported schema",
          );
          assertEquals(data.workspaceSummary.rows.length, 0);
          assertEquals(data.workspaceSummary.activeCount, 0);
          assertEquals(data.workspaceSummary.staleCount, 0);
          assertEquals(data.workspaceSummary.inactiveCount, 0);
          assertEquals(data.workspaceSummary.invalidCount, 0);
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
