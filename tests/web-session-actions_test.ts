import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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
import {
  runSessionRecordingAction,
  runSessionRecordingRestartAction,
  runSessionRecordingStopAction,
} from "../apps/web/src/session_recording_actions.ts";
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
          nextOutput.recordingCycles[0]?.lastWriteAt,
          "2026-03-17T17:05:00.000Z",
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

Deno.test("runSessionRecordingStopAction stops the targeted engaged recording", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("web-session-stop-action-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const { katoDir, alphaRoot, alphaConfigPath } =
          await setupWorkspaceFixture(homeDir);
        const sessionFilePath = join(homeDir, "provider-session.jsonl");
        await Deno.copyFile(CLAUDE_FIXTURE, sessionFilePath);
        const firstOutputPath = join(alphaRoot, "notes", "first.md");
        const secondOutputPath = join(alphaRoot, "notes", "second.md");

        await createSessionFixture({
          katoDir,
          sessionId: "sess-web-stop-001",
          providerSessionId: "provider-session-stop-001",
          sourceFilePath: sessionFilePath,
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: firstOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-first",
              writeCursor: 4,
              recordingCycles: [{
                recordingCycleId: "cycle-first",
                startedCursor: 4,
                startedAt: "2026-03-17T17:00:00.000Z",
                startedBySeq: 4,
              }],
            }),
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: secondOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-second",
              writeCursor: 6,
              recordingCycles: [{
                recordingCycleId: "cycle-second",
                startedCursor: 6,
                startedAt: "2026-03-17T17:02:00.000Z",
                startedBySeq: 6,
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

        const result = await runSessionRecordingStopAction({
          action: "stop-recording",
          sessionId: "sess-web-stop-001",
          workspaceId: "ws-alpha",
          recordingCycleId: "cycle-second",
          outputPath: secondOutputPath,
          katoDir,
          now: () => new Date("2026-03-17T17:05:00.000Z"),
        });

        assertEquals(result.noOp, false);
        assertEquals(result.stoppedCount, 1);
        assertEquals(result.workspaceId, "ws-alpha");
        assertEquals(result.recordingCycleId, "cycle-second");
        assertEquals(result.outputPath, secondOutputPath);

        const metadataAfter = (await sessionStore.listSessionMetadata())[0];
        assertExists(metadataAfter);
        assertEquals(metadataAfter.workspaceOutputs?.length, 2);
        const firstOutput = metadataAfter.workspaceOutputs?.[0];
        const secondOutput = metadataAfter.workspaceOutputs?.[1];
        assertExists(firstOutput);
        assertExists(secondOutput);
        assertEquals(firstOutput.desiredState, "on");
        assertEquals(firstOutput.activeRecordingCycleId, "cycle-first");
        assertEquals(secondOutput.desiredState, "off");
        assertEquals(secondOutput.activeRecordingCycleId, undefined);
        assertEquals(
          secondOutput.recordingCycles[0]?.stoppedCursor,
          history.events.length,
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingStopAction stops all engaged recordings for the session", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("web-session-stop-all-action-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const { katoDir, alphaRoot, alphaConfigPath } =
          await setupWorkspaceFixture(homeDir);
        const sessionFilePath = join(homeDir, "provider-session.jsonl");
        await Deno.copyFile(CLAUDE_FIXTURE, sessionFilePath);
        const firstOutputPath = join(alphaRoot, "notes", "first.md");
        const secondOutputPath = join(alphaRoot, "notes", "second.md");

        await createSessionFixture({
          katoDir,
          sessionId: "sess-web-stop-002",
          providerSessionId: "provider-session-stop-002",
          sourceFilePath: sessionFilePath,
          workspaceOutputs: [
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: firstOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-first",
              writeCursor: 2,
              recordingCycles: [{
                recordingCycleId: "cycle-first",
                startedCursor: 2,
                startedAt: "2026-03-17T17:00:00.000Z",
                startedBySeq: 2,
              }],
            }),
            makeWorkspaceOutput({
              workspaceId: "ws-alpha",
              workspaceAlias: "alpha",
              workspaceRoot: alphaRoot,
              configPath: alphaConfigPath,
              resolvedPath: secondOutputPath,
              desiredState: "on",
              activeRecordingCycleId: "cycle-second",
              writeCursor: 5,
              recordingCycles: [{
                recordingCycleId: "cycle-second",
                startedCursor: 5,
                startedAt: "2026-03-17T17:03:00.000Z",
                startedBySeq: 5,
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

        const result = await runSessionRecordingStopAction({
          action: "stop-all-recordings",
          sessionId: "sess-web-stop-002",
          katoDir,
          now: () => new Date("2026-03-17T17:05:00.000Z"),
        });

        assertEquals(result.noOp, false);
        assertEquals(result.stoppedCount, 2);

        const metadataAfter = (await sessionStore.listSessionMetadata())[0];
        assertExists(metadataAfter);
        assertEquals(metadataAfter.workspaceOutputs?.length, 2);
        for (const output of metadataAfter.workspaceOutputs ?? []) {
          assertEquals(output.desiredState, "off");
          assertEquals(output.activeRecordingCycleId, undefined);
          assertEquals(
            output.recordingCycles[0]?.stoppedCursor,
            history.events.length,
          );
        }
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingRestartAction re-opens a stopped output file and stops conflicting active writers on the same path", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-session-restart-action-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const { katoDir, alphaRoot, alphaConfigPath } =
            await setupWorkspaceFixture(homeDir);
          const sharedOutputPath = join(alphaRoot, "notes", "shared.md");
          const sessionAPath = join(homeDir, "provider-session-a.jsonl");
          const sessionBPath = join(homeDir, "provider-session-b.jsonl");
          await Deno.copyFile(CLAUDE_FIXTURE, sessionAPath);
          await Deno.copyFile(CLAUDE_FIXTURE, sessionBPath);
          await Deno.writeTextFile(sharedOutputPath, "# existing recording\n");

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-restart-001",
            providerSessionId: "provider-session-restart-001",
            sourceFilePath: sessionAPath,
            workspaceOutputs: [
              makeWorkspaceOutput({
                workspaceId: "ws-alpha",
                workspaceAlias: "alpha",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: sharedOutputPath,
                desiredState: "off",
                writeCursor: 4,
                recordingCycles: [{
                  recordingCycleId: "cycle-stopped",
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

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-restart-002",
            providerSessionId: "provider-session-restart-002",
            sourceFilePath: sessionBPath,
            workspaceOutputs: [
              makeWorkspaceOutput({
                workspaceId: "ws-alpha",
                workspaceAlias: "alpha",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: sharedOutputPath,
                desiredState: "on",
                activeRecordingCycleId: "cycle-conflict",
                writeCursor: 6,
                recordingCycles: [{
                  recordingCycleId: "cycle-conflict",
                  startedCursor: 6,
                  startedAt: "2026-03-17T16:45:00.000Z",
                  startedBySeq: 6,
                }],
              }),
            ],
          });

          const sessionStore = new PersistentSessionStateStore({
            katoDir,
            now: () => new Date("2026-03-17T17:05:00.000Z"),
          });
          const metadataBefore = await sessionStore.listSessionMetadata();
          const restartedBefore = metadataBefore.find((entry) =>
            entry.sessionId === "sess-web-restart-001"
          );
          const conflictingBefore = metadataBefore.find((entry) =>
            entry.sessionId === "sess-web-restart-002"
          );
          assertExists(restartedBefore);
          assertExists(conflictingBefore);
          const restartedHistory = await loadPersistedSessionHistoryEvents(
            restartedBefore,
            sessionStore,
          );
          const conflictingHistory = await loadPersistedSessionHistoryEvents(
            conflictingBefore,
            sessionStore,
          );

          const result = await runSessionRecordingRestartAction({
            action: "restart-recording",
            sessionId: "sess-web-restart-001",
            workspaceId: "ws-alpha",
            recordingCycleId: "cycle-stopped",
            outputPath: sharedOutputPath,
            katoDir,
            now: () => new Date("2026-03-17T17:05:00.000Z"),
          });

          assertEquals(result.noOp, false);
          assertEquals(result.workspaceAlias, "alpha");
          assertEquals(result.outputPath, sharedOutputPath);
          assertExists(result.recordingCycleId);
          assertEquals(result.recordingCycleId === "cycle-stopped", false);

          const metadataAfter = await sessionStore.listSessionMetadata();
          const restartedAfter = metadataAfter.find((entry) =>
            entry.sessionId === "sess-web-restart-001"
          );
          const conflictingAfter = metadataAfter.find((entry) =>
            entry.sessionId === "sess-web-restart-002"
          );
          assertExists(restartedAfter);
          assertExists(conflictingAfter);

          const restartedOutput = restartedAfter.workspaceOutputs?.[0];
          assertExists(restartedOutput);
          assertEquals(restartedOutput.currentResolvedPath, sharedOutputPath);
          assertEquals(restartedOutput.desiredState, "on");
          assertEquals(
            restartedOutput.activeRecordingCycleId,
            result.recordingCycleId,
          );
          assertEquals(restartedOutput.recordingCycles.length, 2);
          assertEquals(
            restartedOutput.recordingCycles[1]?.recordingCycleId,
            result.recordingCycleId,
          );
          assertEquals(
            restartedOutput.recordingCycles[1]?.startedCursor,
            restartedHistory.events.length,
          );

          const conflictingOutput = conflictingAfter.workspaceOutputs?.[0];
          assertExists(conflictingOutput);
          assertEquals(conflictingOutput.desiredState, "off");
          assertEquals(conflictingOutput.activeRecordingCycleId, undefined);
          assertEquals(
            conflictingOutput.recordingCycles[0]?.stoppedCursor,
            conflictingHistory.events.length,
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingRestartAction stops same-session conflicting writers on the same path without reviving stale metadata", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-session-restart-same-session-conflict-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const { katoDir, alphaRoot, alphaConfigPath } =
            await setupWorkspaceFixture(homeDir);
          const sharedOutputPath = join(alphaRoot, "notes", "same-session.md");
          const sessionPath = join(homeDir, "provider-session-same.jsonl");
          await Deno.copyFile(CLAUDE_FIXTURE, sessionPath);
          await Deno.writeTextFile(sharedOutputPath, "# existing recording\n");

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-restart-same-session",
            providerSessionId: "provider-session-restart-same-session",
            sourceFilePath: sessionPath,
            workspaceOutputs: [
              makeWorkspaceOutput({
                workspaceId: "ws-alpha",
                workspaceAlias: "alpha",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: sharedOutputPath,
                desiredState: "off",
                writeCursor: 4,
                recordingCycles: [{
                  recordingCycleId: "cycle-stopped",
                  startedCursor: 1,
                  stoppedCursor: 4,
                  startedAt: "2026-03-17T16:00:00.000Z",
                  stoppedAt: "2026-03-17T16:30:00.000Z",
                  startedBySeq: 1,
                  stoppedBySeq: 4,
                }],
              }),
              makeWorkspaceOutput({
                workspaceId: "ws-beta",
                workspaceAlias: "beta",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: sharedOutputPath,
                desiredState: "on",
                activeRecordingCycleId: "cycle-conflict",
                writeCursor: 6,
                recordingCycles: [{
                  recordingCycleId: "cycle-conflict",
                  startedCursor: 6,
                  startedAt: "2026-03-17T16:45:00.000Z",
                  startedBySeq: 6,
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

          const result = await runSessionRecordingRestartAction({
            action: "restart-recording",
            sessionId: "sess-web-restart-same-session",
            workspaceId: "ws-alpha",
            recordingCycleId: "cycle-stopped",
            outputPath: sharedOutputPath,
            katoDir,
            now: () => new Date("2026-03-17T17:05:00.000Z"),
          });

          assertEquals(result.noOp, false);
          assertExists(result.recordingCycleId);

          const metadataAfter = (await sessionStore.listSessionMetadata())[0];
          assertExists(metadataAfter);
          assertEquals(metadataAfter.workspaceOutputs?.length, 2);

          const restartedOutput = metadataAfter.workspaceOutputs?.[0];
          const conflictingOutput = metadataAfter.workspaceOutputs?.[1];
          assertExists(restartedOutput);
          assertExists(conflictingOutput);

          assertEquals(restartedOutput.desiredState, "on");
          assertEquals(
            restartedOutput.activeRecordingCycleId,
            result.recordingCycleId,
          );
          assertEquals(restartedOutput.recordingCycles.length, 2);
          assertEquals(
            restartedOutput.recordingCycles[1]?.startedCursor,
            history.events.length,
          );

          assertEquals(conflictingOutput.desiredState, "off");
          assertEquals(conflictingOutput.activeRecordingCycleId, undefined);
          assertEquals(
            conflictingOutput.recordingCycles[0]?.stoppedCursor,
            history.events.length,
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingRestartAction fails fast when the stopped output file is missing", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-session-restart-missing-file-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const { katoDir, alphaRoot, alphaConfigPath } =
            await setupWorkspaceFixture(homeDir);
          const missingOutputPath = join(alphaRoot, "notes", "missing.md");
          const sessionPath = join(homeDir, "provider-session-missing.jsonl");
          await Deno.copyFile(CLAUDE_FIXTURE, sessionPath);

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-restart-missing",
            providerSessionId: "provider-session-restart-missing",
            sourceFilePath: sessionPath,
            workspaceOutputs: [
              makeWorkspaceOutput({
                workspaceId: "ws-alpha",
                workspaceAlias: "alpha",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: missingOutputPath,
                desiredState: "off",
                recordingCycles: [{
                  recordingCycleId: "cycle-missing",
                  startedCursor: 1,
                  stoppedCursor: 2,
                  startedAt: "2026-03-17T16:00:00.000Z",
                  stoppedAt: "2026-03-17T16:30:00.000Z",
                  startedBySeq: 1,
                  stoppedBySeq: 2,
                }],
              }),
            ],
          });

          await assertRejects(
            () =>
              runSessionRecordingRestartAction({
                action: "restart-recording",
                sessionId: "sess-web-restart-missing",
                workspaceId: "ws-alpha",
                recordingCycleId: "cycle-missing",
                outputPath: missingOutputPath,
                katoDir,
                now: () => new Date("2026-03-17T17:05:00.000Z"),
              }),
            Error,
            "output file no longer exists",
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingRestartAction fails fast when the stopped output path no longer passes policy", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-session-restart-policy-denied-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const { katoDir, alphaRoot, alphaConfigPath } =
            await setupWorkspaceFixture(homeDir);
          const deniedRoot = join(homeDir, "denied-root");
          const deniedOutputPath = join(alphaRoot, "notes", "denied.md");
          const sessionPath = join(homeDir, "provider-session-denied.jsonl");
          await Deno.mkdir(deniedRoot, { recursive: true });
          await Deno.copyFile(CLAUDE_FIXTURE, sessionPath);
          await Deno.writeTextFile(deniedOutputPath, "# denied output\n");

          const sharedConfigStore = new SharedBehaviorConfigFileStore(
            resolveDefaultSharedConfigPath(katoDir),
          );
          await sharedConfigStore.save(
            createDefaultSharedBehaviorConfig({
              allowedWriteRoots: [deniedRoot],
            }),
          );

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-restart-denied",
            providerSessionId: "provider-session-restart-denied",
            sourceFilePath: sessionPath,
            workspaceOutputs: [
              makeWorkspaceOutput({
                workspaceId: "ws-alpha",
                workspaceAlias: "alpha",
                workspaceRoot: alphaRoot,
                configPath: alphaConfigPath,
                resolvedPath: deniedOutputPath,
                desiredState: "off",
                recordingCycles: [{
                  recordingCycleId: "cycle-denied",
                  startedCursor: 1,
                  stoppedCursor: 2,
                  startedAt: "2026-03-17T16:00:00.000Z",
                  stoppedAt: "2026-03-17T16:30:00.000Z",
                  startedBySeq: 1,
                  stoppedBySeq: 2,
                }],
              }),
            ],
          });

          await assertRejects(
            () =>
              runSessionRecordingRestartAction({
                action: "restart-recording",
                sessionId: "sess-web-restart-denied",
                workspaceId: "ws-alpha",
                recordingCycleId: "cycle-denied",
                outputPath: deniedOutputPath,
                katoDir,
                now: () => new Date("2026-03-17T17:05:00.000Z"),
              }),
            Error,
            "Path denied by policy",
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("runSessionRecordingAction keeps the output-dir snapshot aligned with the generated recording path", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "web-session-record-output-dir-action-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const { katoDir, alphaRoot, alphaConfigPath } =
            await setupWorkspaceFixture(homeDir);
          await Deno.writeTextFile(
            alphaConfigPath,
            [
              'defaultOutputDir: "notes/{HH}"',
              'filenameTemplate: "{provider}-{sessionShortId}.md"',
              'workspaceTimezone: "UTC"',
            ].join("\n") + "\n",
          );
          await Deno.mkdir(join(alphaRoot, "notes", "17"), {
            recursive: true,
          });
          await Deno.mkdir(join(alphaRoot, "notes", "18"), {
            recursive: true,
          });

          const sessionFilePath = join(homeDir, "provider-session.jsonl");
          await Deno.copyFile(CLAUDE_FIXTURE, sessionFilePath);

          await createSessionFixture({
            katoDir,
            sessionId: "sess-web-004",
            providerSessionId: "provider-session-004",
            sourceFilePath: sessionFilePath,
          });

          const timeline = [
            new Date("2026-03-17T17:59:00.000Z"),
            new Date("2026-03-17T18:00:00.000Z"),
            new Date("2026-03-17T18:00:00.000Z"),
          ];
          let timelineIndex = 0;
          const now = () =>
            timeline[Math.min(timelineIndex++, timeline.length - 1)];

          const result = await runSessionRecordingAction({
            action: "new-recording",
            sessionId: "sess-web-004",
            workspaceSelector: "alpha",
            katoDir,
            now,
          });

          const sessionStore = new PersistentSessionStateStore({
            katoDir,
            now,
          });
          const metadataAfter = (await sessionStore.listSessionMetadata())[0];
          assertExists(metadataAfter);
          const output = metadataAfter.workspaceOutputs?.[0];
          assertExists(output);
          assertEquals(
            dirname(result.targetPath),
            output.resolvedDefaultOutputDir,
          );
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
