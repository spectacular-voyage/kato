import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  clearDefaultUsername,
  createDefaultUserConfig,
  deleteWorkspaceUsernameMapping,
  loadUserSettings,
  setDefaultUsername,
  setExcludeMeFromParticipantList,
  setWorkspaceUsernameMapping,
  UserConfigFileStore,
} from "../apps/runtime/src/mod.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

Deno.test("loadUserSettings initializes default config and empty mappings", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("user-settings-load-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const result = await loadUserSettings();
        assertEquals(result.config, createDefaultUserConfig());
        assertEquals(result.mappings, []);
        assertEquals(result.workspaces, []);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("setDefaultUsername and clearDefaultUsername update user config", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("user-settings-default-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const setResult = await setDefaultUsername({
          username: "  Dj Radon  ",
        });
        assertEquals(setResult.username, "Dj Radon");

        const clearResult = await clearDefaultUsername();
        assertEquals(clearResult.config.participants.defaultUsername, "");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("setWorkspaceUsernameMapping and deleteWorkspaceUsernameMapping use registered workspaces", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("user-settings-mapping-", async (homeDir) => {
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
              displayName: "Demo Workspace",
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

        const setResult = await setWorkspaceUsernameMapping({
          selector: "demo",
          username: " Case.User ",
        });
        assertEquals(setResult.workspaceId, "ws-1");
        assertEquals(setResult.workspaceAlias, "demo");
        assertEquals(setResult.username, "Case.User");

        const userConfigStore = new UserConfigFileStore(
          join(homeDir, ".kato", "kato-user-config.yaml"),
        );
        const saved = await userConfigStore.load();
        assertEquals(saved.participants.workspaceUsernames, {
          "ws-1": "Case.User",
        });
        const loaded = await loadUserSettings();
        assertEquals(loaded.workspaces[0]?.displayName, "Demo Workspace");
        assertEquals(
          loaded.mappings[0]?.workspaceDisplayName,
          "Demo Workspace",
        );

        const deleteResult = await deleteWorkspaceUsernameMapping({
          selector: "demo",
        });
        assertEquals(deleteResult.deleted, true);

        const afterDelete = await userConfigStore.load();
        assertEquals(afterDelete.participants.workspaceUsernames, {});
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("setExcludeMeFromParticipantList updates the boolean flag", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("user-settings-exclude-me-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const result = await setExcludeMeFromParticipantList({ value: false });
        assertEquals(result.value, false);

        const saved = await new UserConfigFileStore(
          join(homeDir, ".kato", "kato-user-config.yaml"),
        ).load();
        assertEquals(saved.participants.excludeMeFromParticipantList, false);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadUserSettings and workspace mapping honor an explicit katoDir", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();
    try {
      await withTestTempDir("user-settings-katodir-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, "custom-kato");
        const sharedDir = join(katoDir, "shared");
        await Deno.mkdir(sharedDir, { recursive: true });
        await Deno.writeTextFile(
          join(sharedDir, "workspace-registry.json"),
          JSON.stringify({
            schemaVersion: 1,
            updatedAt: "2026-03-07T20:00:00.000Z",
            workspaces: [{
              workspaceId: "ws-explicit",
              alias: "explicit",
              workspaceRoot: join(homeDir, "explicit-workspace"),
              configPath: join(
                homeDir,
                "explicit-workspace",
                ".kato-workspace-config.yaml",
              ),
              registeredAt: "2026-03-07T20:00:00.000Z",
            }],
          }),
        );

        const initial = await loadUserSettings({ katoDir });
        assertEquals(initial.config, createDefaultUserConfig());

        await setWorkspaceUsernameMapping({
          katoDir,
          selector: "explicit",
          username: "named-user",
        });

        const saved = await new UserConfigFileStore(
          join(katoDir, "kato-user-config.yaml"),
        ).load();
        assertEquals(saved.participants.workspaceUsernames, {
          "ws-explicit": "named-user",
        });
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
