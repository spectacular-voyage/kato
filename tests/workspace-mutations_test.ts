import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  readWorkspaceConfigWorkspaceId,
  registerWorkspace,
  unregisterWorkspace,
  WorkspaceRegistryFileStore,
} from "../apps/runtime/src/mod.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

Deno.test("registerWorkspace creates registry entry and updates shared write roots", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("workspace-mutation-register-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const sharedDir = join(homeDir, ".kato", "shared");
        const workspaceRoot = join(homeDir, "demo-workspace");
        const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
        await Deno.mkdir(sharedDir, { recursive: true });
        await Deno.mkdir(workspaceRoot, { recursive: true });
        await Deno.writeTextFile(
          join(sharedDir, "kato-shared-config.yaml"),
          [
            "schemaVersion: 1",
            "allowedWriteRoots: []",
            "exportTimezone: local",
            "exportMarkdownFrontmatter: {}",
            "exportFeatureFlags: {}",
          ].join("\n") + "\n",
        );
        await Deno.writeTextFile(configPath, "defaultOutputDir: notes\n");

        const result = await registerWorkspace({
          alias: "demo",
          workspacePath: workspaceRoot,
          now: () => new Date("2026-03-07T20:00:00.000Z"),
        });

        assertEquals(result.created, true);
        assertEquals(result.sharedWriteRootsUpdated, true);
        assertEquals(result.entry.alias, "demo");
        assertEquals(
          await readWorkspaceConfigWorkspaceId(configPath),
          result.entry.workspaceId,
        );

        const registry = await new WorkspaceRegistryFileStore(
          join(sharedDir, "workspace-registry.json"),
        ).load();
        assertEquals(registry.length, 1);
        assertEquals(registry[0]?.alias, "demo");
        assertEquals(result.sharedConfig.allowedWriteRoots, [workspaceRoot]);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("registerWorkspace defaults alias to the workspace folder name", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "workspace-mutation-default-alias-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const sharedDir = join(homeDir, ".kato", "shared");
          const workspaceRoot = join(homeDir, "demo-workspace");
          const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
          await Deno.mkdir(sharedDir, { recursive: true });
          await Deno.mkdir(workspaceRoot, { recursive: true });
          await Deno.writeTextFile(
            join(sharedDir, "kato-shared-config.yaml"),
            [
              "schemaVersion: 1",
              "allowedWriteRoots: []",
              "exportTimezone: local",
              "exportMarkdownFrontmatter: {}",
              "exportFeatureFlags: {}",
            ].join("\n") + "\n",
          );
          await Deno.writeTextFile(configPath, "defaultOutputDir: notes\n");

          const result = await registerWorkspace({
            workspacePath: workspaceRoot,
            now: () => new Date("2026-03-07T20:00:00.000Z"),
          });

          assertEquals(result.entry.alias, "demo-workspace");
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("unregisterWorkspace removes an existing registry entry", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir(
        "workspace-mutation-unregister-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const sharedDir = join(homeDir, ".kato", "shared");
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

          const result = await unregisterWorkspace({ selector: "demo" });
          assertEquals(result.entry.workspaceId, "ws-1");

          const registry = await new WorkspaceRegistryFileStore(
            join(sharedDir, "workspace-registry.json"),
          ).load();
          assertEquals(registry, []);
        },
      );
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("registerWorkspace rejects duplicate aliases for different workspaces", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("workspace-mutation-conflict-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const sharedDir = join(homeDir, ".kato", "shared");
        const workspaceRoot = join(homeDir, "another-workspace");
        await Deno.mkdir(sharedDir, { recursive: true });
        await Deno.mkdir(workspaceRoot, { recursive: true });
        await Deno.writeTextFile(
          join(sharedDir, "kato-shared-config.yaml"),
          [
            "schemaVersion: 1",
            "allowedWriteRoots: []",
            "exportTimezone: local",
            "exportMarkdownFrontmatter: {}",
            "exportFeatureFlags: {}",
          ].join("\n") + "\n",
        );
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
              alias: "demo",
              workspacePath: workspaceRoot,
            }),
          Error,
          "Workspace alias already registered",
        );
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
