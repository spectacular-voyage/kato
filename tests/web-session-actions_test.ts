import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  createDefaultSharedBehaviorConfig,
  createDefaultUserConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  loadPersistedSessionHistoryEvents,
  PersistentSessionStateStore,
  resolveDefaultSharedConfigPath,
  resolveDefaultUserConfigPath,
  resolveDefaultWorkspaceRegistryPath,
  SharedBehaviorConfigFileStore,
  UserConfigFileStore,
  WorkspaceRegistryFileStore,
} from "../apps/runtime/src/mod.ts";
import { runSessionRecordingAction } from "../apps/web/src/session_recording_actions.ts";
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

Deno.test("runSessionRecordingAction creates a new recording file with frontmatter and arms future writes", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("web-session-record-action-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const { katoDir, alphaRoot } = await setupWorkspaceFixture(homeDir);
        const sessionFilePath = join(homeDir, "provider-session.jsonl");
        await Deno.copyFile(CLAUDE_FIXTURE, sessionFilePath);

        await createSessionFixture({
          katoDir,
          sessionId: "sess-web-001",
          providerSessionId: "provider-session-001",
          sourceFilePath: sessionFilePath,
        });

        const sessionStore = new PersistentSessionStateStore({
          katoDir,
          now: () => new Date("2026-03-17T17:05:00.000Z"),
        });
        const metadataBefore = (await sessionStore.listSessionMetadata())[0];
        assertExists(metadataBefore);
        const history = await loadPersistedSessionHistoryEvents(
          metadataBefore,
          sessionStore,
        );

        const result = await runSessionRecordingAction({
          action: "new-recording",
          sessionId: "sess-web-001",
          workspaceSelector: "alpha",
          katoDir,
          now: () => new Date("2026-03-17T17:05:00.000Z"),
        });

        assertEquals(result.mode, "record");
        assertEquals(result.noOp, false);
        assertEquals(result.workspaceAlias, "alpha");
        assertEquals(result.source, "source");
        assertEquals(result.writeCursor, history.events.length);
        assertEquals(
          result.targetPath.startsWith(join(alphaRoot, "notes")),
          true,
        );

        const metadataAfter = (await sessionStore.listSessionMetadata())[0];
        assertExists(metadataAfter);
        const output = metadataAfter.workspaceOutputs?.[0];
        assertExists(output);
        assertEquals(output.workspaceId, "ws-alpha");
        assertEquals(output.desiredState, "on");
        assertEquals(output.writeCursor, history.events.length);
        assertExists(output.activeRecordingCycleId);
        assertEquals(output.recordingCycles.length, 1);
        assertEquals(
          output.recordingCycles[0]?.startedCursor,
          history.events.length,
        );
        const written = await Deno.readTextFile(result.targetPath);
        assertStringIncludes(written, "---");
        assertStringIncludes(
          written,
          "title: 'I want to add authentication to my app. Can you help?'",
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingAction creates a fresh recording destination and stops the prior engaged output", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-session-record-action-noop-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const { katoDir, alphaRoot, alphaConfigPath } =
            await setupWorkspaceFixture(homeDir);
          const sessionFilePath = join(homeDir, "provider-session.jsonl");
          await Deno.copyFile(CLAUDE_FIXTURE, sessionFilePath);
          const existingOutputPath = join(alphaRoot, "notes", "existing.md");

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-002",
            providerSessionId: "provider-session-002",
            sourceFilePath: sessionFilePath,
            workspaceOutputs: [
              makeWorkspaceOutput({
                workspaceId: "ws-alpha",
                workspaceAlias: "alpha",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: existingOutputPath,
                desiredState: "on",
                activeRecordingCycleId: "cycle-existing",
                writeCursor: 7,
                recordingCycles: [{
                  recordingCycleId: "cycle-existing",
                  startedCursor: 7,
                  startedAt: "2026-03-17T17:00:00.000Z",
                  startedBySeq: 7,
                }],
              }),
            ],
          });

          const result = await runSessionRecordingAction({
            action: "new-recording",
            sessionId: "sess-web-002",
            workspaceSelector: "ws-alpha",
            katoDir,
            now: () => new Date("2026-03-17T17:05:00.000Z"),
          });

          assertEquals(result.mode, "record");
          assertEquals(result.noOp, false);
          assertEquals(result.targetPath === existingOutputPath, false);

          const sessionStore = new PersistentSessionStateStore({ katoDir });
          const metadataAfter = (await sessionStore.listSessionMetadata())[0];
          assertExists(metadataAfter);
          assertEquals(metadataAfter.workspaceOutputs?.length, 2);
          const priorOutput = metadataAfter.workspaceOutputs?.[0];
          const nextOutput = metadataAfter.workspaceOutputs?.[1];
          assertExists(priorOutput);
          assertExists(nextOutput);
          assertEquals(priorOutput.currentResolvedPath, existingOutputPath);
          assertEquals(priorOutput.desiredState, "off");
          assertEquals(priorOutput.activeRecordingCycleId, undefined);
          assertEquals(
            priorOutput.recordingCycles[0]?.stoppedCursor,
            nextOutput.writeCursor,
          );
          assertEquals(nextOutput.currentResolvedPath, result.targetPath);
          assertEquals(nextOutput.desiredState, "on");
          assertExists(nextOutput.activeRecordingCycleId);
          assertEquals(nextOutput.recordingCycles.length, 1);
          const written = await Deno.readTextFile(result.targetPath);
          assertStringIncludes(written, "---");
          assertStringIncludes(
            written,
            "title: 'I want to add authentication to my app. Can you help?'",
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingAction capture creates a fresh destination and preserves the previous output as stopped history", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("web-session-capture-action-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const { katoDir, alphaRoot, alphaConfigPath } =
          await setupWorkspaceFixture(homeDir);
        const sessionFilePath = join(homeDir, "provider-session.jsonl");
        await Deno.copyFile(CLAUDE_FIXTURE, sessionFilePath);
        const previousOutputPath = join(alphaRoot, "notes", "previous.md");

        await createSessionFixture({
          katoDir,
          sessionId: "sess-web-003",
          providerSessionId: "provider-session-003",
          sourceFilePath: sessionFilePath,
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: previousOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-old",
              writeCursor: 0,
              recordingCycles: [{
                recordingCycleId: "cycle-old",
                startedCursor: 0,
                startedAt: "2026-03-17T17:00:00.000Z",
                startedBySeq: 1,
              }],
            }),
          ],
        });

        const sessionStore = new PersistentSessionStateStore({
          katoDir,
          now: () => new Date("2026-03-17T17:05:00.000Z"),
        });
        const metadataBefore = (await sessionStore.listSessionMetadata())[0];
        assertExists(metadataBefore);
        const history = await loadPersistedSessionHistoryEvents(
          metadataBefore,
          sessionStore,
        );

        const result = await runSessionRecordingAction({
          action: "new-capture",
          sessionId: "sess-web-003",
          workspaceSelector: "alpha",
          katoDir,
          now: () => new Date("2026-03-17T17:05:00.000Z"),
        });

        assertEquals(result.mode, "capture");
        assertEquals(result.noOp, false);
        assertEquals(
          result.targetPath.startsWith(join(alphaRoot, "notes")),
          true,
        );
        assertEquals(result.targetPath === previousOutputPath, false);
        const written = await Deno.readTextFile(result.targetPath);
        assertStringIncludes(
          written,
          "I want to add authentication to my app. Can you help?",
        );

        const metadataAfter = (await sessionStore.listSessionMetadata())[0];
        assertExists(metadataAfter);
        assertEquals(metadataAfter.workspaceOutputs?.length, 2);
        const priorOutput = metadataAfter.workspaceOutputs?.[0];
        const nextOutput = metadataAfter.workspaceOutputs?.[1];
        assertExists(priorOutput);
        assertExists(nextOutput);
        assertEquals(priorOutput.currentResolvedPath, previousOutputPath);
        assertEquals(priorOutput.desiredState, "off");
        assertEquals(priorOutput.activeRecordingCycleId, undefined);
        assertEquals(priorOutput.recordingCycles.length, 1);
        assertEquals(
          priorOutput.recordingCycles[0]?.recordingCycleId,
          "cycle-old",
        );
        assertEquals(
          priorOutput.recordingCycles[0]?.stoppedCursor,
          history.events.length,
        );
        assertEquals(nextOutput.desiredState, "on");
        assertEquals(nextOutput.currentResolvedPath, result.targetPath);
        assertEquals(nextOutput.writeCursor, history.events.length);
        assertEquals(nextOutput.recordingCycles.length, 1);
        assertExists(nextOutput.recordingCycles[0]?.recordingCycleId);
        assertEquals(
          nextOutput.recordingCycles[0]?.startedCursor,
          history.events.length,
        );
        assertEquals(
          nextOutput.activeRecordingCycleId,
          nextOutput.recordingCycles[0]?.recordingCycleId,
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
