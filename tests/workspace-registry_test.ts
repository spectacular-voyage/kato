import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createWorkspaceConfigScaffold,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  DefaultWorkspaceConfigFileStore,
  loadWorkspaceConfigOverrides,
  type RegisteredWorkspace,
  WorkspaceCatalog,
  WorkspaceProfileResolver,
  type WorkspaceRegistryStoreLike,
} from "../apps/daemon/src/mod.ts";
import { resolveTestTempPath, withTestTempDir } from "./test_temp.ts";

function cloneWorkspace(entry: RegisteredWorkspace): RegisteredWorkspace {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
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
    ...(overrides.displayName ? { displayName: overrides.displayName } : {}),
    workspaceRoot: overrides.workspaceRoot ??
      resolveTestTempPath("workspaces", overrides.workspaceId),
    configPath: overrides.configPath ??
      join(
        resolveTestTempPath("workspaces", overrides.workspaceId),
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      ),
    registeredAt: overrides.registeredAt ?? "2026-03-01T10:00:00.000Z",
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
  };
}

Deno.test("loadWorkspaceConfigOverrides supports auto-recording settings", async () => {
  await withTestTempDir("workspace-profile-auto-record-", async (tempDir) => {
    const workspaceRoot = join(tempDir, "AutoRecord.Proj");
    const configPath = join(
      workspaceRoot,
      DEFAULT_WORKSPACE_CONFIG_FILENAME,
    );
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      [
        "autoRecordConversations: true",
        "defaultOutputDir: notes",
        'filenameTemplate: "{provider}.md"',
      ].join("\n") + "\n",
    );

    const loaded = await loadWorkspaceConfigOverrides(configPath);
    assertEquals(loaded.autoRecordConversations, true);

    const profile = await new WorkspaceProfileResolver().resolveForCommand(
      makeWorkspace({
        workspaceId: "ws-auto-record",
        alias: "auto",
        workspaceRoot,
        configPath,
      }),
    );
    assertEquals(profile.autoRecordConversations, true);
    assertEquals(
      createWorkspaceConfigScaffold().includes(
        "autoRecordConversations: false",
      ),
      true,
    );
    assertEquals(
      createWorkspaceConfigScaffold().includes("autoRecordRoots: []"),
      true,
    );
  });
});

Deno.test("loadWorkspaceConfigOverrides parses and resolves autoRecordRoots", async () => {
  await withTestTempDir("workspace-auto-record-roots-", async (tempDir) => {
    const workspaceRoot = join(tempDir, "project", "notes");
    const configPath = join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
    const repoRoot = join(tempDir, "project");
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      [
        "autoRecordConversations: true",
        "autoRecordRoots:",
        `  - ${repoRoot}`,
        "  - ../..",
        `  - ${repoRoot}`,
        "defaultOutputDir: .",
      ].join("\n") + "\n",
    );

    const loaded = await loadWorkspaceConfigOverrides(configPath);
    assertEquals(loaded.autoRecordRoots, [repoRoot, "../..", repoRoot]);

    const profile = await new WorkspaceProfileResolver().resolveForCommand(
      makeWorkspace({
        workspaceId: "ws-roots",
        alias: "roots",
        workspaceRoot,
        configPath,
      }),
    );
    // Absolute entries stay put, relative entries resolve against the
    // workspace root, exact duplicates are dropped.
    assertEquals(profile.autoRecordRoots, [repoRoot, tempDir]);
  });
});

Deno.test("loadWorkspaceConfigOverrides rejects malformed autoRecordRoots", async () => {
  await withTestTempDir("workspace-auto-record-roots-bad-", async (tempDir) => {
    const workspaceRoot = join(tempDir, "notes");
    const configPath = join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
    await Deno.mkdir(workspaceRoot, { recursive: true });

    await Deno.writeTextFile(
      configPath,
      "autoRecordRoots: not-a-list\n",
    );
    await assertRejects(
      () => loadWorkspaceConfigOverrides(configPath),
      Error,
      "autoRecordRoots must be a list",
    );

    await Deno.writeTextFile(
      configPath,
      ["autoRecordRoots:", "  - ''", ""].join("\n"),
    );
    await assertRejects(
      () => loadWorkspaceConfigOverrides(configPath),
      Error,
      "autoRecordRoots entries must be non-empty strings",
    );

    await Deno.writeTextFile(
      configPath,
      ["autoRecordRoots:", "  - 7", ""].join("\n"),
    );
    await assertRejects(
      () => loadWorkspaceConfigOverrides(configPath),
      Error,
      "autoRecordRoots entries must be non-empty strings",
    );
  });
});

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
  "WorkspaceCatalog refreshes displayName-only changes",
  async () => {
    const first = makeWorkspace({
      workspaceId: "ws-1",
      alias: "My.Proj",
    });
    const { store, setEntries } = makeInMemoryWorkspaceRegistryStore([first]);
    const catalog = new WorkspaceCatalog(store);

    const initial = await catalog.getByAlias("My.Proj");
    assertExists(initial);
    assertEquals(initial.displayName, undefined);

    await setEntries([{
      ...first,
      displayName: "Docs Workspace",
      updatedAt: "2026-03-01T10:05:00.000Z",
    }]);

    const updated = await catalog.getByAlias("My.Proj");
    assertExists(updated);
    assertEquals(updated.displayName, "Docs Workspace");
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
          "  writerUseDendronStyleWikilinks: false",
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
        first.writerFeatureFlags.writerUseDendronStyleWikilinks,
        false,
      );
      assertEquals(
        first.writerFeatureFlags.writerRelativizeLocalLinks,
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
          "  writerRelativizeLocalLinks: false",
          "  writerUseDendronStyleWikilinks: true",
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
      assertEquals(
        second.writerFeatureFlags.writerUseDendronStyleWikilinks,
        true,
      );
      assertEquals(
        second.writerFeatureFlags.writerRelativizeLocalLinks,
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

Deno.test("loadWorkspaceConfigOverrides normalizes workspace default tags and tag suggestions", async () => {
  await withTestTempDir("workspace-profile-tags-", async (tempDir) => {
    const workspaceRoot = join(tempDir, "Tags.Proj");
    const configPath = join(
      workspaceRoot,
      DEFAULT_WORKSPACE_CONFIG_FILENAME,
    );
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      [
        "defaultOutputDir: notes",
        "defaultTags:",
        '  - " alpha "',
        "  - beta",
        "  - alpha",
        "tagSuggestions:",
        "  - topic",
        '  - " topic "',
      ].join("\n") + "\n",
    );

    const loaded = await loadWorkspaceConfigOverrides(configPath);
    assertEquals(loaded.defaultTags, ["alpha", "beta"]);
    assertEquals(loaded.tagSuggestions, ["topic"]);

    const workspace = makeWorkspace({
      workspaceId: "ws-tags",
      alias: "Tags.Proj",
      workspaceRoot,
      configPath,
    });
    const profile = await new WorkspaceProfileResolver().resolveForCommand(
      workspace,
    );
    assertEquals(profile.defaultTags, ["alpha", "beta"]);
    assertEquals(profile.tagSuggestions, ["topic"]);
  });
});

Deno.test("WorkspaceProfileResolver isolates cached tag arrays from callers", async () => {
  await withTestTempDir("workspace-profile-cache-tags-", async (tempDir) => {
    const workspaceRoot = join(tempDir, "Cached.Tags");
    const configPath = join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      [
        "defaultTags:",
        "  - alpha",
        "tagSuggestions:",
        "  - topic",
      ].join("\n") + "\n",
    );
    const workspace = makeWorkspace({
      workspaceId: "ws-cache-tags",
      workspaceRoot,
      configPath,
    });
    const resolver = new WorkspaceProfileResolver();

    const first = await resolver.resolveForCommand(workspace);
    first.defaultTags.push("mutated-first");
    first.tagSuggestions.push("mutated-first");

    const second = await resolver.resolveForCommand(workspace);
    assertEquals(second.defaultTags, ["alpha"]);
    assertEquals(second.tagSuggestions, ["topic"]);
    second.defaultTags.push("mutated-second");
    second.tagSuggestions.push("mutated-second");

    const third = await resolver.resolveForCommand(workspace);
    assertEquals(third.defaultTags, ["alpha"]);
    assertEquals(third.tagSuggestions, ["topic"]);
  });
});

Deno.test("loadWorkspaceConfigOverrides rejects malformed workspace tag fields", async () => {
  await withTestTempDir("workspace-profile-tags-invalid-", async (tempDir) => {
    const workspaceRoot = join(tempDir, "Tags.Invalid");
    const configPath = join(
      workspaceRoot,
      DEFAULT_WORKSPACE_CONFIG_FILENAME,
    );
    await Deno.mkdir(workspaceRoot, { recursive: true });

    await Deno.writeTextFile(
      configPath,
      [
        "defaultOutputDir: notes",
        "defaultTags:",
        '  - ""',
      ].join("\n") + "\n",
    );
    await assertRejects(
      () => loadWorkspaceConfigOverrides(configPath),
      Error,
      "defaultTags[0] must be a non-empty string",
    );

    await Deno.writeTextFile(
      configPath,
      [
        "defaultOutputDir: notes",
        "tagSuggestions:",
        "  - 42",
      ].join("\n") + "\n",
    );
    await assertRejects(
      () => loadWorkspaceConfigOverrides(configPath),
      Error,
      "tagSuggestions must contain only strings",
    );
  });
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
