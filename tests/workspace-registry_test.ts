import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  DefaultWorkspaceConfigFileStore,
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
  "WorkspaceCatalog applies new entries, alias mutations, and removals live",
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

    assertEquals(await catalog.getByAlias("My.Proj"), undefined);
    const renamed = await catalog.getByAlias("Renamed.Proj");
    assertExists(renamed);
    assertEquals(renamed.alias, "Renamed.Proj");

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
      assertEquals(first.writerFeatureFlags.writerIncludeToolResults, false);
      assertEquals(first.writerFeatureFlags.writerIncludeDecisionPrompt, true);
      assertEquals(first.writerFeatureFlags.writerIncludeDecisionOptions, true);
      assertEquals(
        first.writerFeatureFlags.writerIncludeDecisionSelection,
        true,
      );
      assertEquals(
        first.markdownFrontmatter.includeFrontmatterInMarkdownRecordings,
        true,
      );
      assertEquals(first.markdownFrontmatter.includeSessionIds, false);
      assertEquals(first.markdownFrontmatter.includeWorkspaceIds, false);
      assertEquals(first.markdownFrontmatter.includeRecordingIds, false);

      const firstStat = await Deno.stat(configPath);
      const firstMtimeMs = firstStat.mtime?.getTime() ?? Date.now();
      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes-two",
          'filenameTemplate: "{provider}.md"',
          "workspaceFeatureFlags:",
          "  writerIncludeCommentary: false",
          "  writerIncludeToolResults: true",
          "  writerIncludeDecisionSelection: false",
        ].join("\n") + "\n",
      );
      await Deno.utime(
        configPath,
        firstStat.atime ?? new Date(firstMtimeMs),
        new Date(firstMtimeMs + 1_000),
      );

      const second = await resolver.resolveForCommand(workspace);
      assertEquals(
        second.resolvedDefaultOutputDir,
        join(workspaceRoot, "notes-two"),
      );
      assertEquals(second.filenameTemplate, "{provider}.md");
      assertEquals(second.writerFeatureFlags.writerIncludeCommentary, false);
      assertEquals(second.writerFeatureFlags.writerIncludeToolResults, true);
      assertEquals(
        second.writerFeatureFlags.writerIncludeDecisionSelection,
        false,
      );
    });
  },
);

Deno.test(
  "WorkspaceProfileResolver refreshes alias and workspaceRoot when entry metadata changes",
  async () => {
    await withTestTempDir("workspace-profile-metadata-", async (tempDir) => {
      const workspaceRoot = join(tempDir, "My.Proj");
      const configPath = join(
        workspaceRoot,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{provider}.md"',
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
      assertEquals(first.alias, "My.Proj");
      assertEquals(first.workspaceRoot, workspaceRoot);
      assertEquals(
        first.resolvedDefaultOutputDir,
        join(workspaceRoot, "notes"),
      );

      const renamedRoot = join(tempDir, "Renamed.Proj");
      const second = await resolver.resolveForCommand({
        ...workspace,
        alias: "Renamed.Proj",
        workspaceRoot: renamedRoot,
      });
      assertEquals(second.alias, "Renamed.Proj");
      assertEquals(second.workspaceRoot, renamedRoot);
      assertEquals(second.resolvedDefaultOutputDir, join(renamedRoot, "notes"));
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

Deno.test("loadWorkspaceConfigOverrides accepts local and IANA workspaceTimezone values", async () => {
  await withTestTempDir(
    "workspace-profile-timezone-valid-",
    async (tempDir) => {
      const workspaceRoot = join(tempDir, "Timezone.Proj");
      const configPath = join(
        workspaceRoot,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.mkdir(workspaceRoot, { recursive: true });

      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md"',
          'workspaceTimezone: "local"',
        ].join("\n") + "\n",
      );
      const localLoaded = await loadWorkspaceConfigOverrides(configPath);
      assertEquals(localLoaded.workspaceTimezone, "local");

      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md"',
          'workspaceTimezone: "UTC"',
        ].join("\n") + "\n",
      );
      const utcLoaded = await loadWorkspaceConfigOverrides(configPath);
      assertEquals(utcLoaded.workspaceTimezone, "UTC");

      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md"',
          'workspaceTimezone: "America/Los_Angeles"',
        ].join("\n") + "\n",
      );
      const ianaLoaded = await loadWorkspaceConfigOverrides(configPath);
      assertEquals(ianaLoaded.workspaceTimezone, "America/Los_Angeles");

      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md"',
          'workspaceTimezone: "US/Pacific"',
        ].join("\n") + "\n",
      );
      const aliasLoaded = await loadWorkspaceConfigOverrides(configPath);
      assertEquals(aliasLoaded.workspaceTimezone, "US/Pacific");

      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "conv.{YYYY}.{YY}-{MM}-{DD}_{HH}{mm}-{provider}.md"',
          'workspaceTimezone: "America/Los_Angeles"',
        ].join("\n") + "\n",
      );
      const componentsLoaded = await loadWorkspaceConfigOverrides(configPath);
      assertEquals(
        componentsLoaded.filenameTemplate,
        "conv.{YYYY}.{YY}-{MM}-{DD}_{HH}{mm}-{provider}.md",
      );
    },
  );
});

Deno.test("loadWorkspaceConfigOverrides rejects invalid workspaceTimezone", async () => {
  await withTestTempDir(
    "workspace-profile-timezone-invalid-",
    async (tempDir) => {
      const workspaceRoot = join(tempDir, "Timezone.Invalid");
      const configPath = join(
        workspaceRoot,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md"',
          'workspaceTimezone: "Mars/Olympus_Mons"',
        ].join("\n") + "\n",
      );

      await assertRejects(
        () => loadWorkspaceConfigOverrides(configPath),
        Error,
        "workspaceTimezone must be",
      );
    },
  );
});

Deno.test(
  "loadWorkspaceConfigOverrides rejects legacy filenameTemplateTimezone key",
  async () => {
    await withTestTempDir(
      "workspace-profile-timezone-legacy-key-",
      async (tempDir) => {
        const workspaceRoot = join(tempDir, "Timezone.Legacy.Key");
        const configPath = join(
          workspaceRoot,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        await Deno.mkdir(workspaceRoot, { recursive: true });
        await Deno.writeTextFile(
          configPath,
          [
            "defaultOutputDir: notes",
            'filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md"',
            'filenameTemplateTimezone: "UTC"',
          ].join("\n") + "\n",
        );

        await assertRejects(
          () => loadWorkspaceConfigOverrides(configPath),
          Error,
          "Unsupported workspace config key 'filenameTemplateTimezone'",
        );
      },
    );
  },
);

Deno.test("WorkspaceProfileResolver defaults workspaceTimezone to local when missing", async () => {
  await withTestTempDir(
    "workspace-profile-timezone-default-",
    async (tempDir) => {
      const workspaceRoot = join(tempDir, "Timezone.Default");
      const configPath = join(
        workspaceRoot,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{provider}-{sessionShortId}.md"',
        ].join("\n") + "\n",
      );

      const workspace = makeWorkspace({
        workspaceId: "ws-timezone-default",
        alias: "Timezone.Default",
        workspaceRoot,
        configPath,
      });
      const resolver = new WorkspaceProfileResolver();
      const profile = await resolver.resolveForCommand(workspace);
      assertEquals(profile.workspaceTimezone, "local");
    },
  );
});

Deno.test("loadWorkspaceConfigOverrides rejects removed and unknown filename template tokens", async () => {
  await withTestTempDir(
    "workspace-profile-template-tokens-",
    async (tempDir) => {
      const workspaceRoot = join(tempDir, "Token.Proj");
      const configPath = join(
        workspaceRoot,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.mkdir(workspaceRoot, { recursive: true });

      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{provider}-{timestampUtc}.md"',
        ].join("\n") + "\n",
      );
      await assertRejects(
        () => loadWorkspaceConfigOverrides(configPath),
        Error,
        "is no longer supported",
      );

      await Deno.writeTextFile(
        configPath,
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{provider}-{unknownToken}.md"',
        ].join("\n") + "\n",
      );
      await assertRejects(
        () => loadWorkspaceConfigOverrides(configPath),
        Error,
        "is unsupported",
      );
    },
  );
});

Deno.test("DefaultWorkspaceConfigFileStore allowMissing keeps workspaceTimezone-only templates", async () => {
  await withTestTempDir(
    "workspace-default-template-timezone-",
    async (tempDir) => {
      const configPath = join(tempDir, "default-kato-workspace-config.yaml");
      await Deno.writeTextFile(configPath, 'workspaceTimezone: "UTC"\n');

      const store = new DefaultWorkspaceConfigFileStore(configPath);
      const loaded = await store.load({ allowMissing: true });
      assertExists(loaded);
      assertEquals(loaded.workspaceTimezone, "UTC");
    },
  );
});
