import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  loadWorkspaceConfigOverrides,
  type RegisteredWorkspace,
  WorkspaceCatalog,
  WorkspaceProfileResolver,
  type WorkspaceRegistryStoreLike,
} from "../apps/daemon/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

function cloneWorkspace(entry: RegisteredWorkspace): RegisteredWorkspace {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    registeredAt: entry.registeredAt,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

function makeWorkspace(
  overrides:
    & Partial<RegisteredWorkspace>
    & Pick<RegisteredWorkspace, "workspaceId">,
): RegisteredWorkspace {
  return {
    workspaceId: overrides.workspaceId,
    alias: overrides.alias ?? overrides.workspaceId,
    workspaceRoot: overrides.workspaceRoot ?? `/tmp/${overrides.workspaceId}`,
    configPath: overrides.configPath ??
      `/tmp/${overrides.workspaceId}/${DEFAULT_WORKSPACE_CONFIG_FILENAME}`,
    registeredAt: overrides.registeredAt ?? "2026-03-01T10:00:00.000Z",
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
  };
}

function makeInMemoryWorkspaceRegistryStore(
  initial: RegisteredWorkspace[] = [],
): {
  store: WorkspaceRegistryStoreLike;
  setEntries(entries: RegisteredWorkspace[]): Promise<void>;
} {
  let entries = initial.map(cloneWorkspace);
  let mtime = 0;

  return {
    store: {
      load() {
        return Promise.resolve(entries.map(cloneWorkspace));
      },
      save(nextEntries: RegisteredWorkspace[]) {
        entries = nextEntries.map(cloneWorkspace);
        mtime += 1;
        return Promise.resolve();
      },
      statMtimeMs() {
        return Promise.resolve(mtime);
      },
    },
    setEntries(nextEntries: RegisteredWorkspace[]) {
      entries = nextEntries.map(cloneWorkspace);
      mtime += 1;
      return Promise.resolve();
    },
  };
}

Deno.test(
  "WorkspaceCatalog applies new entries and removals live but defers existing alias mutations",
  async () => {
    const first = makeWorkspace({
      workspaceId: "ws-1",
      alias: "My.Proj",
      workspaceRoot: "/workspaces/My.Proj",
    });
    const second = makeWorkspace({
      workspaceId: "ws-2",
      alias: "New.Proj",
      workspaceRoot: "/workspaces/New.Proj",
    });
    const { store, setEntries } = makeInMemoryWorkspaceRegistryStore();
    const catalog = new WorkspaceCatalog(store);

    assertEquals(await catalog.getByAlias("My.Proj"), undefined);

    await setEntries([first]);
    const liveFirst = await catalog.getByAlias("My.Proj");
    assertExists(liveFirst);
    assertEquals(liveFirst.workspaceId, "ws-1");

    await setEntries([
      {
        ...first,
        alias: "Renamed.Proj",
        updatedAt: "2026-03-01T10:05:00.000Z",
      },
      second,
    ]);

    const stillOldAlias = await catalog.getByAlias("My.Proj");
    assertExists(stillOldAlias);
    assertEquals(stillOldAlias.alias, "My.Proj");
    assertEquals(await catalog.getByAlias("Renamed.Proj"), undefined);

    const liveSecond = await catalog.getByAlias("New.Proj");
    assertExists(liveSecond);
    assertEquals(liveSecond.workspaceId, "ws-2");

    await setEntries([second]);
    assertEquals(await catalog.getByAlias("My.Proj"), undefined);
    const remaining = await catalog.getByAlias("New.Proj");
    assertExists(remaining);
    assertEquals(remaining.workspaceId, "ws-2");
  },
);

Deno.test(
  "WorkspaceProfileResolver reloads workspace config content after file changes",
  async () => {
    await withTestTempDir("workspace-profile-", async (tempDir) => {
      const workspaceRoot = join(tempDir, "My.Proj");
      const configPath = join(
        workspaceRoot,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes-one",
          'filenameTemplate: "{provider}-{sessionShortId}.md"',
          "workspaceFeatureFlags:",
          "  writerIncludeCommentary: true",
        ].join("\n") + "\n",
      );

      const workspace = makeWorkspace({
        workspaceId: "ws-1",
        alias: "My.Proj",
        workspaceRoot,
        configPath,
      });
      const resolver = new WorkspaceProfileResolver();

      const first = await resolver.resolveForCommand(workspace);
      assertEquals(
        first.resolvedDefaultOutputDir,
        join(workspaceRoot, "notes-one"),
      );
      assertEquals(first.filenameTemplate, "{provider}-{sessionShortId}.md");
      assertEquals(first.writerFeatureFlags.writerIncludeCommentary, true);
      assertEquals(
        first.markdownFrontmatter.includeFrontmatterInMarkdownRecordings,
        true,
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes-two",
          'filenameTemplate: "{provider}.md"',
          "workspaceFeatureFlags:",
          "  writerIncludeCommentary: false",
        ].join("\n") + "\n",
      );

      const second = await resolver.resolveForCommand(workspace);
      assertEquals(
        second.resolvedDefaultOutputDir,
        join(workspaceRoot, "notes-two"),
      );
      assertEquals(second.filenameTemplate, "{provider}.md");
      assertEquals(second.writerFeatureFlags.writerIncludeCommentary, false);
    });
  },
);

Deno.test("loadWorkspaceConfigOverrides rejects legacy featureFlags", async () => {
  await withTestTempDir("workspace-profile-legacy-", async (tempDir) => {
    const workspaceRoot = join(tempDir, "Legacy.Proj");
    const configPath = join(
      workspaceRoot,
      DEFAULT_WORKSPACE_CONFIG_FILENAME,
    );
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      [
        "defaultOutputDir: notes",
        "featureFlags:",
        "  writerIncludeCommentary: true",
      ].join("\n") + "\n",
    );

    await assertRejects(
      () => loadWorkspaceConfigOverrides(configPath),
      Error,
      "Unsupported workspace config key 'featureFlags'",
    );
  });
});
