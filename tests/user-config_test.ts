import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultUserConfig,
  UserConfigFileStore,
  validateAndNormalizeParticipantUsername,
} from "../apps/daemon/src/mod.ts";
import { cloneUserConfig } from "../apps/runtime/src/config/user_config.ts";
import { makeTestTempDir, removePathIfPresent } from "./test_temp.ts";

Deno.test("cloneUserConfig isolates nested participant and tag collections", () => {
  const source = createDefaultUserConfig(
    { workspaceUsernames: { "ws-alpha": "Alice" } },
    {
      globalSuggestions: ["global"],
      workspaceSuggestions: { "ws-alpha": ["workspace"] },
    },
  );
  const cloned = cloneUserConfig(source);

  cloned.participants.workspaceUsernames["ws-alpha"] = "Changed";
  cloned.tagLibraries?.globalSuggestions.push("changed");
  cloned.tagLibraries?.workspaceSuggestions["ws-alpha"]?.push("changed");

  assertEquals(source.participants.workspaceUsernames, {
    "ws-alpha": "Alice",
  });
  assertEquals(source.tagLibraries?.globalSuggestions, ["global"]);
  assertEquals(source.tagLibraries?.workspaceSuggestions, {
    "ws-alpha": ["workspace"],
  });
});

Deno.test("UserConfigFileStore ensureInitialized creates scaffold and reloads", async () => {
  const tempDir = await makeTestTempDir("user-config-init-");
  const configPath = join(tempDir, "kato-user-config.yaml");
  const store = new UserConfigFileStore(configPath);

  try {
    const initialized = await store.ensureInitialized();
    assertEquals(initialized.created, true);
    assertEquals(initialized.path, configPath);
    assertEquals(initialized.config, createDefaultUserConfig());

    const raw = await Deno.readTextFile(configPath);
    assertStringIncludes(raw, "schemaVersion: 1");
    assertStringIncludes(raw, "defaultUsername: ''");
    assertStringIncludes(raw, "workspaceUsernames: {}");
    assertStringIncludes(raw, "excludeMeFromParticipantList: true");
    assertStringIncludes(raw, "tagLibraries:");
    assertStringIncludes(raw, "globalSuggestions: []");
    assertStringIncludes(raw, "workspaceSuggestions: {}");

    const loaded = await store.load();
    assertEquals(loaded, createDefaultUserConfig());

    const second = await store.ensureInitialized();
    assertEquals(second.created, false);
  } finally {
    await removePathIfPresent(tempDir);
  }
});

Deno.test("UserConfigFileStore parses valid config and normalizes usernames", async () => {
  const tempDir = await makeTestTempDir("user-config-parse-valid-");
  const configPath = join(tempDir, "kato-user-config.yaml");
  const store = new UserConfigFileStore(configPath);

  try {
    await Deno.writeTextFile(
      configPath,
      [
        "schemaVersion: 1",
        "participants:",
        '  defaultUsername: "  Dj Radon  "',
        "  workspaceUsernames:",
        '    workspace-1: "  Case.User  "',
        "  excludeMeFromParticipantList: false",
        "tagLibraries:",
        "  globalSuggestions:",
        '    - "  alpha  "',
        "    - beta",
        "    - alpha",
        "  workspaceSuggestions:",
        "    workspace-1:",
        "      - gamma",
        '      - " gamma "',
        "",
      ].join("\n"),
    );

    const loaded = await store.load();
    assertEquals(loaded.participants.defaultUsername, "Dj Radon");
    assertEquals(
      loaded.participants.workspaceUsernames,
      { "workspace-1": "Case.User" },
    );
    assertEquals(loaded.participants.excludeMeFromParticipantList, false);
    assertEquals(loaded.tagLibraries, {
      globalSuggestions: ["alpha", "beta"],
      workspaceSuggestions: { "workspace-1": ["gamma"] },
    });
  } finally {
    await removePathIfPresent(tempDir);
  }
});

Deno.test("UserConfigFileStore rejects unknown keys and invalid types", async () => {
  const tempDir = await makeTestTempDir("user-config-invalid-shape-");
  const configPath = join(tempDir, "kato-user-config.yaml");
  const store = new UserConfigFileStore(configPath);

  try {
    const invalidDocuments = [
      [
        "participants:",
        '  defaultUsername: ""',
        "  workspaceUsernames: {}",
        "  excludeMeFromParticipantList: true",
        "",
      ].join("\n"),
      [
        "schemaVersion: 1",
        "participants:",
        '  defaultUsername: ""',
        "  workspaceUsernames: {}",
        "  excludeMeFromParticipantList: true",
        "extra: true",
        "",
      ].join("\n"),
      [
        "schemaVersion: 1",
        "participants:",
        '  defaultUsername: ""',
        "  workspaceUsernames: []",
        "  excludeMeFromParticipantList: true",
        "",
      ].join("\n"),
      [
        "schemaVersion: 1",
        "participants:",
        '  defaultUsername: ""',
        "  workspaceUsernames:",
        "    workspace-1: 42",
        "  excludeMeFromParticipantList: true",
        "",
      ].join("\n"),
      [
        "schemaVersion: 1",
        "participants:",
        '  defaultUsername: ""',
        "  workspaceUsernames: {}",
        "  excludeMeFromParticipantList: maybe",
        "",
      ].join("\n"),
      [
        "schemaVersion: 1",
        "participants:",
        '  defaultUsername: ""',
        "  workspaceUsernames: {}",
        "  excludeMeFromParticipantList: true",
        "tagLibraries:",
        "  globalSuggestions:",
        '    - ""',
        "",
      ].join("\n"),
      [
        "schemaVersion: 1",
        "participants:",
        '  defaultUsername: ""',
        "  workspaceUsernames: {}",
        "  excludeMeFromParticipantList: true",
        "tagLibraries:",
        "  workspaceSuggestions:",
        "    workspace-1:",
        "      - 42",
        "",
      ].join("\n"),
    ];

    for (const doc of invalidDocuments) {
      await Deno.writeTextFile(configPath, doc);
      const error = await assertRejects(
        () => store.load(),
        Error,
        "unsupported schema",
      );
      assertStringIncludes(error.message, "UserConfig");
      assertStringIncludes(error.message, "UserParticipantsConfig");
      assertStringIncludes(error.message, "schemaVersion: 1");
      assertStringIncludes(
        error.message,
        "unknown keys or a missing schemaVersion",
      );
    }
  } finally {
    await removePathIfPresent(tempDir);
  }
});

Deno.test("validateAndNormalizeParticipantUsername enforces trim, control-char, and length rules", () => {
  assertEquals(
    validateAndNormalizeParticipantUsername("  Alice  "),
    "Alice",
  );
  assertEquals(
    validateAndNormalizeParticipantUsername("   ", "username", {
      allowEmpty: true,
    }),
    "",
  );

  assertThrows(
    () => validateAndNormalizeParticipantUsername("   "),
    Error,
    "non-empty",
  );
  assertThrows(
    () => validateAndNormalizeParticipantUsername("alice\u0007"),
    Error,
    "control characters",
  );
  assertThrows(
    () => validateAndNormalizeParticipantUsername("a".repeat(129)),
    Error,
    "at most 128",
  );
});
