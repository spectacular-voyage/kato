import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultSharedBehaviorConfig,
  readWorkspaceConfigWorkspaceId,
  registerWorkspace,
  resolveDefaultSharedConfigPath,
  setWorkspaceDisplayName,
  SharedBehaviorConfigFileStore,
  unregisterWorkspace,
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
