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
import { loadMaintenanceTwinsData } from "../apps/web/src/loaders/maintenance_twins.ts";
import { loadRecordingsPageData } from "../apps/web/src/loaders/recordings.ts";
import { loadSessionsPageData } from "../apps/web/src/loaders/sessions.ts";
import { loadWorkspacesPageData } from "../apps/web/src/loaders/workspaces.ts";
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
  outputMetadata?: { displayTitle?: string; tags?: string[] };
  writerFeatureFlagOverrides?: {
    writerIncludeCommentary?: boolean;
    writerIncludeThinking?: boolean;
  };
  recordingCycles: Array<{
    recordingCycleId: string;
    startedCursor: number;
    stoppedCursor?: number;
    startedAt?: string;
    lastWriteAt?: string;
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
    ...(options.writerFeatureFlagOverrides
      ? { writerFeatureFlagOverrides: options.writerFeatureFlagOverrides }
      : {}),
    ...(options.outputMetadata
      ? { outputMetadata: options.outputMetadata }
      : {}),
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
  provider?: string;
  providerSessionId: string;
  snippet: string;
  updatedAt: string;
  sourceFilePath: string;
  workspaceOutputs?: ReturnType<typeof makeWorkspaceOutput>[];
  outputMetadataDefaults?: { displayTitle?: string; tags?: string[] };
  lastObservedMtimeMs?: number;
  nextTwinSeq?: number;
  commandCursor?: number;
  parentProviderSessionId?: string;
}) {
  const store = new PersistentSessionStateStore({
    katoDir: options.katoDir,
    now: () => new Date("2026-03-07T16:00:00.000Z"),
    makeSessionId: () => options.sessionId,
  });
  const metadata = await store.getOrCreateSessionMetadata({
    provider: options.provider ?? "codex",
    providerSessionId: options.providerSessionId,
    sourceFilePath: options.sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  metadata.updatedAt = options.updatedAt;
  metadata.parentProviderSessionId = options.parentProviderSessionId;
  metadata.workspaceOutputs = options.workspaceOutputs;
  if (options.outputMetadataDefaults) {
    metadata.outputMetadataDefaults = options.outputMetadataDefaults;
  }
  metadata.lastObservedMtimeMs = options.lastObservedMtimeMs;
  if (options.nextTwinSeq !== undefined) {
    metadata.nextTwinSeq = options.nextTwinSeq;
  }
  if (options.commandCursor !== undefined) {
    metadata.commandCursor = options.commandCursor;
  }
  await store.saveSessionMetadata(metadata);
  return metadata;
}

Deno.test("loadSessionsPageData projects only logical persisted twin sizes", async () => {
  await withTestTempDir("web-activity-twin-size-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    await Deno.mkdir(join(katoDir, "shared"), { recursive: true });

    const logicalTwin = await createSessionFixture({
      katoDir,
      sessionId: "sess-logical-twin",
      providerSessionId: "provider-logical-twin",
      snippet: "logical twin",
      updatedAt: "2026-07-10T12:03:00.000Z",
      sourceFilePath: join(homeDir, "logical-source.jsonl"),
      nextTwinSeq: 2,
    });
    const missingTwin = await createSessionFixture({
      katoDir,
      sessionId: "sess-missing-twin",
      providerSessionId: "provider-missing-twin",
      snippet: "missing twin",
      updatedAt: "2026-07-10T12:02:00.000Z",
      sourceFilePath: join(homeDir, "missing-source.jsonl"),
      nextTwinSeq: 2,
    });
    const orphanTwin = await createSessionFixture({
      katoDir,
      sessionId: "sess-orphan-twin",
      providerSessionId: "provider-orphan-twin",
      snippet: "orphan twin",
      updatedAt: "2026-07-10T12:01:00.000Z",
      sourceFilePath: join(homeDir, "orphan-source.jsonl"),
    });
    const nonFileTwin = await createSessionFixture({
      katoDir,
      sessionId: "sess-non-file-twin",
      providerSessionId: "provider-non-file-twin",
      snippet: "non-file twin",
      updatedAt: "2026-07-10T12:00:00.000Z",
      sourceFilePath: join(homeDir, "non-file-source.jsonl"),
      nextTwinSeq: 2,
    });

    const initialTwinContents = '{"payload":{"text":"café"}}\n';
    const orphanTwinContents = '{"payload":{"text":"orphan"}}\n';
    const encoder = new TextEncoder();
    await Deno.writeTextFile(logicalTwin.twinPath, initialTwinContents);
    await Deno.writeTextFile(orphanTwin.twinPath, orphanTwinContents);
    await Deno.mkdir(nonFileTwin.twinPath);

    const initialData = await loadSessionsPageData({ katoDir });
    const initialLogicalRow = initialData.rows.find((row) =>
      row.sessionId === logicalTwin.sessionId
    );
    const missingRow = initialData.rows.find((row) =>
      row.sessionId === missingTwin.sessionId
    );
    const orphanRow = initialData.rows.find((row) =>
      row.sessionId === orphanTwin.sessionId
    );
    const nonFileRow = initialData.rows.find((row) =>
      row.sessionId === nonFileTwin.sessionId
    );
    assertExists(initialLogicalRow);
    assertExists(missingRow);
    assertExists(orphanRow);
    assertExists(nonFileRow);
    assertEquals(
      initialLogicalRow.twinSizeBytes,
      encoder.encode(initialTwinContents).byteLength,
    );
    assertEquals(missingRow.twinSizeBytes, undefined);
    assertEquals(orphanRow.twinSizeBytes, undefined);
    assertEquals(nonFileRow.twinSizeBytes, undefined);

    const reloadedMetadata = await new PersistentSessionStateStore({ katoDir })
      .listSessionMetadata();
    const resetMissingTwin = reloadedMetadata.find((metadata) =>
      metadata.sessionId === missingTwin.sessionId
    );
    const unchangedOrphanTwin = reloadedMetadata.find((metadata) =>
      metadata.sessionId === orphanTwin.sessionId
    );
    const unchangedNonFileTwin = reloadedMetadata.find((metadata) =>
      metadata.sessionId === nonFileTwin.sessionId
    );
    assertExists(resetMissingTwin);
    assertExists(unchangedOrphanTwin);
    assertExists(unchangedNonFileTwin);
    assertEquals(resetMissingTwin.nextTwinSeq, 1);
    assertEquals(resetMissingTwin.recentFingerprints, []);
    assertEquals(unchangedOrphanTwin.nextTwinSeq, 1);
    assertEquals(unchangedNonFileTwin.nextTwinSeq, 2);

    const appendedTwinContents = '{"payload":{"text":"grown 🚀"}}\n';
    await Deno.writeTextFile(logicalTwin.twinPath, appendedTwinContents, {
      append: true,
    });

    const grownData = await loadSessionsPageData({ katoDir });
    const grownLogicalRow = grownData.rows.find((row) =>
      row.sessionId === logicalTwin.sessionId
    );
    assertExists(grownLogicalRow);
    assertEquals(
      grownLogicalRow.twinSizeBytes,
      encoder.encode(initialTwinContents + appendedTwinContents).byteLength,
    );
  });
});

Deno.test("loadSessionsPageData can hide only source-classified Claude sub-agent sessions", async () => {
  await withTestTempDir("web-activity-subagent-filter-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    await Deno.mkdir(join(katoDir, "shared"), { recursive: true });

    await createSessionFixture({
      katoDir,
      sessionId: "sess-claude-top-level",
      provider: "claude",
      providerSessionId: "agent-top-level-name-only",
      snippet: "top-level Claude session",
      updatedAt: "2026-07-10T12:04:00.000Z",
      sourceFilePath: join(homeDir, "claude", "session-top-level.jsonl"),
    });
    await createSessionFixture({
      katoDir,
      sessionId: "sess-claude-parent",
      provider: "claude",
      providerSessionId: "example",
      snippet: "Claude parent session",
      updatedAt: "2026-07-10T12:03:30.000Z",
      sourceFilePath: "/home/operator/.claude/projects/example.jsonl",
    });
    await createSessionFixture({
      katoDir,
      sessionId: "sess-claude-subagent-posix",
      provider: "claude",
      providerSessionId: "agent-posix",
      snippet: "POSIX sub-agent session",
      updatedAt: "2026-07-10T12:03:00.000Z",
      sourceFilePath:
        "/home/operator/.claude/projects/example/subagents/agent-posix.jsonl",
    });
    await createSessionFixture({
      katoDir,
      sessionId: "sess-claude-subagent-windows",
      provider: "claude",
      providerSessionId: "agent-windows",
      snippet: "Windows sub-agent session",
      updatedAt: "2026-07-10T12:02:00.000Z",
      sourceFilePath:
        "C:\\Users\\operator\\.claude\\projects\\example\\subagents\\agent-windows.jsonl",
    });
    await createSessionFixture({
      katoDir,
      sessionId: "sess-codex-subagents-path",
      provider: "codex",
      providerSessionId: "agent-codex",
      snippet: "Codex session in a coincidental directory",
      updatedAt: "2026-07-10T12:01:00.000Z",
      sourceFilePath: join(homeDir, "subagents", "agent-codex.jsonl"),
    });

    const inclusive = await loadSessionsPageData({ katoDir });
    assertEquals(inclusive.includeSubagents, true);
    assertEquals(inclusive.sessionCount, 5);
    assertEquals(
      inclusive.rows.find((row) =>
        row.sessionId === "sess-claude-subagent-posix"
      )?.relationship,
      {
        kind: "subconversation",
        parentSessionId: "sess-claude-parent",
      },
    );

    const topLevelOnly = await loadSessionsPageData({
      katoDir,
      includeSubagents: false,
    });
    assertEquals(topLevelOnly.includeSubagents, false);
    assertEquals(topLevelOnly.sessionCount, 3);
    assertEquals(
      topLevelOnly.rows.map((row) => row.sessionId).sort(),
      [
        "sess-claude-parent",
        "sess-claude-top-level",
        "sess-codex-subagents-path",
      ],
    );
    assertEquals(
      topLevelOnly.activeSessionCount + topLevelOnly.staleSessionCount +
        topLevelOnly.inactiveSessionCount,
      3,
    );
  });
});

Deno.test(
  "loadSessionsPageData groups exact Codex children and retains filtered ancestors as uncounted context",
  async () => {
    await withTestTempDir(
      "web-activity-codex-tree-context-",
      async (homeDir) => {
        const katoDir = join(homeDir, ".kato");
        const statusPath = join(katoDir, "shared", "status.json");
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });

        await createSessionFixture({
          katoDir,
          sessionId: "sess-codex-parent",
          provider: "codex",
          providerSessionId: "provider-codex-parent",
          snippet: "same repeated request",
          updatedAt: "2026-07-10T12:00:00.000Z",
          sourceFilePath: join(homeDir, "parent.jsonl"),
        });
        await createSessionFixture({
          katoDir,
          sessionId: "sess-codex-child",
          provider: "codex",
          providerSessionId: "provider-codex-child",
          parentProviderSessionId: "provider-codex-parent",
          snippet: "same repeated request",
          updatedAt: "2026-07-10T12:05:00.000Z",
          sourceFilePath: join(homeDir, "child.jsonl"),
        });
        await createSessionFixture({
          katoDir,
          sessionId: "sess-codex-similar-top-level",
          provider: "codex",
          providerSessionId: "provider-codex-similar-top-level",
          snippet: "same repeated request",
          updatedAt: "2026-07-10T12:04:00.000Z",
          sourceFilePath: join(homeDir, "similar.jsonl"),
        });

        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-07-10T12:05:10.000Z",
            heartbeatAt: "2026-07-10T12:05:10.000Z",
            daemonRunning: true,
            providers: [{
              provider: "codex",
              activeSessions: 1,
              lastEventAt: "2026-07-10T12:05:00.000Z",
            }],
            recordings: { activeRecordings: 0, destinations: 0 },
            sessions: [{
              provider: "codex",
              sessionId: "sess-codex-child",
              providerSessionId: "provider-codex-child",
              updatedAt: "2026-07-10T12:05:00.000Z",
              lastEventAt: "2026-07-10T12:05:00.000Z",
              stale: false,
              snippet: "same repeated request",
              recordings: [],
            }],
          }),
        );

        const grouped = await loadSessionsPageData({
          katoDir,
          includeStale: false,
        });
        assertEquals(grouped.sessionCount, 1);
        assertEquals(grouped.activeSessionCount, 1);
        assertEquals(grouped.rows.length, 2);
        const child = grouped.rows.find((row) =>
          row.sessionId === "sess-codex-child"
        );
        const parent = grouped.rows.find((row) =>
          row.sessionId === "sess-codex-parent"
        );
        assertExists(child);
        assertExists(parent);
        assertEquals(child.relationship, {
          kind: "subconversation",
          parentSessionId: "sess-codex-parent",
        });
        assertEquals(child.structuralContext, undefined);
        assertEquals(parent.structuralContext, true);
        assertEquals(
          grouped.rows.some((row) =>
            row.sessionId === "sess-codex-similar-top-level"
          ),
          false,
        );

        const hidden = await loadSessionsPageData({
          katoDir,
          includeStale: false,
          includeSubagents: false,
        });
        assertEquals(hidden.sessionCount, 0);
        assertEquals(hidden.rows, []);
      },
    );
  },
);

Deno.test(
  "loadSessionsPageData retains a parent as context when only its child matches a workspace",
  async () => {
    await withTestTempDir(
      "web-activity-tree-workspace-context-",
      async (homeDir) => {
        const katoDir = join(homeDir, ".kato");
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        const workspaceRoot = join(homeDir, "alpha");
        const configPath = join(
          workspaceRoot,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        const outputPath = join(workspaceRoot, "notes", "child.md");

        await createSessionFixture({
          katoDir,
          sessionId: "sess-workspace-parent",
          providerSessionId: "provider-workspace-parent",
          snippet: "workspace parent",
          updatedAt: "2026-07-10T12:00:00.000Z",
          sourceFilePath: join(homeDir, "workspace-parent.jsonl"),
        });
        await createSessionFixture({
          katoDir,
          sessionId: "sess-workspace-child",
          providerSessionId: "provider-workspace-child",
          parentProviderSessionId: "provider-workspace-parent",
          snippet: "workspace child",
          updatedAt: "2026-07-10T12:01:00.000Z",
          sourceFilePath: join(homeDir, "workspace-child.jsonl"),
          workspaceOutputs: [makeWorkspaceOutput({
            workspaceId: "ws-alpha",
            workspaceAlias: "alpha",
            workspaceRoot,
            configPath,
            resolvedPath: outputPath,
            desiredState: "off",
            recordingCycles: [{
              recordingCycleId: "cycle-child",
              startedCursor: 1,
              stoppedCursor: 2,
              startedAt: "2026-07-10T11:00:00.000Z",
              stoppedAt: "2026-07-10T11:30:00.000Z",
            }],
          })],
        });

        const data = await loadSessionsPageData({
          katoDir,
          workspaceFilter: "ws-alpha",
        });
        assertEquals(data.sessionCount, 1);
        assertEquals(data.rows.map((row) => row.sessionId), [
          "sess-workspace-child",
          "sess-workspace-parent",
        ]);
        assertEquals(
          data.rows.find((row) => row.sessionId === "sess-workspace-parent")
            ?.structuralContext,
          true,
        );
      },
    );
  },
);

Deno.test("loadSessionsPageData integrates live sessions with persistent recording history", async () => {
  await withTestTempDir("web-activity-sessions-", async (homeDir) => {
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
    const registry = new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
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
            lastWriteAt: "2026-03-07T16:00:00.000Z",
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

    const data = await loadSessionsPageData({ katoDir });
    const statusPathData = await loadSessionsPageData({ statusPath });

    assertEquals(data.sessionCount, 2);
    assertEquals(data.activeSessionCount, 1);
    assertEquals(data.staleSessionCount, 1);
    assertEquals(data.inactiveSessionCount, 0);
    assertEquals(data.activeRecordingCount, 2);
    assertEquals(data.staleRecordingCount, 0);
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
    assertEquals(
      data.rows[0]?.recordings[0]?.workspaceDisplayName,
      "Alpha Workspace",
    );
    assertEquals(data.rows[1]?.sessionId, "sess-stale");
    assertEquals(data.rows[1]?.state, "stale");
    assertEquals(data.rows[1]?.recordings.length, 1);
    assertEquals(data.rows[1]?.recordings[0]?.state, "engaged-active");
    assertEquals(
      data.rows[1]?.recordings[0]?.displayOutputPath,
      "notes/beta.md",
    );
    assertEquals(
      data.workspaceOptions.map((workspace) => workspace.displayName),
      ["Alpha Workspace", "Beta Project"],
    );
    assertEquals(statusPathData.sessionCount, 2);
    assertEquals(
      statusPathData.workspaceOptions.map((workspace) => workspace.displayName),
      ["Alpha Workspace", "Beta Project"],
    );
    assertEquals(
      statusPathData.rows[0]?.recordings[0]?.workspaceDisplayName,
      "Alpha Workspace",
    );
    assertEquals(
      data.rows[1]?.recordings[0]?.workspaceHref,
      "/workspaces#workspace-ws-beta",
    );

    const filtered = await loadSessionsPageData({
      katoDir,
      workspaceFilter: "ws-beta",
    });
    assertEquals(filtered.sessionCount, 1);
    assertEquals(filtered.workspaceFilterDisplayName, "Beta Project");
    assertEquals(filtered.activeRecordingCount, 1);
    assertEquals(filtered.staleRecordingCount, 0);
    assertEquals(filtered.stoppedRecordingCount, 0);
    assertEquals(filtered.rows[0]?.sessionId, "sess-stale");
    assertEquals(filtered.rows[0]?.activeRecordingCount, 1);
    assertEquals(filtered.rows[0]?.staleRecordingCount, 0);
    assertEquals(filtered.rows[0]?.stoppedRecordingCount, 0);
    assertEquals(filtered.rows[0]?.recordings.length, 1);
    assertEquals(
      filtered.rows[0]?.recordings.map((recording) => recording.workspaceId),
      ["ws-beta"],
    );

    const recordings = await loadRecordingsPageData({ katoDir });
    assertEquals(recordings.activeRecordingCount, 2);
    assertEquals(recordings.staleRecordingCount, 0);
    assertEquals(recordings.stoppedRecordingCount, 0);
    assertEquals(recordings.rows.length, 2);
    assertEquals(recordings.rows[0]?.state, "engaged-active");
    assertEquals(recordings.rows[0]?.recordingCycleId, "cycle-stale");
    assertEquals(recordings.rows[0]?.displayOutputPath, "notes/beta.md");
    assertEquals(
      recordings.rows[0]?.lastWriteAt,
      "2026-03-07T16:00:00.000Z",
    );
    assertEquals(recordings.rows[1]?.state, "engaged-active");
    assertEquals(recordings.rows[1]?.recordingCycleId, "cycle-live");
    assertEquals(recordings.rows[1]?.displayOutputPath, "notes/alpha.md");
    assertEquals(
      recordings.rows[1]?.workspaceDisplayName,
      "Alpha Workspace",
    );

    const staleRecordings = await loadRecordingsPageData({
      katoDir,
      stateFilter: "engaged-stale",
    });
    assertEquals(staleRecordings.activeRecordingCount, 2);
    assertEquals(staleRecordings.staleRecordingCount, 0);
    assertEquals(staleRecordings.stoppedRecordingCount, 0);
    assertEquals(staleRecordings.rows.length, 0);
  });
});

Deno.test("loadSessionsPageData enriches and filters alias-only live recordings by workspace alias", async () => {
  await withTestTempDir("web-activity-live-alias-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const statusPath = join(katoDir, "shared", "status.json");
    const alphaRoot = join(homeDir, "alpha");
    const alphaConfigPath = join(
      alphaRoot,
      DEFAULT_WORKSPACE_CONFIG_FILENAME,
    );
    await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
    await Deno.mkdir(alphaRoot, { recursive: true });
    await Deno.writeTextFile(alphaConfigPath, "workspaceId: ws-alpha\n");
    const registry = new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
    await registry.save([{
      workspaceId: "ws-alpha",
      alias: "alpha",
      displayName: "Alpha Workspace",
      workspaceRoot: alphaRoot,
      configPath: alphaConfigPath,
      registeredAt: "2026-03-07T15:00:00.000Z",
    }]);

    const alphaOutputPath = join(alphaRoot, "notes", "alpha.md");
    const sessionFixturesDir = join(homeDir, "session-fixtures");
    await createSessionFixture({
      katoDir,
      sessionId: "sess-live-only",
      providerSessionId: "provider-live-only",
      snippet: "live only session",
      updatedAt: "2026-03-07T15:59:00.000Z",
      sourceFilePath: join(sessionFixturesDir, "provider-live-only.jsonl"),
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
          sessionId: "sess-live-only",
          providerSessionId: "provider-live-only",
          updatedAt: "2026-03-07T15:59:30.000Z",
          lastEventAt: "2026-03-07T15:59:30.000Z",
          stale: false,
          snippet: "live only session",
          recordings: [{
            recordingId: "rec-live-only",
            workspaceAlias: "alpha",
            outputPath: alphaOutputPath,
            startedAt: "2026-03-07T15:30:00.000Z",
            lastWriteAt: "2026-03-07T15:59:30.000Z",
          }],
        }],
      }),
    );

    const data = await loadSessionsPageData({ katoDir });
    assertEquals(data.sessionCount, 1);
    assertEquals(data.rows[0]?.recordings.length, 1);
    assertEquals(data.rows[0]?.recordings[0]?.workspaceId, undefined);
    assertEquals(data.rows[0]?.recordings[0]?.workspaceAlias, "alpha");
    assertEquals(
      data.rows[0]?.recordings[0]?.workspaceDisplayName,
      "Alpha Workspace",
    );

    const filteredSessions = await loadSessionsPageData({
      katoDir,
      workspaceFilter: "ws-alpha",
    });
    assertEquals(filteredSessions.workspaceFilterAlias, "alpha");
    assertEquals(
      filteredSessions.workspaceFilterDisplayName,
      "Alpha Workspace",
    );
    assertEquals(filteredSessions.sessionCount, 1);
    assertEquals(filteredSessions.rows[0]?.recordings.length, 1);
    assertEquals(
      filteredSessions.rows[0]?.recordings[0]?.workspaceDisplayName,
      "Alpha Workspace",
    );

    const filteredRecordings = await loadRecordingsPageData({
      katoDir,
      workspaceFilter: "ws-alpha",
    });
    assertEquals(filteredRecordings.workspaceFilterAlias, "alpha");
    assertEquals(
      filteredRecordings.workspaceFilterDisplayName,
      "Alpha Workspace",
    );
    assertEquals(filteredRecordings.rows.length, 1);
    assertEquals(
      filteredRecordings.rows[0]?.workspaceDisplayName,
      "Alpha Workspace",
    );
  });
});

Deno.test("loadSessionsPageData prefers persisted stopped outputs over lagging live recording status for the same path", async () => {
  await withTestTempDir(
    "web-activity-stop-precedence-",
    async (homeDir) => {
      const katoDir = join(homeDir, ".kato");
      const statusPath = join(katoDir, "shared", "status.json");
      const alphaRoot = join(homeDir, "alpha");
      const alphaConfigPath = join(
        alphaRoot,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      const sessionPath = join(homeDir, "session-stop-precedence.jsonl");

      await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
      await Deno.mkdir(alphaRoot, { recursive: true });
      await Deno.mkdir(join(alphaRoot, "notes"), { recursive: true });
      await Deno.writeTextFile(alphaConfigPath, "workspaceId: ws-alpha\n");
      await Deno.writeTextFile(sessionPath, "");

      const registry = new WorkspaceRegistryFileStore(
        resolveDefaultWorkspaceRegistryPath(katoDir),
      );
      await registry.save([{
        workspaceId: "ws-alpha",
        alias: "alpha",
        workspaceRoot: alphaRoot,
        configPath: alphaConfigPath,
        registeredAt: "2026-03-07T15:00:00.000Z",
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

      const alphaOutputPath = join(alphaRoot, "notes", "alpha.md");
      await createSessionFixture({
        katoDir,
        sessionId: "sess-stop-precedence",
        providerSessionId: "provider-stop-precedence",
        snippet: "stopped session",
        updatedAt: "2026-03-07T15:59:30.000Z",
        sourceFilePath: sessionPath,
        workspaceOutputs: [
          makeWorkspaceOutput({
            workspaceId: "ws-alpha",
            workspaceAlias: "alpha",
            workspaceRoot: alphaRoot,
            configPath: alphaConfigPath,
            resolvedPath: alphaOutputPath,
            desiredState: "off",
            recordingCycles: [{
              recordingCycleId: "cycle-stopped",
              startedCursor: 1,
              stoppedCursor: 3,
              startedAt: "2026-03-07T15:00:00.000Z",
              stoppedAt: "2026-03-07T15:55:00.000Z",
              startedBySeq: 1,
              stoppedBySeq: 3,
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
            sessionId: "sess-stop-precedence",
            providerSessionId: "provider-stop-precedence",
            updatedAt: "2026-03-07T15:59:30.000Z",
            lastEventAt: "2026-03-07T15:59:30.000Z",
            stale: false,
            snippet: "stopped session",
            recordings: [{
              workspaceAlias: "alpha",
              outputPath: alphaOutputPath,
              startedAt: "2026-03-07T15:00:00.000Z",
              lastWriteAt: "2026-03-07T15:59:30.000Z",
            }],
          }],
        }),
      );

      const data = await loadSessionsPageData({ katoDir });

      assertEquals(data.activeRecordingCount, 0);
      assertEquals(data.staleRecordingCount, 0);
      assertEquals(data.stoppedRecordingCount, 1);
      assertEquals(data.rows[0]?.recordings.length, 1);
      assertEquals(data.rows[0]?.recordings[0]?.state, "stopped");
      assertEquals(
        data.rows[0]?.recordings[0]?.outputPath,
        alphaOutputPath,
      );
    },
  );
});

Deno.test("loadWorkspacesPageData groups recordings by workspace and links back to sessions", async () => {
  await withTestTempDir("web-activity-workspaces-", async (homeDir) => {
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

    const sharedConfigStore = new SharedBehaviorConfigFileStore(
      sharedConfigPath,
    );
    const sharedConfig = createDefaultSharedBehaviorConfig({
      allowedWriteRoots: [alphaRoot, betaRoot],
    });
    await sharedConfigStore.save(sharedConfig);
    const userConfigStore = new UserConfigFileStore(
      resolveDefaultUserConfigPath(katoDir),
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

    const data = await loadWorkspacesPageData({ katoDir });

    const alphaRow = data.rows.find((row) => row.workspaceId === "ws-alpha");
    const betaRow = data.rows.find((row) => row.workspaceId === "ws-beta");
    assertExists(alphaRow);
    assertExists(betaRow);
    assertEquals(alphaRow.displayName, "Alpha Workspace");
    assertEquals(betaRow.displayName, "Beta Project");
    assertEquals(alphaRow.activeRecordingCount, 1);
    assertEquals(alphaRow.staleRecordingCount, 0);
    assertEquals(alphaRow.stoppedRecordingCount, 0);
    assertEquals(alphaRow.writePathCovered, true);
    assertEquals(
      alphaRow.recordings[0]?.displayOutputPath,
      "notes/alpha.md",
    );
    assertEquals(betaRow.activeRecordingCount, 0);
    assertEquals(betaRow.staleRecordingCount, 1);
    assertEquals(betaRow.stoppedRecordingCount, 0);
    assertEquals(betaRow.writePathCovered, true);
    assertEquals(betaRow.workspaceUsername, "beta-user");
    assertEquals(alphaRow.recordings[0]?.sessionId, "sess-mixed");
    assertEquals(betaRow.recordings[0]?.state, "engaged-stale");
    assertEquals(betaRow.recordings.length, 1);
    assertEquals(betaRow.recordings[0]?.displayOutputPath, "notes/beta.md");
    assertEquals(
      alphaRow.recordings[0]?.sessionLink,
      "/sessions?workspace=ws-alpha#session-sess-mixed",
    );
  });
});

Deno.test("loadWorkspacesPageData surfaces Dendron wikilink diagnostics for workspace note roots", async () => {
  await withTestTempDir("web-activity-workspaces-dendron-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const sharedConfigPath = resolveDefaultSharedConfigPath(katoDir);
    const alphaRoot = join(homeDir, "alpha");
    const alphaNotesRoot = join(alphaRoot, "notes");
    const sharedNotesRoot = join(homeDir, "shared-notes");
    const alphaConfigPath = join(
      alphaRoot,
      DEFAULT_WORKSPACE_CONFIG_FILENAME,
    );

    await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
    await Deno.mkdir(alphaNotesRoot, { recursive: true });
    await Deno.mkdir(sharedNotesRoot, { recursive: true });
    await Deno.writeTextFile(
      alphaConfigPath,
      [
        "workspaceId: ws-alpha",
        "defaultOutputDir: notes/{provider}/{YYYY}/{snippetSlug}",
        "workspaceFeatureFlags:",
        "  writerUseDendronStyleWikilinks: true",
      ].join("\n") + "\n",
    );
    await Deno.writeTextFile(
      join(alphaRoot, "dendron.yml"),
      [
        "workspace:",
        "  vaults:",
        "    - fsPath: .",
        "      selfContained: true",
        "    - fsPath: ../shared-notes",
        "      selfContained: false",
      ].join("\n") + "\n",
    );

    await new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    ).save([{
      workspaceId: "ws-alpha",
      alias: "alpha",
      workspaceRoot: alphaRoot,
      configPath: alphaConfigPath,
      registeredAt: "2026-03-07T15:00:00.000Z",
    }]);

    await new SharedBehaviorConfigFileStore(sharedConfigPath).save(
      createDefaultSharedBehaviorConfig({
        allowedWriteRoots: [alphaRoot],
      }),
    );
    await new UserConfigFileStore(resolveDefaultUserConfigPath(katoDir)).save(
      createDefaultUserConfig(),
    );

    const data = await loadWorkspacesPageData({ katoDir });
    const row = data.rows[0];

    assertExists(row);
    assertEquals(row.wikilinkContextMode, "dendron-config");
    assertEquals(row.dendronConfigPath, join(alphaRoot, "dendron.yml"));
    assertEquals(
      row.wikilinkifiableRoots?.includes(alphaNotesRoot),
      true,
    );
    assertEquals(
      row.wikilinkifiableRoots?.includes(sharedNotesRoot),
      true,
    );
  });
});

Deno.test("loadSessionsPageData handles twin prompts and recording fallbacks", async () => {
  await withTestTempDir("web-activity-fallbacks-", async (homeDir) => {
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
    await new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    ).save([{
      workspaceId: "ws-gamma",
      alias: "gamma",
      displayName: "Gamma Workspace",
      workspaceRoot: gammaRoot,
      configPath: gammaConfigPath,
      registeredAt: "2026-03-07T15:00:00.000Z",
    }]);
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

    const allSessions = await loadSessionsPageData({ katoDir });
    const allTwins = await loadMaintenanceTwinsData({ katoDir });
    assertEquals(allSessions.sessionCount, 3);
    assertEquals(allSessions.activeSessionCount, 0);
    assertEquals(allSessions.staleSessionCount, 3);

    const continuationRow = allSessions.rows.find((row) =>
      row.sessionId === "sess-continue"
    );
    const continuationTwinRow = allTwins.rows.find((row) =>
      row.sessionId === "sess-continue"
    );
    assertExists(continuationRow);
    assertExists(continuationTwinRow);
    assertEquals(continuationTwinRow.twinState, "absent");
    assertEquals(continuationTwinRow.twinAction, "create");
    assertEquals(continuationRow.recordings.length, 1);
    assertEquals(continuationRow.recordings[0]?.state, "engaged-stale");
    assertEquals(
      continuationRow.recordings[0]?.displayOutputPath,
      continuationOutputPath,
    );

    const stoppedRow = allSessions.rows.find((row) =>
      row.sessionId === "sess-stopped"
    );
    const stoppedTwinRow = allTwins.rows.find((row) =>
      row.sessionId === "sess-stopped"
    );
    assertExists(stoppedRow);
    assertExists(stoppedTwinRow);
    assertEquals(stoppedTwinRow.twinState, "absent");
    assertEquals(stoppedTwinRow.twinAction, "create");
    assertEquals(stoppedRow.recordings[0]?.state, "stopped");
    assertEquals(
      stoppedRow.recordings[0]?.recordingCycleId,
      "cycle-newest",
    );

    const legacyRow = allSessions.rows.find((row) =>
      row.sessionId === "sess-legacy"
    );
    const legacyTwinRow = allTwins.rows.find((row) =>
      row.sessionId === "sess-legacy"
    );
    assertExists(legacyRow);
    assertExists(legacyTwinRow);
    assertEquals(legacyRow.state, "stale");
    assertEquals(legacyTwinRow.twinState, "absent");
    assertEquals(legacyTwinRow.twinAction, "create");

    const filtered = await loadSessionsPageData({
      katoDir,
      workspaceFilter: "ws-gamma",
    });
    assertEquals(filtered.workspaceFilter, "ws-gamma");
    assertEquals(filtered.workspaceFilterId, "ws-gamma");
    assertEquals(filtered.workspaceFilterAlias, "gamma");
    assertEquals(filtered.workspaceFilterDisplayName, "Gamma Workspace");
    assertEquals(filtered.sessionCount, 2);
    assertEquals(
      filtered.rows.map((row) => row.sessionId),
      ["sess-continue", "sess-stopped"],
    );

    const recordings = await loadRecordingsPageData({
      katoDir,
      workspaceFilter: "ws-gamma",
    });
    assertEquals(recordings.activeRecordingCount, 0);
    assertEquals(recordings.staleRecordingCount, 1);
    assertEquals(recordings.stoppedRecordingCount, 1);
    assertEquals(recordings.workspaceFilterDisplayName, "Gamma Workspace");
    assertEquals(recordings.rows.length, 2);
    assertEquals(
      recordings.rows
        .filter((row) => row.sessionId === "sess-continue")
        .map((row) => row.state),
      ["engaged-stale"],
    );
    assertEquals(
      recordings.rows
        .filter((row) => row.sessionId === "sess-stopped")
        .map((row) => row.recordingCycleId),
      ["cycle-newest"],
    );
  });
});

Deno.test("loadSessionsPageData projects writer policy and inherited/direct output metadata", async () => {
  await withTestTempDir("web-activity-policy-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const alphaRoot = join(homeDir, "alpha");
    const alphaConfigPath = join(alphaRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
    await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
    await Deno.mkdir(alphaRoot, { recursive: true });
    await Deno.writeTextFile(
      alphaConfigPath,
      [
        "workspaceId: ws-alpha",
        "workspaceFeatureFlags:",
        "  writerIncludeCommentary: false",
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
      registeredAt: "2026-06-11T10:00:00.000Z",
    }]);

    await createSessionFixture({
      katoDir,
      sessionId: "sess-policy",
      providerSessionId: "provider-policy",
      snippet: "policy session",
      updatedAt: "2026-06-11T10:30:00.000Z",
      sourceFilePath: join(homeDir, "session-fixtures", "policy.jsonl"),
      outputMetadataDefaults: {
        displayTitle: "Session Default Title",
        tags: ["session-tag"],
      },
      workspaceOutputs: [
        makeWorkspaceOutput({
          workspaceId: "ws-alpha",
          workspaceAlias: "alpha",
          workspaceRoot: alphaRoot,
          configPath: alphaConfigPath,
          resolvedPath: join(alphaRoot, "notes", "policy.md"),
          desiredState: "off",
          outputMetadata: {
            displayTitle: "Direct Output Title",
            tags: ["output-tag"],
          },
          writerFeatureFlagOverrides: {
            writerIncludeThinking: false,
          },
          recordingCycles: [{
            recordingCycleId: "cycle-policy",
            startedCursor: 1,
            stoppedCursor: 2,
            startedAt: "2026-06-11T10:10:00.000Z",
            stoppedAt: "2026-06-11T10:20:00.000Z",
          }],
        }),
      ],
    });

    const data = await loadSessionsPageData({ katoDir });
    const row = data.rows.find((entry) => entry.sessionId === "sess-policy");
    assertExists(row);
    assertEquals(row.outputMetadataDefaults, {
      displayTitle: "Session Default Title",
      tags: ["session-tag"],
    });

    const recording = row.recordings[0];
    assertExists(recording);
    assertEquals(recording.directMetadata, {
      displayTitle: "Direct Output Title",
      tags: ["output-tag"],
    });
    assertEquals(recording.effectiveMetadata, {
      displayTitle: "Direct Output Title",
      tags: ["session-tag", "output-tag"],
    });

    assertExists(recording.writerPolicy);
    // Current registered workspace config wins over the persisted snapshot.
    assertEquals(recording.writerPolicy.commentary, {
      defaultValue: false,
      effective: false,
    });
    assertEquals(recording.writerPolicy.thinking, {
      defaultValue: true,
      override: false,
      effective: false,
    });
  });
});
