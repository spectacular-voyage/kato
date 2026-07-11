import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultWorkspaceWriterFeatureFlags,
  PersistentSessionStateStore,
} from "../apps/runtime/src/mod.ts";
import {
  findWorkspaceOutputForSelector,
  runSessionOutputMetadataUpdateAction,
  runSessionWriterOverridesAction,
} from "../apps/web/src/session_metadata_actions.ts";
import { withTestTempDir } from "./test_temp.ts";

const CREATED_NOW = () => new Date("2026-06-11T10:00:00.000Z");
const MUTATION_NOW = () => new Date("2026-06-11T11:30:00.000Z");

function makeWorkspaceOutput(options: {
  workspaceId: string;
  workspaceRoot: string;
  resolvedPath: string;
  desiredState: "on" | "off";
  writerIncludeThinking?: boolean;
}) {
  return {
    workspaceId: options.workspaceId,
    workspaceAliasSnapshot: options.workspaceId.replace(/^ws-/, ""),
    desiredState: options.desiredState,
    currentDestination: {
      kind: "workspace-relative" as const,
      relativePathFromWorkspaceRoot: `notes/${
        options.resolvedPath.split(/[\\/]/).at(-1)
      }`,
    },
    currentResolvedPath: options.resolvedPath,
    workspaceRootSnapshot: options.workspaceRoot,
    resolvedDefaultOutputDir: join(options.workspaceRoot, "notes"),
    filenameTemplate: "{provider}.md",
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags({
      ...(options.writerIncludeThinking !== undefined
        ? { writerIncludeThinking: options.writerIncludeThinking }
        : {}),
    }),
    writeCursor: 0,
    createdAt: "2026-06-11T10:00:00.000Z",
    recordingCycles: [{
      recordingCycleId: `cycle-${options.workspaceId}`,
      startedCursor: 0,
      startedAt: "2026-06-11T10:00:00.000Z",
    }],
  };
}

async function createSessionFixture(options: {
  katoDir: string;
  sessionId: string;
  outputs: ReturnType<typeof makeWorkspaceOutput>[];
}) {
  const store = new PersistentSessionStateStore({
    katoDir: options.katoDir,
    now: CREATED_NOW,
    makeSessionId: () => options.sessionId,
  });
  const metadata = await store.getOrCreateSessionMetadata({
    provider: "codex",
    providerSessionId: `provider-${options.sessionId}`,
    sourceFilePath: join(options.katoDir, "sources", "session.jsonl"),
    initialCursor: { kind: "byte-offset", value: 42 },
  });
  metadata.workspaceOutputs = options.outputs;
  await store.saveSessionMetadata(metadata);
  return store;
}

Deno.test("runSessionOutputMetadataUpdateAction updates session defaults without touching ingestion state", async () => {
  await withTestTempDir("web-metadata-defaults-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const store = await createSessionFixture({
      katoDir,
      sessionId: "sess-defaults",
      outputs: [],
    });
    const before = (await store.listSessionMetadata())[0]!;

    const result = await runSessionOutputMetadataUpdateAction({
      scope: "session-defaults",
      sessionId: "sess-defaults",
      edits: {
        displayTitle: "Session Title",
        tags: ["alpha", "alpha", " beta "],
      },
      katoDir,
      now: MUTATION_NOW,
    });

    assertEquals(result.scope, "session-defaults");
    assertEquals(result.effectiveMetadata, {
      displayTitle: "Session Title",
      tags: ["alpha", "beta"],
    });

    const saved = (await store.listSessionMetadata())[0]!;
    assertEquals(saved.outputMetadataDefaults, {
      displayTitle: "Session Title",
      tags: ["alpha", "beta"],
    });
    assertEquals(saved.ingestCursor, before.ingestCursor);
    assertEquals(saved.nextTwinSeq, before.nextTwinSeq);
    assertEquals(saved.updatedAt, "2026-06-11T11:30:00.000Z");
  });
});

Deno.test("runSessionOutputMetadataUpdateAction updates a selected output and syncs frontmatter title", async () => {
  await withTestTempDir("web-metadata-output-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const workspaceRoot = join(homeDir, "alpha");
    const outputPath = join(workspaceRoot, "notes", "stopped.md");
    await Deno.mkdir(join(workspaceRoot, "notes"), { recursive: true });
    await Deno.writeTextFile(
      outputPath,
      [
        "---",
        "id: stopped-abc123",
        "title: 'Old Title'",
        "---",
        "",
        "Existing body line.",
        "",
      ].join("\n"),
    );

    const store = await createSessionFixture({
      katoDir,
      sessionId: "sess-output",
      outputs: [
        makeWorkspaceOutput({
          workspaceId: "ws-alpha",
          workspaceRoot,
          resolvedPath: outputPath,
          desiredState: "off",
        }),
      ],
    });

    const result = await runSessionOutputMetadataUpdateAction({
      scope: "output",
      sessionId: "sess-output",
      selector: { workspaceId: "ws-alpha" },
      edits: { displayTitle: "Renamed Recording" },
      katoDir,
      now: MUTATION_NOW,
    });

    assertEquals(result.workspaceId, "ws-alpha");
    assertEquals(result.effectiveMetadata.displayTitle, "Renamed Recording");
    assertEquals(result.frontmatterStatuses, [{
      outputPath,
      status: "updated",
    }]);

    const saved = (await store.listSessionMetadata())[0]!;
    assertEquals(saved.workspaceOutputs?.[0]?.outputMetadata, {
      displayTitle: "Renamed Recording",
    });
    assertEquals(
      saved.workspaceOutputs?.[0]?.currentResolvedPath,
      outputPath,
      "title edits must not retarget the output path",
    );

    const content = await Deno.readTextFile(outputPath);
    assertStringIncludes(content, "title: 'Renamed Recording'");
    assertStringIncludes(content, "Existing body line.");
  });
});

Deno.test("runSessionOutputMetadataUpdateAction distinguishes missing files from other frontmatter failures", async () => {
  await withTestTempDir("web-metadata-frontmatter-errors-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const workspaceRoot = join(homeDir, "alpha");
    const missingPath = join(workspaceRoot, "notes", "missing.md");
    await createSessionFixture({
      katoDir,
      sessionId: "sess-missing-output",
      outputs: [
        makeWorkspaceOutput({
          workspaceId: "ws-alpha",
          workspaceRoot,
          resolvedPath: missingPath,
          desiredState: "off",
        }),
      ],
    });

    const missing = await runSessionOutputMetadataUpdateAction({
      scope: "output",
      sessionId: "sess-missing-output",
      selector: { workspaceId: "ws-alpha" },
      edits: { displayTitle: "Missing Output" },
      katoDir,
      now: MUTATION_NOW,
    });
    assertEquals(missing.frontmatterStatuses, [{
      outputPath: missingPath,
      status: "missing-file",
    }]);

    const directoryPath = join(workspaceRoot, "notes", "directory.md");
    await Deno.mkdir(directoryPath, { recursive: true });
    await createSessionFixture({
      katoDir,
      sessionId: "sess-directory-output",
      outputs: [
        makeWorkspaceOutput({
          workspaceId: "ws-beta",
          workspaceRoot,
          resolvedPath: directoryPath,
          desiredState: "off",
        }),
      ],
    });

    await assertRejects(
      () =>
        runSessionOutputMetadataUpdateAction({
          scope: "output",
          sessionId: "sess-directory-output",
          selector: { workspaceId: "ws-beta" },
          edits: { displayTitle: "Directory Output" },
          katoDir,
          now: MUTATION_NOW,
        }),
      Error,
    );
  });
});

Deno.test("runSessionOutputMetadataUpdateAction rejects unknown output selectors", async () => {
  await withTestTempDir("web-metadata-unknown-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    await createSessionFixture({
      katoDir,
      sessionId: "sess-unknown",
      outputs: [],
    });

    await assertRejects(
      () =>
        runSessionOutputMetadataUpdateAction({
          scope: "output",
          sessionId: "sess-unknown",
          selector: { workspaceId: "ws-missing" },
          edits: { displayTitle: "Nope" },
          katoDir,
          now: MUTATION_NOW,
        }),
      Error,
      "Workspace output not found",
    );

    await assertRejects(
      () =>
        runSessionOutputMetadataUpdateAction({
          scope: "output",
          sessionId: "sess-unknown",
          selector: {},
          edits: { displayTitle: "Nope" },
          katoDir,
          now: MUTATION_NOW,
        }),
      Error,
      "Workspace output selector is required",
    );
  });
});

Deno.test("findWorkspaceOutputForSelector matches stopped cycles by recording cycle id", async () => {
  await withTestTempDir("web-metadata-selector-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const workspaceRoot = join(homeDir, "alpha");
    const store = await createSessionFixture({
      katoDir,
      sessionId: "sess-selector",
      outputs: [
        makeWorkspaceOutput({
          workspaceId: "ws-alpha",
          workspaceRoot,
          resolvedPath: join(workspaceRoot, "notes", "one.md"),
          desiredState: "off",
        }),
      ],
    });
    const metadata = (await store.listSessionMetadata())[0]!;

    const output = findWorkspaceOutputForSelector(metadata, {
      recordingCycleId: "cycle-ws-alpha",
    });
    assertEquals(output.workspaceId, "ws-alpha");
  });
});

Deno.test("runSessionWriterOverridesAction supports include, exclude, and inherit transitions", async () => {
  await withTestTempDir("web-writer-overrides-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const workspaceRoot = join(homeDir, "alpha");
    const outputPath = join(workspaceRoot, "notes", "active.md");
    await Deno.mkdir(join(workspaceRoot, "notes"), { recursive: true });
    await Deno.writeTextFile(
      outputPath,
      [
        "---",
        "id: active-abc123",
        "title: 'Active Recording'",
        "---",
        "",
        "Body stays.",
        "",
      ].join("\n"),
    );

    const store = await createSessionFixture({
      katoDir,
      sessionId: "sess-overrides",
      outputs: [
        makeWorkspaceOutput({
          workspaceId: "ws-alpha",
          workspaceRoot,
          resolvedPath: outputPath,
          desiredState: "on",
          writerIncludeThinking: true,
        }),
      ],
    });

    const excluded = await runSessionWriterOverridesAction({
      sessionId: "sess-overrides",
      selector: { workspaceId: "ws-alpha", outputPath },
      thinking: "exclude",
      katoDir,
      now: MUTATION_NOW,
    });
    assertEquals(excluded.overrides, { writerIncludeThinking: false });
    assertEquals(excluded.defaultWriterFlags.writerIncludeThinking, true);
    assertEquals(excluded.effectiveWriterFlags.writerIncludeThinking, false);
    assertEquals(
      excluded.effectiveWriterFlags.writerIncludeCommentary,
      excluded.defaultWriterFlags.writerIncludeCommentary,
    );
    assertEquals(excluded.frontmatterStatus, "updated");

    const content = await Deno.readTextFile(outputPath);
    assertStringIncludes(content, "kato-writerFeatureFlags:");
    assertStringIncludes(content, "writerIncludeThinking: false");
    assertStringIncludes(content, "Body stays.");

    let saved = (await store.listSessionMetadata())[0]!;
    assertEquals(saved.workspaceOutputs?.[0]?.writerFeatureFlagOverrides, {
      writerIncludeThinking: false,
    });

    const included = await runSessionWriterOverridesAction({
      sessionId: "sess-overrides",
      selector: { workspaceId: "ws-alpha" },
      commentary: "include",
      katoDir,
      now: MUTATION_NOW,
    });
    assertEquals(included.overrides, {
      writerIncludeCommentary: true,
      writerIncludeThinking: false,
    });

    const inherited = await runSessionWriterOverridesAction({
      sessionId: "sess-overrides",
      selector: { workspaceId: "ws-alpha" },
      commentary: "inherit",
      thinking: "inherit",
      katoDir,
      now: MUTATION_NOW,
    });
    assertEquals(inherited.overrides, undefined);
    assertEquals(inherited.effectiveWriterFlags.writerIncludeThinking, true);

    saved = (await store.listSessionMetadata())[0]!;
    assertEquals(
      saved.workspaceOutputs?.[0]?.writerFeatureFlagOverrides,
      undefined,
    );
  });
});
