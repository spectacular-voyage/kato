import { assertEquals, assertExists } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
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
import { handleRecordingsPagePost } from "../apps/web/src/recordings_page_post.ts";
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
  writeCursor?: number;
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
    filenameTemplate: "{provider}-{sessionShortId}.md",
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(),
    ...(options.activeRecordingCycleId
      ? { activeRecordingCycleId: options.activeRecordingCycleId }
      : {}),
    writeCursor: options.writeCursor ?? 0,
    createdAt: "2026-03-17T17:00:00.000Z",
    recordingCycles: options.recordingCycles.map((cycle) => ({ ...cycle })),
  };
}

async function setupWorkspaceFixture(homeDir: string): Promise<{
  katoDir: string;
  alphaRoot: string;
  alphaConfigPath: string;
}> {
  const katoDir = join(homeDir, ".kato");
  const alphaRoot = join(homeDir, "alpha");
  const alphaConfigPath = join(alphaRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
  await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
  await Deno.mkdir(alphaRoot, { recursive: true });
  await Deno.mkdir(join(alphaRoot, "notes"), { recursive: true });
  await Deno.writeTextFile(
    alphaConfigPath,
    [
      "workspaceId: ws-alpha",
      "defaultOutputDir: notes",
      'filenameTemplate: "{provider}-{sessionShortId}.md"',
    ].join("\n") + "\n",
  );

  const registry = new WorkspaceRegistryFileStore(
    resolveDefaultWorkspaceRegistryPath(katoDir),
  );
  await registry.save([{
    workspaceId: "ws-alpha",
    alias: "alpha",
    workspaceRoot: alphaRoot,
    configPath: alphaConfigPath,
    registeredAt: "2026-03-17T17:00:00.000Z",
  }]);

  const sharedConfigStore = new SharedBehaviorConfigFileStore(
    resolveDefaultSharedConfigPath(katoDir),
  );
  await sharedConfigStore.save(
    createDefaultSharedBehaviorConfig({
      allowedWriteRoots: [alphaRoot],
    }),
  );

  const userConfigStore = new UserConfigFileStore(
    resolveDefaultUserConfigPath(katoDir),
  );
  await userConfigStore.save(createDefaultUserConfig());

  return { katoDir, alphaRoot, alphaConfigPath };
}

async function createSessionFixture(options: {
  katoDir: string;
  sessionId: string;
  providerSessionId: string;
  sourceFilePath: string;
  workspaceOutputs?: ReturnType<typeof makeWorkspaceOutput>[];
}) {
  const store = new PersistentSessionStateStore({
    katoDir: options.katoDir,
    now: () => new Date("2026-03-17T17:00:00.000Z"),
    makeSessionId: () => options.sessionId,
  });
  const metadata = await store.getOrCreateSessionMetadata({
    provider: "claude",
    providerSessionId: options.providerSessionId,
    sourceFilePath: options.sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  metadata.workspaceOutputs = options.workspaceOutputs;
  await store.saveSessionMetadata(metadata);
}

function buildPostRequest(
  url: string,
  entries: Record<string, string>,
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    form.set(key, value);
  }
  return new Request(url, {
    method: "POST",
    body: form,
  });
}

Deno.test("handleRecordingsPagePost stops an engaged recording and redirects back to the filtered row", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("web-recordings-post-stop-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const { katoDir, alphaRoot, alphaConfigPath } =
          await setupWorkspaceFixture(homeDir);
        const sessionPath = join(homeDir, "provider-session-stop.jsonl");
        const outputPath = join(alphaRoot, "notes", "stop-target.md");
        await Deno.copyFile(CLAUDE_FIXTURE, sessionPath);

        await createSessionFixture({
          katoDir,
          sessionId: "sess-web-route-stop",
          providerSessionId: "provider-session-route-stop",
          sourceFilePath: sessionPath,
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: outputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-stop-route",
              writeCursor: 4,
              recordingCycles: [{
                recordingCycleId: "cycle-stop-route",
                startedCursor: 4,
                startedAt: "2026-03-17T17:00:00.000Z",
                startedBySeq: 4,
              }],
            }),
          ],
        });

        const response = await handleRecordingsPagePost(
          buildPostRequest("http://kato.local/recordings", {
            action: "stop-recording",
            sessionId: "sess-web-route-stop",
            workspaceId: "ws-alpha",
            recordingCycleId: "cycle-stop-route",
            outputPath,
            stateFilter: "engaged-active",
            workspaceFilter: "ws-alpha",
            rowKey: "row-stop-route",
          }),
        );

        assertEquals(response.status, 303);
        const location = response.headers.get("location");
        assertExists(location);
        const redirectUrl = new URL(location, "http://kato.local");
        assertEquals(redirectUrl.pathname, "/recordings");
        assertEquals(
          redirectUrl.searchParams.get("state"),
          "engaged-active",
        );
        assertEquals(redirectUrl.searchParams.get("workspace"), "ws-alpha");
        assertEquals(
          redirectUrl.searchParams.get("notice"),
          "recording stopped: alpha (sess-web)",
        );
        assertEquals(redirectUrl.hash, "#recording-cycle-stop-route");

        const sessionStore = new PersistentSessionStateStore({ katoDir });
        const metadataAfter = (await sessionStore.listSessionMetadata())[0];
        assertExists(metadataAfter);
        const output = metadataAfter.workspaceOutputs?.[0];
        assertExists(output);
        assertEquals(output.desiredState, "off");
        assertEquals(output.activeRecordingCycleId, undefined);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("handleRecordingsPagePost restarts a stopped recording and redirects to the new cycle anchor", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-recordings-post-restart-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const { katoDir, alphaRoot, alphaConfigPath } =
            await setupWorkspaceFixture(homeDir);
          const sessionPath = join(homeDir, "provider-session-restart.jsonl");
          const outputPath = join(alphaRoot, "notes", "restart-target.md");
          await Deno.copyFile(CLAUDE_FIXTURE, sessionPath);
          await Deno.writeTextFile(outputPath, "# existing recording\n");

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-route-restart",
            providerSessionId: "provider-session-route-restart",
            sourceFilePath: sessionPath,
            workspaceOutputs: [
              makeWorkspaceOutput({
                workspaceId: "ws-alpha",
                workspaceAlias: "alpha",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: outputPath,
                desiredState: "off",
                writeCursor: 4,
                recordingCycles: [{
                  recordingCycleId: "cycle-restart-old",
                  startedCursor: 1,
                  stoppedCursor: 4,
                  startedAt: "2026-03-17T16:00:00.000Z",
                  stoppedAt: "2026-03-17T16:30:00.000Z",
                  startedBySeq: 1,
                  stoppedBySeq: 4,
                }],
              }),
            ],
          });

          const response = await handleRecordingsPagePost(
            buildPostRequest("http://kato.local/recordings", {
              action: "restart-recording",
              sessionId: "sess-web-route-restart",
              workspaceId: "ws-alpha",
              recordingCycleId: "cycle-restart-old",
              outputPath,
              stateFilter: "stopped",
              workspaceFilter: "ws-alpha",
              rowKey: "row-restart-route",
            }),
          );

          assertEquals(response.status, 303);
          const location = response.headers.get("location");
          assertExists(location);

          const sessionStore = new PersistentSessionStateStore({ katoDir });
          const metadataAfter = (await sessionStore.listSessionMetadata())[0];
          assertExists(metadataAfter);
          const output = metadataAfter.workspaceOutputs?.[0];
          assertExists(output);
          assertEquals(output.desiredState, "on");
          assertExists(output.activeRecordingCycleId);
          assertEquals(
            output.activeRecordingCycleId === "cycle-restart-old",
            false,
          );

          const redirectUrl = new URL(location, "http://kato.local");
          assertEquals(redirectUrl.pathname, "/recordings");
          assertEquals(redirectUrl.searchParams.get("state"), "stopped");
          assertEquals(redirectUrl.searchParams.get("workspace"), "ws-alpha");
          assertEquals(
            redirectUrl.searchParams.get("notice"),
            "recording re-started: alpha (sess-web)",
          );
          assertEquals(
            redirectUrl.hash,
            `#recording-${output.activeRecordingCycleId}`,
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("handleRecordingsPagePost redirects with an error when sessionId is missing", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-recordings-post-missing-session-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const response = await handleRecordingsPagePost(
            buildPostRequest("http://kato.local/recordings", {
              action: "restart-recording",
              sessionId: "",
              recordingCycleId: "cycle-missing-session",
              stateFilter: "stopped",
              workspaceFilter: "ws-alpha",
              rowKey: "row-missing-session",
            }),
          );

          assertEquals(response.status, 303);
          const location = response.headers.get("location");
          assertExists(location);
          const redirectUrl = new URL(location, "http://kato.local");
          assertEquals(redirectUrl.pathname, "/recordings");
          assertEquals(redirectUrl.searchParams.get("state"), "stopped");
          assertEquals(redirectUrl.searchParams.get("workspace"), "ws-alpha");
          assertEquals(
            redirectUrl.searchParams.get("error"),
            "Session id is required",
          );
          assertEquals(
            redirectUrl.hash,
            "#recording-cycle-missing-session",
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("handleRecordingsPagePost rejects unsupported actions with a 400 response", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-recordings-post-unsupported-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const response = await handleRecordingsPagePost(
            buildPostRequest("http://kato.local/recordings", {
              action: "not-a-real-action",
              sessionId: "sess-unsupported",
            }),
          );

          assertEquals(response.status, 400);
          assertEquals(
            await response.text(),
            "unsupported recordings action",
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
