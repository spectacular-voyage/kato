import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultSharedBehaviorConfig,
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
  registerWorkspace,
  resolveDefaultSharedConfigPath,
  setWorkspaceDisplayName,
  SharedBehaviorConfigFileStore,
  unregisterWorkspace,
  updateWorkspaceConfig,
  type WorkspaceConfigEditInput,
  WorkspaceRegistryFileStore,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

async function writeSharedConfig(katoDir: string): Promise<void> {
  const sharedDir = join(katoDir, "shared");
  await Deno.mkdir(sharedDir, { recursive: true });
  const store = new SharedBehaviorConfigFileStore(
    resolveDefaultSharedConfigPath(katoDir),
  );
  await store.ensureInitialized(
    createDefaultSharedBehaviorConfig({ allowedWriteRoots: [] }),
  );
}

Deno.test("registerWorkspace creates registry entry and updates shared write roots", async () => {
  await withTestTempDir("workspace-mutation-register-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const sharedDir = join(katoDir, "shared");
    const workspaceRoot = join(homeDir, "demo-workspace");
    const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
    await writeSharedConfig(katoDir);
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.writeTextFile(configPath, "defaultOutputDir: notes\n");

    const result = await registerWorkspace({
      katoDir,
      alias: "demo",
      displayName: " Demo Workspace ",
      workspacePath: workspaceRoot,
      now: () => new Date("2026-03-07T20:00:00.000Z"),
    });

    assertEquals(result.created, true);
    assertEquals(result.sharedWriteRootsUpdated, true);
    assertEquals(result.entry.alias, "demo");
    assertEquals(result.entry.displayName, "Demo Workspace");
    assertEquals(
      await readWorkspaceConfigWorkspaceId(configPath),
      result.entry.workspaceId,
    );

    const registry = await new WorkspaceRegistryFileStore(
      join(sharedDir, "workspace-registry.json"),
    ).load();
    assertEquals(registry.length, 1);
    assertEquals(registry[0]?.alias, "demo");
    assertEquals(registry[0]?.displayName, "Demo Workspace");
    assertEquals(result.sharedConfig.allowedWriteRoots, [workspaceRoot]);
  });
});

Deno.test("registerWorkspace defaults alias to the workspace folder name", async () => {
  await withTestTempDir(
    "workspace-mutation-default-alias-",
    async (homeDir) => {
      const katoDir = join(homeDir, ".kato");
      const workspaceRoot = join(homeDir, "demo-workspace");
      const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
      await writeSharedConfig(katoDir);
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.writeTextFile(configPath, "defaultOutputDir: notes\n");

      const result = await registerWorkspace({
        katoDir,
        workspacePath: workspaceRoot,
        now: () => new Date("2026-03-07T20:00:00.000Z"),
      });

      assertEquals(result.entry.alias, "demo-workspace");
    },
  );
});

Deno.test("setWorkspaceDisplayName saves trimmed labels and clears alias duplicates", async () => {
  await withTestTempDir(
    "workspace-mutation-display-name-",
    async (homeDir) => {
      const katoDir = join(homeDir, ".kato");
      const sharedDir = join(katoDir, "shared");
      const registryPath = join(sharedDir, "workspace-registry.json");
      const workspaceRoot = join(homeDir, "demo-workspace");
      await Deno.mkdir(sharedDir, { recursive: true });
      await Deno.writeTextFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-03-07T20:00:00.000Z",
          workspaces: [{
            workspaceId: "ws-1",
            alias: "demo",
            workspaceRoot,
            configPath: join(
              workspaceRoot,
              ".kato-workspace-config.yaml",
            ),
            registeredAt: "2026-03-07T20:00:00.000Z",
          }],
        }),
      );

      const savedResult = await setWorkspaceDisplayName({
        katoDir,
        selector: "demo",
        displayName: " Demo Workspace ",
        now: () => new Date("2026-03-07T20:30:00.000Z"),
      });
      assertEquals(savedResult.changed, true);
      assertEquals(savedResult.entry.displayName, "Demo Workspace");

      const savedRegistry = await new WorkspaceRegistryFileStore(
        registryPath,
      ).load();
      assertEquals(savedRegistry[0]?.displayName, "Demo Workspace");

      const clearedResult = await setWorkspaceDisplayName({
        katoDir,
        selector: "ws-1",
        displayName: " demo ",
        now: () => new Date("2026-03-07T21:00:00.000Z"),
      });
      assertEquals(clearedResult.changed, true);
      assertEquals(clearedResult.entry.displayName, undefined);

      const clearedRegistry = await new WorkspaceRegistryFileStore(
        registryPath,
      ).load();
      assertEquals(clearedRegistry[0]?.displayName, undefined);
    },
  );
});

Deno.test("registerWorkspace updates displayName without requiring restart when identity is unchanged", async () => {
  await withTestTempDir(
    "workspace-mutation-register-display-name-",
    async (homeDir) => {
      const katoDir = join(homeDir, ".kato");
      const sharedDir = join(katoDir, "shared");
      const workspaceRoot = join(homeDir, "demo-workspace");
      const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
      await writeSharedConfig(katoDir);
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.writeTextFile(configPath, "defaultOutputDir: notes\n");

      const initial = await registerWorkspace({
        katoDir,
        alias: "demo",
        workspacePath: workspaceRoot,
        now: () => new Date("2026-03-07T20:00:00.000Z"),
      });
      assertEquals(initial.entry.displayName, undefined);

      const updated = await registerWorkspace({
        katoDir,
        alias: "demo",
        displayName: " Demo Workspace ",
        workspacePath: workspaceRoot,
        now: () => new Date("2026-03-07T20:30:00.000Z"),
      });

      assertEquals(updated.created, false);
      assertEquals(updated.changed, true);
      assertEquals(updated.restartRequired, false);
      assertEquals(updated.entry.displayName, "Demo Workspace");

      const registry = await new WorkspaceRegistryFileStore(
        join(sharedDir, "workspace-registry.json"),
      ).load();
      assertEquals(registry[0]?.displayName, "Demo Workspace");
    },
  );
});

Deno.test("unregisterWorkspace removes an existing registry entry", async () => {
  await withTestTempDir(
    "workspace-mutation-unregister-",
    async (homeDir) => {
      const katoDir = join(homeDir, ".kato");
      const sharedDir = join(katoDir, "shared");
      await Deno.mkdir(sharedDir, { recursive: true });
      await Deno.writeTextFile(
        join(sharedDir, "workspace-registry.json"),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-03-07T20:00:00.000Z",
          workspaces: [{
            workspaceId: "ws-1",
            alias: "demo",
            workspaceRoot: join(homeDir, "demo-workspace"),
            configPath: join(
              homeDir,
              "demo-workspace",
              ".kato-workspace-config.yaml",
            ),
            registeredAt: "2026-03-07T20:00:00.000Z",
          }],
        }),
      );

      const result = await unregisterWorkspace({
        katoDir,
        selector: "demo",
      });
      assertEquals(result.entry.workspaceId, "ws-1");

      const registry = await new WorkspaceRegistryFileStore(
        join(sharedDir, "workspace-registry.json"),
      ).load();
      assertEquals(registry, []);
    },
  );
});

Deno.test("updateWorkspaceConfig writes editable workspace config fields", async () => {
  await withTestTempDir("workspace-mutation-config-edit-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const workspaceRoot = join(homeDir, "demo-workspace");
    const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
    await Deno.writeTextFile(
      configPath,
      [
        "workspaceId: ws-1",
        "defaultOutputDir: notes",
        'filenameTemplate: "{provider}.md"',
      ].join("\n") + "\n",
    );
    await new WorkspaceRegistryFileStore(
      join(katoDir, "shared", "workspace-registry.json"),
    ).save([{
      workspaceId: "ws-1",
      alias: "demo",
      workspaceRoot,
      configPath,
      registeredAt: "2026-03-07T20:00:00.000Z",
    }]);

    const result = await updateWorkspaceConfig({
      katoDir,
      selector: "demo",
      edits: {
        autoRecordConversations: true,
        defaultOutputDir: "notes/{provider}",
        filenameTemplate: "{YYYY}-{MM}-{DD}-{provider}.md",
        workspaceTimezone: "UTC",
        defaultTags: [" workspace ", "research"],
        tagSuggestions: ["research", "journal"],
        markdownFrontmatter: {
          includeFrontmatterInMarkdownRecordings: false,
          includeUpdatedInFrontmatter: true,
          addParticipantUsernameToFrontmatter: true,
          addParticipantUsernameToHeadings: true,
          includeSessionIds: true,
          includeWorkspaceIds: true,
          includeRecordingIds: true,
          includeConversationEventKinds: true,
        },
        writerFeatureFlags: {
          writerIncludeCommentary: false,
          writerIncludeThinking: false,
          writerIncludeToolCalls: true,
          writerIncludeToolResults: true,
          writerIncludeDecisionPrompt: false,
          writerIncludeDecisionOptions: false,
          writerIncludeDecisionSelection: false,
          writerItalicizeUserMessages: true,
          writerRelativizeLocalLinks: false,
          writerUseDendronStyleWikilinks: true,
        },
      },
    });

    assertEquals(result.changed, true);
    assertEquals(result.resolved.autoRecordConversations, true);
    assertEquals(result.resolved.defaultOutputDir, "notes/{provider}");
    assertEquals(
      result.resolved.filenameTemplate,
      "{YYYY}-{MM}-{DD}-{provider}.md",
    );
    assertEquals(result.resolved.workspaceTimezone, "UTC");
    assertEquals(result.resolved.defaultTags, ["workspace", "research"]);
    assertEquals(result.resolved.tagSuggestions, ["research", "journal"]);
    assertEquals(
      result.resolved.markdownFrontmatter
        .includeFrontmatterInMarkdownRecordings,
      false,
    );
    assertEquals(
      result.resolved.markdownFrontmatter.includeUpdatedInFrontmatter,
      true,
    );
    assertEquals(
      result.resolved.writerFeatureFlags.writerRelativizeLocalLinks,
      false,
    );
    assertEquals(
      result.resolved.writerFeatureFlags.writerUseDendronStyleWikilinks,
      true,
    );

    const loaded = await loadWorkspaceConfigOverrides(configPath);
    assertEquals(loaded.autoRecordConversations, true);
    assertEquals(loaded.defaultOutputDir, "notes/{provider}");
    assertEquals(loaded.filenameTemplate, "{YYYY}-{MM}-{DD}-{provider}.md");
    assertEquals(loaded.workspaceTimezone, "UTC");
    assertEquals(loaded.defaultTags, ["workspace", "research"]);
    assertEquals(loaded.tagSuggestions, ["research", "journal"]);
    assertEquals(loaded.markdownFrontmatter?.includeWorkspaceIds, true);
    assertEquals(loaded.writerFeatureFlags.writerIncludeToolCalls, true);
    assertEquals(
      loaded.writerFeatureFlags.writerUseDendronStyleWikilinks,
      true,
    );
  });
});

Deno.test("updateWorkspaceConfig preserves omitted optional fields as inherited defaults", async () => {
  await withTestTempDir(
    "workspace-mutation-config-edit-partial-",
    async (homeDir) => {
      const katoDir = join(homeDir, ".kato");
      const workspaceRoot = join(homeDir, "demo-workspace");
      const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
      await Deno.writeTextFile(configPath, "workspaceId: ws-1\n");
      await new WorkspaceRegistryFileStore(
        join(katoDir, "shared", "workspace-registry.json"),
      ).save([{
        workspaceId: "ws-1",
        alias: "demo",
        workspaceRoot,
        configPath,
        registeredAt: "2026-03-07T20:00:00.000Z",
      }]);

      const result = await updateWorkspaceConfig({
        katoDir,
        selector: "ws-1",
        edits: {
          filenameTemplate: "{provider}-{sessionShortId}.md",
        },
      });

      const loaded = await loadWorkspaceConfigOverrides(configPath);
      assertEquals(result.resolved.defaultOutputDir, ".");
      assertEquals(result.resolved.workspaceTimezone, "local");
      assertEquals(loaded.defaultOutputDir, undefined);
      assertEquals(loaded.workspaceTimezone, undefined);
      assertEquals(loaded.filenameTemplate, "{provider}-{sessionShortId}.md");
      assertEquals(Object.keys(loaded.writerFeatureFlags), []);
    },
  );
});

Deno.test("updateWorkspaceConfig rejects invalid edits and preserves config", async () => {
  await withTestTempDir(
    "workspace-mutation-config-edit-invalid-",
    async (homeDir) => {
      const katoDir = join(homeDir, ".kato");
      const workspaceRoot = join(homeDir, "demo-workspace");
      const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
      await Deno.writeTextFile(
        configPath,
        [
          "workspaceId: ws-1",
          "defaultOutputDir: notes",
          'filenameTemplate: "{provider}.md"',
        ].join("\n") + "\n",
      );
      await new WorkspaceRegistryFileStore(
        join(katoDir, "shared", "workspace-registry.json"),
      ).save([{
        workspaceId: "ws-1",
        alias: "demo",
        workspaceRoot,
        configPath,
        registeredAt: "2026-03-07T20:00:00.000Z",
      }]);

      const assertPreserved = async (
        edits: WorkspaceConfigEditInput,
        expectedMessage: string,
      ) => {
        const before = await Deno.readTextFile(configPath);
        await assertRejects(
          () =>
            updateWorkspaceConfig({
              katoDir,
              selector: "demo",
              edits,
            }),
          Error,
          expectedMessage,
        );
        assertEquals(await Deno.readTextFile(configPath), before);
      };

      await assertPreserved(
        { filenameTemplate: "{timestampUtc}-{provider}.md" },
        "filenameTemplate token '{timestampUtc}' is no longer supported",
      );
      await assertPreserved(
        { defaultOutputDir: "notes/{unknownToken}" },
        "defaultOutputDir token '{unknownToken}' is unsupported",
      );
      await assertPreserved(
        { workspaceTimezone: "Mars/Olympus_Mons" },
        "workspaceTimezone must be",
      );
      await assertPreserved(
        {
          writerFeatureFlags: {
            writerRelativizeLocalLinks: "yes",
          } as unknown as WorkspaceConfigEditInput["writerFeatureFlags"],
        },
        "workspaceFeatureFlags.writerRelativizeLocalLinks must be a boolean",
      );
    },
  );
});

Deno.test("registerWorkspace rejects duplicate aliases for different workspaces", async () => {
  await withTestTempDir("workspace-mutation-conflict-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const sharedDir = join(katoDir, "shared");
    const workspaceRoot = join(homeDir, "another-workspace");
    await writeSharedConfig(katoDir);
    await Deno.mkdir(workspaceRoot, { recursive: true });
    await Deno.writeTextFile(
      join(sharedDir, "workspace-registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-03-07T20:00:00.000Z",
        workspaces: [{
          workspaceId: "ws-1",
          alias: "demo",
          workspaceRoot: join(homeDir, "demo-workspace"),
          configPath: join(
            homeDir,
            "demo-workspace",
            ".kato-workspace-config.yaml",
          ),
          registeredAt: "2026-03-07T20:00:00.000Z",
        }],
      }),
    );
    await Deno.writeTextFile(
      join(workspaceRoot, ".kato-workspace-config.yaml"),
      "defaultOutputDir: notes\n",
    );

    await assertRejects(
      () =>
        registerWorkspace({
          katoDir,
          alias: "demo",
          workspacePath: workspaceRoot,
        }),
      Error,
      "Workspace alias already registered",
    );
  });
});
