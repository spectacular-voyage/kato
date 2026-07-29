import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import type { ConversationEvent, SessionMetadataV1 } from "@kato/shared";
import {
  createDefaultUserConfig,
  createDefaultWorkspaceMarkdownFrontmatterConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  type RegisteredWorkspace,
  type ResolvedWorkspaceProfile,
  WritePathPolicyGate,
} from "../apps/runtime/src/mod.ts";
import { resolvePersistedWorkspaceOutputOverrides } from "../apps/daemon/src/orchestrator/daemon_runtime.ts";
import { RecordingPipeline } from "../apps/daemon/src/writer/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

type WorkspaceOutputState = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number];

function makeOutput(
  overrides: Partial<WorkspaceOutputState> = {},
): WorkspaceOutputState {
  const workspaceRoot = resolve(".test-tmp", "writer-overrides-workspace");
  return {
    workspaceId: "ws-alpha",
    workspaceAliasSnapshot: "alpha",
    desiredState: "on",
    currentDestination: {
      kind: "workspace-relative",
      relativePathFromWorkspaceRoot: "notes/output.md",
    },
    currentResolvedPath: resolve(workspaceRoot, "notes", "output.md"),
    workspaceRootSnapshot: workspaceRoot,
    resolvedDefaultOutputDir: resolve(workspaceRoot, "notes"),
    filenameTemplate: "{provider}.md",
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(),
    writeCursor: 0,
    recordingCycles: [],
    ...overrides,
  };
}

function makeRegisteredWorkspace(workspaceRoot: string): RegisteredWorkspace {
  return {
    workspaceId: "ws-alpha",
    alias: "alpha",
    workspaceRoot,
    configPath: join(workspaceRoot, ".kato", "workspace.yaml"),
    registeredAt: "2026-06-11T10:00:00.000Z",
  };
}

function makeProfile(workspaceRoot: string): ResolvedWorkspaceProfile {
  return {
    workspaceId: "ws-alpha",
    alias: "alpha",
    workspaceRoot,
    configPath: join(workspaceRoot, ".kato", "workspace.yaml"),
    autoRecordConversations: false,
    autoRecordRoots: [],
    resolvedDefaultOutputDir: join(workspaceRoot, "notes"),
    defaultOutputDirTemplate: "notes",
    filenameTemplate: "{provider}.md",
    workspaceTimezone: "local",
    defaultTags: [],
    tagSuggestions: [],
    markdownFrontmatter: createDefaultWorkspaceMarkdownFrontmatterConfig(),
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags({
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
    }),
  };
}

function makeStubWorkspaceLookups(workspaceRoot: string, registered: boolean) {
  return {
    workspaceCatalog: {
      getByAlias: () => Promise.resolve(undefined),
      getByWorkspaceId: () =>
        Promise.resolve(
          registered ? makeRegisteredWorkspace(workspaceRoot) : undefined,
        ),
      list: () => Promise.resolve([]),
      refreshIfChanged: () => Promise.resolve(),
    },
    workspaceProfileResolver: {
      resolveForCommand: () => Promise.resolve(makeProfile(workspaceRoot)),
    },
  };
}

function makeEvent(
  id: string,
  kind: "message.assistant" | "thinking",
  content: string,
): ConversationEvent {
  return {
    eventId: id,
    provider: "codex",
    sessionId: "session-1",
    timestamp: "2026-06-11T10:00:00.000Z",
    kind,
    ...(kind === "message.assistant" ? { role: "assistant" } : {}),
    content,
    source: {
      providerEventType: "assistant",
      providerEventId: id,
    },
  } as unknown as ConversationEvent;
}

Deno.test("resolvePersistedWorkspaceOutputOverrides applies per-output overrides over registered profile flags", async () => {
  const workspaceRoot = resolve(".test-tmp", "writer-overrides-workspace");
  const output = makeOutput({
    writerFeatureFlagOverrides: {
      writerIncludeThinking: false,
    },
  });

  const overrides = await resolvePersistedWorkspaceOutputOverrides({
    output,
    captureIncludeSystemEvents: false,
    userConfig: createDefaultUserConfig(),
    ...makeStubWorkspaceLookups(workspaceRoot, true),
  });

  assertEquals(overrides.renderOptions?.includeCommentary, true);
  assertEquals(overrides.renderOptions?.includeThinking, false);
  assertEquals(overrides.frontmatterWriterPolicy, {
    writerIncludeCommentary: true,
    writerIncludeThinking: false,
  });
});

Deno.test("resolvePersistedWorkspaceOutputOverrides applies overrides over the persisted snapshot fallback", async () => {
  const workspaceRoot = resolve(".test-tmp", "writer-overrides-workspace");
  const output = makeOutput({
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags({
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
    }),
    writerFeatureFlagOverrides: {
      writerIncludeCommentary: false,
    },
  });
  delete output.sourceConfigPath;

  const overrides = await resolvePersistedWorkspaceOutputOverrides({
    output,
    captureIncludeSystemEvents: false,
    userConfig: createDefaultUserConfig(),
    ...makeStubWorkspaceLookups(workspaceRoot, false),
  });

  assertEquals(overrides.renderOptions?.includeCommentary, false);
  assertEquals(overrides.renderOptions?.includeThinking, true);
});

Deno.test("resolvePersistedWorkspaceOutputOverrides includes persisted default tags when workspace config is unavailable", async () => {
  const workspaceRoot = resolve(".test-tmp", "writer-overrides-workspace");
  const output = makeOutput({
    defaultTags: ["workspace"],
    outputMetadata: { tags: ["direct"] },
  });
  delete output.sourceConfigPath;

  const overrides = await resolvePersistedWorkspaceOutputOverrides({
    output,
    sessionDefaults: { tags: ["session"] },
    captureIncludeSystemEvents: false,
    userConfig: createDefaultUserConfig(),
    ...makeStubWorkspaceLookups(workspaceRoot, false),
  });

  assertEquals(overrides.frontmatterTags, ["session", "workspace", "direct"]);
});

Deno.test("resolvePersistedWorkspaceOutputOverrides omits the frontmatter policy when no overrides exist", async () => {
  const workspaceRoot = resolve(".test-tmp", "writer-overrides-workspace");
  const output = makeOutput();

  const overrides = await resolvePersistedWorkspaceOutputOverrides({
    output,
    captureIncludeSystemEvents: false,
    userConfig: createDefaultUserConfig(),
    ...makeStubWorkspaceLookups(workspaceRoot, true),
  });

  assertEquals(overrides.frontmatterWriterPolicy, undefined);
  assertEquals(overrides.renderOptions?.includeThinking, true);
});

Deno.test("persisted append honors writer flag overrides for future writes", async () => {
  await withTestTempDir("writer-overrides-append-", async (dir) => {
    const outputPath = join(dir, "notes", "output.md");
    const output = makeOutput({
      currentResolvedPath: outputPath,
      workspaceRootSnapshot: dir,
      resolvedDefaultOutputDir: join(dir, "notes"),
      writerFeatureFlagOverrides: {
        writerIncludeThinking: false,
      },
    });
    delete output.sourceConfigPath;

    const overrides = await resolvePersistedWorkspaceOutputOverrides({
      output,
      captureIncludeSystemEvents: false,
      userConfig: createDefaultUserConfig(),
      ...makeStubWorkspaceLookups(dir, false),
    });

    const pipeline = new RecordingPipeline({
      pathPolicyGate: new WritePathPolicyGate({ allowedRoots: [dir] }),
      now: () => new Date("2026-06-11T10:00:00.000Z"),
    });
    const writeResult = await pipeline.appendToDestination({
      provider: "codex",
      sessionId: "session-1",
      targetPath: outputPath,
      events: [
        makeEvent("evt-1", "message.assistant", "Visible assistant message."),
        makeEvent("evt-2", "thinking", "Hidden thinking content."),
      ],
      title: "Override Append",
      recordingId: "cycle-1",
      workspaceIds: ["ws-alpha"],
      outputOverrides: overrides,
    });

    assertEquals(writeResult.wrote, true);
    const content = await Deno.readTextFile(outputPath);
    assertStringIncludes(content, "Visible assistant message.");
    assertEquals(content.includes("Hidden thinking content."), false);
    assertStringIncludes(content, "kato-writerFeatureFlags:");
    assertStringIncludes(content, "writerIncludeThinking: false");
  });
});
