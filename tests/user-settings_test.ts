import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  clearDefaultUsername,
  createDefaultUserConfig,
  deleteWorkspaceUsernameMapping,
  loadUserSettings,
  setDefaultUsername,
  setExcludeMeFromParticipantList,
  setGlobalTagSuggestions,
  setWorkspaceTagSuggestions,
  setWorkspaceUsernameMapping,
  UserConfigFileStore,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

Deno.test("loadUserSettings initializes default config and empty mappings", async () => {
  await withTestTempDir("user-settings-load-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const result = await loadUserSettings({ katoDir });
    assertEquals(result.config, createDefaultUserConfig());
    assertEquals(result.mappings, []);
    assertEquals(result.workspaces, []);
  });
});

Deno.test("setDefaultUsername and clearDefaultUsername update user config", async () => {
  await withTestTempDir("user-settings-default-", async (homeDir) => {
    const userConfigStore = new UserConfigFileStore(
      join(homeDir, ".kato", "kato-user-config.yaml"),
    );

    const setResult = await setDefaultUsername({
      username: "  Dj Radon  ",
      userConfigStore,
    });
    assertEquals(setResult.username, "Dj Radon");

    const clearResult = await clearDefaultUsername({ userConfigStore });
    assertEquals(clearResult.config.participants.defaultUsername, "");
  });
});

Deno.test("setWorkspaceUsernameMapping and deleteWorkspaceUsernameMapping use registered workspaces", async () => {
  await withTestTempDir("user-settings-mapping-", async (homeDir) => {
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
      katoDir,
      selector: "demo",
      username: " Case.User ",
    });
    assertEquals(setResult.workspaceId, "ws-1");
    assertEquals(setResult.workspaceAlias, "demo");
    assertEquals(setResult.username, "Case.User");

    const userConfigStore = new UserConfigFileStore(
      join(katoDir, "kato-user-config.yaml"),
    );
    const saved = await userConfigStore.load();
    assertEquals(saved.participants.workspaceUsernames, {
      "ws-1": "Case.User",
    });
    const loaded = await loadUserSettings({ katoDir });
    assertEquals(loaded.workspaces[0]?.displayName, "Demo Workspace");
    assertEquals(
      loaded.mappings[0]?.workspaceDisplayName,
      "Demo Workspace",
    );

    const deleteResult = await deleteWorkspaceUsernameMapping({
      katoDir,
      selector: "demo",
    });
    assertEquals(deleteResult.deleted, true);

    const afterDelete = await userConfigStore.load();
    assertEquals(afterDelete.participants.workspaceUsernames, {});
  });
});

Deno.test("setExcludeMeFromParticipantList updates the boolean flag", async () => {
  await withTestTempDir("user-settings-exclude-me-", async (homeDir) => {
    const userConfigStore = new UserConfigFileStore(
      join(homeDir, ".kato", "kato-user-config.yaml"),
    );
    const result = await setExcludeMeFromParticipantList({
      value: false,
      userConfigStore,
    });
    assertEquals(result.value, false);

    const saved = await userConfigStore.load();
    assertEquals(saved.participants.excludeMeFromParticipantList, false);
  });
});

Deno.test("setGlobalTagSuggestions and setWorkspaceTagSuggestions update personal tag libraries", async () => {
  await withTestTempDir("user-settings-tags-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const sharedDir = join(katoDir, "shared");
    await Deno.mkdir(sharedDir, { recursive: true });
    await Deno.writeTextFile(
      join(sharedDir, "workspace-registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-03-07T20:00:00.000Z",
        workspaces: [{
          workspaceId: "ws-tags",
          alias: "tags",
          displayName: "Tags Workspace",
          workspaceRoot: join(homeDir, "tags-workspace"),
          configPath: join(
            homeDir,
            "tags-workspace",
            ".kato-workspace-config.yaml",
          ),
          registeredAt: "2026-03-07T20:00:00.000Z",
        }],
      }),
    );

    const globalResult = await setGlobalTagSuggestions({
      userConfigStore: new UserConfigFileStore(
        join(katoDir, "kato-user-config.yaml"),
      ),
      tags: [" alpha ", "beta", "alpha"],
    });
    assertEquals(globalResult.tags, ["alpha", "beta"]);

    const workspaceResult = await setWorkspaceTagSuggestions({
      katoDir,
      selector: "tags",
      tags: ["local", " local "],
    });
    assertEquals(workspaceResult.workspaceId, "ws-tags");
    assertEquals(workspaceResult.tags, ["local"]);

    const loaded = await loadUserSettings({ katoDir });
    assertEquals(loaded.config.tagLibraries?.globalSuggestions, [
      "alpha",
      "beta",
    ]);
    assertEquals(loaded.tagLibraryMappings, [{
      workspaceId: "ws-tags",
      workspaceAlias: "tags",
      workspaceDisplayName: "Tags Workspace",
      tags: ["local"],
    }]);
  });
});

Deno.test("loadUserSettings and workspace mapping honor an explicit katoDir", async () => {
  await withTestTempDir("user-settings-katodir-", async (homeDir) => {
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
});
