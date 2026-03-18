import { assertEquals, assertExists } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  createDefaultRuntimeConfig,
  createDefaultSharedBehaviorConfig,
  createDefaultUserConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  PersistentSessionStateStore,
  resolveDefaultSharedConfigPath,
  resolveDefaultUserConfigPath,
  resolveDefaultWorkspaceRegistryPath,
  RuntimeConfigFileStore,
  SharedBehaviorConfigFileStore,
  UserConfigFileStore,
  WorkspaceRegistryFileStore,
} from "../apps/runtime/src/mod.ts";
import { LIVE_JSON_CACHE_CONTROL } from "../apps/web/src/api_response.ts";
import {
  getChromeStatusResponse,
  getLogsResponse,
  getMaintenanceTwinsResponse,
  getRecordingsResponse,
  getSessionSnippetResponse,
  getSessionsResponse,
  getSummaryResponse,
  getWorkspacesResponse,
} from "../apps/web/src/live_routes.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const CLAUDE_FIXTURE = join(THIS_DIR, "fixtures", "claude-session.jsonl");

function makeWorkspaceOutput(options: {
  workspaceId: string;
  workspaceAlias: string;
  workspaceRoot: string;
  configPath: string;
  resolvedPath: string;
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
      relativePathFromWorkspaceRoot: `notes/${
        options.resolvedPath.split(/[\\/]/).at(-1)
      }`,
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
  metadata.updatedAt = options.updatedAt;
  metadata.workspaceOutputs = options.workspaceOutputs;
  await store.saveSessionMetadata(metadata);
}

function assertNoStore(response: Response): void {
  assertEquals(response.ok, true);
  assertEquals(
    response.headers.get("cache-control"),
    LIVE_JSON_CACHE_CONTROL,
  );
  const contentType = response.headers.get("content-type");
  assertExists(contentType);
  assertEquals(contentType.startsWith("application/json"), true);
}

async function setupLiveRouteFixture(homeDir: string): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const recentIso = new Date(now.getTime() - 30_000).toISOString();
  const katoDir = join(homeDir, ".kato");
  const runtimeDir = join(katoDir, "daemon");
  const sharedDir = join(katoDir, "shared");
  const statusPath = join(sharedDir, "status.json");
  const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
  const sharedConfigPath = resolveDefaultSharedConfigPath(katoDir);
  const alphaRoot = join(homeDir, "alpha");
  const betaRoot = join(homeDir, "beta");
  const alphaConfigPath = join(alphaRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
  const betaConfigPath = join(betaRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
  const alphaOutputPath = join(alphaRoot, "notes", "alpha.md");
  const betaOutputPath = join(betaRoot, "notes", "beta.md");

  await Deno.mkdir(sharedDir, { recursive: true });
  await Deno.mkdir(join(runtimeDir, "logs"), { recursive: true });
  await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });
  await Deno.mkdir(join(alphaRoot, "notes"), { recursive: true });
  await Deno.mkdir(join(betaRoot, "notes"), { recursive: true });
  await Deno.writeTextFile(alphaConfigPath, "workspaceId: ws-alpha\n");
  await Deno.writeTextFile(betaConfigPath, "workspaceId: ws-beta\n");
  await Deno.writeTextFile(join(homeDir, "source-active.jsonl"), "[]\n");
  await Deno.writeTextFile(join(homeDir, "source-stale.jsonl"), "[]\n");

  const runtimeConfigStore = new RuntimeConfigFileStore(
    join(runtimeDir, "kato-daemon-config.yaml"),
  );
  await runtimeConfigStore.ensureInitialized(
    createDefaultRuntimeConfig({
      runtimeDir,
      katoDir,
      globalAutoGenerateTwins: false,
      providerAutoGenerateTwins: {
        claude: false,
        codex: false,
        gemini: false,
      },
    }),
  );

  const registry = new WorkspaceRegistryFileStore(registryPath);
  await registry.save([
    {
      workspaceId: "ws-alpha",
      alias: "alpha",
      displayName: "Alpha Workspace",
      workspaceRoot: alphaRoot,
      configPath: alphaConfigPath,
      registeredAt: "2026-03-07T15:00:00.000Z",
    },
    {
      workspaceId: "ws-beta",
      alias: "beta",
      displayName: "Beta Project",
      workspaceRoot: betaRoot,
      configPath: betaConfigPath,
      registeredAt: "2026-03-07T15:05:00.000Z",
    },
  ]);

  const sharedConfigStore = new SharedBehaviorConfigFileStore(sharedConfigPath);
  await sharedConfigStore.save(
    createDefaultSharedBehaviorConfig({
      allowedWriteRoots: [alphaRoot, betaRoot],
    }),
  );

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

  await createSessionFixture({
    katoDir,
    sessionId: "sess-active",
    providerSessionId: "provider-active",
    snippet: "active session",
    updatedAt: "2026-03-07T15:59:00.000Z",
    sourceFilePath: join(homeDir, "source-active.jsonl"),
    workspaceOutputs: [
      makeWorkspaceOutput({
        workspaceId: "ws-alpha",
        workspaceAlias: "alpha",
        workspaceRoot: alphaRoot,
        configPath: alphaConfigPath,
        resolvedPath: alphaOutputPath,
        desiredState: "on",
        activeRecordingCycleId: "cycle-active",
        recordingCycles: [{
          recordingCycleId: "cycle-active",
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
    sourceFilePath: join(homeDir, "source-stale.jsonl"),
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
      generatedAt: nowIso,
      heartbeatAt: nowIso,
      daemonRunning: true,
      providers: [{
        provider: "codex",
        activeSessions: 1,
        lastEventAt: recentIso,
      }],
      recordings: {
        activeRecordings: 1,
        destinations: 1,
      },
      sessions: [{
        provider: "codex",
        sessionId: "sess-active",
        providerSessionId: "provider-active",
        updatedAt: recentIso,
        lastEventAt: recentIso,
        stale: false,
        snippet: "active session",
        recordings: [{
          workspaceAlias: "alpha",
          outputPath: alphaOutputPath,
          startedAt: "2026-03-07T15:30:00.000Z",
          lastWriteAt: recentIso,
        }],
      }],
    }),
  );

  await Deno.writeTextFile(
    join(runtimeDir, "logs", "operational.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-03-07T16:00:00.000Z",
        level: "error",
        channel: "operational",
        event: "active.error",
        message: "active failure",
        attributes: { sessionId: "sess-active", workspaceId: "ws-alpha" },
      }),
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    join(katoDir, "web", "logs", "security-audit.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-03-07T15:58:00.000Z",
        level: "warn",
        channel: "security-audit",
        event: "login.warn",
        message: "auth retry",
        attributes: { username: "operator" },
      }),
      "",
    ].join("\n"),
  );
}

Deno.test("live API routes disable caching and return expected page models", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-live-routes-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });
        await setupLiveRouteFixture(homeDir);

        const chromeResponse = await getChromeStatusResponse();
        const summaryResponse = await getSummaryResponse();
        const workspacesResponse = await getWorkspacesResponse();

        assertNoStore(chromeResponse);
        assertNoStore(summaryResponse);
        assertNoStore(workspacesResponse);

        const chromeData = await chromeResponse.json() as {
          daemon: string;
          snapshot: string;
        };
        const summaryData = await summaryResponse.json() as {
          daemon: string;
          stale: boolean;
          workspaceSummary: {
            rows: Array<{ workspaceId: string; displayName?: string }>;
          };
        };
        const workspacesData = await workspacesResponse.json() as {
          rows: Array<{ workspaceId: string; displayName?: string }>;
          allowedWriteRoots: string[];
        };

        assertEquals(chromeData.daemon, "running");
        assertEquals(chromeData.snapshot, "current");
        assertEquals(summaryData.daemon, "running");
        assertEquals(summaryData.stale, false);
        assertEquals(
          summaryData.workspaceSummary.rows.map((row) => row.workspaceId),
          ["ws-alpha", "ws-beta"],
        );
        assertEquals(
          summaryData.workspaceSummary.rows.map((row) => row.displayName),
          ["Alpha Workspace", "Beta Project"],
        );
        assertEquals(
          workspacesData.rows.map((row) => row.workspaceId),
          ["ws-alpha", "ws-beta"],
        );
        assertEquals(
          workspacesData.rows.map((row) => row.displayName),
          ["Alpha Workspace", "Beta Project"],
        );
        assertEquals(workspacesData.allowedWriteRoots, [
          join(homeDir, "alpha"),
          join(homeDir, "beta"),
        ]);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("sessions, maintenance twins, and recordings APIs preserve current query semantics", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-live-route-filters-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });
        await setupLiveRouteFixture(homeDir);

        const sessionsAllResponse = await getSessionsResponse(
          new URL("http://kato.local/api/sessions"),
        );
        const sessionsActiveResponse = await getSessionsResponse(
          new URL("http://kato.local/api/sessions?view=active"),
        );
        const sessionsWorkspaceResponse = await getSessionsResponse(
          new URL("http://kato.local/api/sessions?workspace=ws-beta"),
        );
        const sessionsCombinedResponse = await getSessionsResponse(
          new URL(
            "http://kato.local/api/sessions?view=active&workspace=ws-alpha",
          ),
        );
        const twinsActiveResponse = await getMaintenanceTwinsResponse(
          new URL("http://kato.local/api/maintenance-twins?view=active"),
        );
        const recordingsFilteredResponse = await getRecordingsResponse(
          new URL(
            "http://kato.local/api/recordings?workspace=ws-beta&state=engaged-stale",
          ),
        );

        for (
          const response of [
            sessionsAllResponse,
            sessionsActiveResponse,
            sessionsWorkspaceResponse,
            sessionsCombinedResponse,
            twinsActiveResponse,
            recordingsFilteredResponse,
          ]
        ) {
          assertNoStore(response);
        }

        const sessionsAllData = await sessionsAllResponse.json() as {
          includeStale: boolean;
          rows: Array<{ sessionId: string }>;
        };
        const sessionsActiveData = await sessionsActiveResponse.json() as {
          includeStale: boolean;
          rows: Array<{ sessionId: string }>;
        };
        const sessionsWorkspaceData = await sessionsWorkspaceResponse
          .json() as {
            workspaceFilterId?: string;
            rows: Array<{ sessionId: string }>;
          };
        const sessionsCombinedData = await sessionsCombinedResponse.json() as {
          includeStale: boolean;
          workspaceFilterId?: string;
          rows: Array<{ sessionId: string }>;
        };
        const twinsActiveData = await twinsActiveResponse.json() as {
          includeStale: boolean;
          rows: Array<{ sessionId: string }>;
        };
        const recordingsFilteredData = await recordingsFilteredResponse
          .json() as {
            workspaceFilterId?: string;
            stateFilter: string;
            rows: Array<{ workspaceId?: string; state: string }>;
          };

        assertEquals(sessionsAllData.includeStale, true);
        assertEquals(sessionsAllData.rows.map((row) => row.sessionId), [
          "sess-active",
          "sess-stale",
        ]);
        assertEquals(sessionsActiveData.includeStale, false);
        assertEquals(sessionsActiveData.rows.map((row) => row.sessionId), [
          "sess-active",
        ]);
        assertEquals(sessionsWorkspaceData.workspaceFilterId, "ws-beta");
        assertEquals(sessionsWorkspaceData.rows.map((row) => row.sessionId), [
          "sess-stale",
        ]);
        assertEquals(sessionsCombinedData.includeStale, false);
        assertEquals(sessionsCombinedData.workspaceFilterId, "ws-alpha");
        assertEquals(sessionsCombinedData.rows.map((row) => row.sessionId), [
          "sess-active",
        ]);
        assertEquals(twinsActiveData.includeStale, false);
        assertEquals(twinsActiveData.rows.map((row) => row.sessionId), [
          "sess-active",
        ]);
        assertEquals(recordingsFilteredData.workspaceFilterId, "ws-beta");
        assertEquals(recordingsFilteredData.stateFilter, "engaged-stale");
        assertEquals(
          recordingsFilteredData.rows.map((row) => row.workspaceId),
          ["ws-beta"],
        );
        assertEquals(
          recordingsFilteredData.rows.map((row) => row.state),
          ["engaged-stale"],
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("session snippet API reconstructs a snippet from persisted source history on demand", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-live-session-snippet-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const sharedDir = join(katoDir, "shared");
        await Deno.mkdir(sharedDir, { recursive: true });
        await Deno.writeTextFile(
          join(sharedDir, "status.json"),
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-11T10:00:00.000Z",
            heartbeatAt: "2026-03-11T10:00:00.000Z",
            daemonRunning: false,
            providers: [],
            recordings: {
              activeRecordings: 0,
              destinations: 0,
            },
            sessions: [],
          }),
        );

        const store = new PersistentSessionStateStore({
          katoDir,
          now: () => new Date("2026-03-11T10:00:00.000Z"),
          makeSessionId: () => "sess-source-snippet",
        });
        await store.getOrCreateSessionMetadata({
          provider: "claude",
          providerSessionId: "sess-001",
          sourceFilePath: CLAUDE_FIXTURE,
          initialCursor: { kind: "byte-offset", value: 0 },
        });

        const response = await getSessionSnippetResponse(
          new URL(
            "http://kato.local/api/session-snippet?sessionId=sess-source-snippet&source=1",
          ),
        );
        assertNoStore(response);

        const payload = await response.json() as {
          sessionId: string;
          status: string;
          source?: string;
          snippet?: string;
        };
        assertEquals(payload.sessionId, "sess-source-snippet");
        assertEquals(payload.status, "ready");
        assertEquals(payload.source, "source");
        assertEquals(
          payload.snippet,
          "I want to add authentication to my app. Can you help?",
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("session snippet API rejects missing sessionId with a no-store error payload", async () => {
  const response = await getSessionSnippetResponse(
    new URL("http://kato.local/api/session-snippet?sessionId=%20%20"),
  );

  assertEquals(response.status, 400);
  assertEquals(
    response.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate",
  );

  const payload = await response.json() as {
    sessionId: string;
    status: string;
    error?: string;
  };
  assertEquals(payload.sessionId, "");
  assertEquals(payload.status, "unavailable");
  assertEquals(payload.error, "sessionId is required");
});

Deno.test("logs API preserves channel, scope, level, event, and text filters", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-live-logs-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });
        await setupLiveRouteFixture(homeDir);

        const response = await getLogsResponse(
          new URL(
            "http://kato.local/api/logs?channel=operational&scope=daemon&level=error&event=active&q=failure",
          ),
        );

        assertNoStore(response);

        const data = await response.json() as {
          channel: string;
          scope: string;
          level: string;
          eventFilter?: string;
          textFilter?: string;
          matchedCount: number;
          rows: Array<{ event: string; message: string; scope: string }>;
        };

        assertEquals(data.channel, "operational");
        assertEquals(data.scope, "daemon");
        assertEquals(data.level, "error");
        assertEquals(data.eventFilter, "active");
        assertEquals(data.textFilter, "failure");
        assertEquals(data.matchedCount, 1);
        assertEquals(data.rows.length, 1);
        assertEquals(data.rows[0]?.event, "active.error");
        assertEquals(data.rows[0]?.message, "active failure");
        assertEquals(data.rows[0]?.scope, "daemon");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
