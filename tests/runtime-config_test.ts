import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { stringify } from "@std/yaml";
import {
  createDefaultRuntimeConfig,
  createDefaultRuntimeFeatureFlags,
  createDefaultRuntimeLoggingConfig,
  createDefaultRuntimeMarkdownFrontmatterConfig,
  resolveDefaultConfigPath,
  resolveDefaultProviderSessionRoots,
  RuntimeConfigFileStore,
} from "../apps/daemon/src/mod.ts";
import { makeTestTempPath, removePathIfPresent } from "./test_temp.ts";

function makeSandboxRoot(): string {
  return makeTestTempPath("test-runtime-config-");
}

Deno.test("RuntimeConfigFileStore initializes missing config atomically", async () => {
  const root = makeSandboxRoot();
  const runtimeDir = join(root, "runtime");
  const configPath = join(root, "kato-config.yaml");
  const defaultConfig = createDefaultRuntimeConfig({
    runtimeDir,
    statusPath: join(runtimeDir, "status.json"),
    controlPath: join(runtimeDir, "control.json"),
    allowedWriteRoots: [root],
  });
  const store = new RuntimeConfigFileStore(configPath);

  try {
    const initialized = await store.ensureInitialized(defaultConfig);
    assertEquals(initialized.created, true);
    assertEquals(initialized.path, configPath);
    assertEquals(initialized.config, defaultConfig);

    const loaded = await store.load();
    assertEquals(loaded, defaultConfig);

    loaded.allowedWriteRoots.push("mutated");
    loaded.providerSessionRoots.claude.push("mutated");
    loaded.providerSessionRoots.gemini.push("mutated");
    const loadedAgain = await store.load();
    assertEquals(loadedAgain.allowedWriteRoots.includes("mutated"), false);
    assertEquals(
      loadedAgain.providerSessionRoots.claude.includes("mutated"),
      false,
    );
    assertEquals(
      loadedAgain.providerSessionRoots.gemini.includes("mutated"),
      false,
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects unsupported schema", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 2,
        runtimeDir: join(root, "runtime"),
        statusPath: join(root, "runtime", "status.json"),
        controlPath: join(root, "runtime", "control.json"),
        allowedWriteRoots: [root],
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects non-yaml config path", async () => {
  const root = makeSandboxRoot();
  const runtimeDir = join(root, "runtime");
  const configPath = join(root, "kato-config.json");
  const defaultConfig = createDefaultRuntimeConfig({
    runtimeDir,
    statusPath: join(runtimeDir, "status.json"),
    controlPath: join(runtimeDir, "control.json"),
    allowedWriteRoots: [root],
  });
  const store = new RuntimeConfigFileStore(configPath);

  await assertRejects(
    () => store.ensureInitialized(defaultConfig),
    Error,
    ".yaml",
  );
});

Deno.test("RuntimeConfigFileStore rejects invalid YAML", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(configPath, "schemaVersion: [\n");
    await assertRejects(
      () => store.load(),
      Error,
      "invalid YAML",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore supports YAML comments", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      [
        "# kato runtime config",
        "schemaVersion: 1",
        `runtimeDir: ${runtimeDir}`,
        `statusPath: ${join(runtimeDir, "status.json")}`,
        `controlPath: ${join(runtimeDir, "control.json")}`,
        "allowedWriteRoots:",
        `  - ${root}`,
        "# optional: provider roots omitted for default backfill",
        "",
      ].join("\n"),
    );

    const loaded = await store.load();
    assertEquals(loaded.schemaVersion, 1);
    assertEquals(loaded.runtimeDir, runtimeDir);
    assertEquals(loaded.controlPath, join(runtimeDir, "control.json"));
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore backfills default feature flags and provider roots for missing optional sections", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.featureFlags, createDefaultRuntimeFeatureFlags());
    assertEquals(
      loaded.providerSessionRoots,
      resolveDefaultProviderSessionRoots(),
    );
    assertEquals(loaded.logging, createDefaultRuntimeLoggingConfig());
    assertEquals(
      loaded.markdownFrontmatter,
      createDefaultRuntimeMarkdownFrontmatterConfig(),
    );
    assertEquals(loaded.katoDir, dirname(runtimeDir));
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects unknown markdownFrontmatter keys", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        markdownFrontmatter: {
          includeFrontmatterInMarkdownRecordings: true,
          includeUpdatedInFrontmatter: false,
          addParticipantUsernameToFrontmatter: false,
          defaultParticipantUsername: "",
          includeConversationEventKinds: false,
          extra: true,
        },
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects invalid markdownFrontmatter value types", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        markdownFrontmatter: {
          includeFrontmatterInMarkdownRecordings: true,
          includeUpdatedInFrontmatter: "false",
          addParticipantUsernameToFrontmatter: false,
          defaultParticipantUsername: "",
          includeConversationEventKinds: false,
        },
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore accepts markdownFrontmatter overrides", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        markdownFrontmatter: {
          includeFrontmatterInMarkdownRecordings: false,
          includeUpdatedInFrontmatter: true,
          addParticipantUsernameToFrontmatter: true,
          defaultParticipantUsername: "alice",
          includeConversationEventKinds: true,
        },
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.markdownFrontmatter, {
      includeFrontmatterInMarkdownRecordings: false,
      includeUpdatedInFrontmatter: true,
      addParticipantUsernameToFrontmatter: true,
      defaultParticipantUsername: "alice",
      includeConversationEventKinds: true,
    });
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects unknown feature flag keys", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        featureFlags: {
          writerIncludeCommentary: true,
          writerIncludeThinking: true,
          writerIncludeToolCalls: true,
          writerItalicizeUserMessages: false,
          daemonExportEnabled: true,
          notARealFlag: true,
        },
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects unknown logging keys", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        logging: {
          operationalLevel: "info",
          extra: "debug",
        },
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects invalid providerSessionRoots", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        providerSessionRoots: {
          claude: ".kato/not-an-array",
          codex: [],
        },
        featureFlags: createDefaultRuntimeFeatureFlags(),
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore accepts partial providerSessionRoots and merges defaults", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);
  const claudeOverride = join(root, "claude-only-root");
  const defaultRoots = resolveDefaultProviderSessionRoots();

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        providerSessionRoots: {
          claude: [claudeOverride],
        },
        featureFlags: createDefaultRuntimeFeatureFlags(),
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.providerSessionRoots.claude, [claudeOverride]);
    assertEquals(loaded.providerSessionRoots.codex, defaultRoots.codex);
    assertEquals(loaded.providerSessionRoots.gemini, defaultRoots.gemini);
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore accepts valid logging overrides", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        logging: {
          operationalLevel: "debug",
          auditLevel: "warn",
        },
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.logging, {
      operationalLevel: "debug",
      auditLevel: "warn",
    });
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects invalid logging level", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        logging: {
          operationalLevel: "verbose",
        },
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore defaults daemonMaxMemoryMb to 500", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.daemonMaxMemoryMb, 500);
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore accepts valid daemonMaxMemoryMb", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        daemonMaxMemoryMb: 512,
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.daemonMaxMemoryMb, 512);
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore rejects invalid daemonMaxMemoryMb", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-config.yaml");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    const invalidValues = [
      "512",
      -1,
      0,
      1.5,
      null,
    ];

    for (const value of invalidValues) {
      await Deno.writeTextFile(
        configPath,
        stringify({
          schemaVersion: 1,
          runtimeDir,
          statusPath: join(runtimeDir, "status.json"),
          controlPath: join(runtimeDir, "control.json"),
          allowedWriteRoots: [root],
          daemonMaxMemoryMb: value,
        }),
      );

      await assertRejects(
        () => store.load(),
        Error,
        "unsupported schema",
      );
    }
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("createDefaultRuntimeConfig rejects invalid daemonMaxMemoryMb option", () => {
  assertThrows(
    () =>
      createDefaultRuntimeConfig({
        runtimeDir: ".kato/runtime",
        statusPath: ".kato/runtime/status.json",
        controlPath: ".kato/runtime/control.json",
        allowedWriteRoots: [".kato"],
        daemonMaxMemoryMb: 0,
      }),
    Error,
    "daemonMaxMemoryMb must be a positive integer",
  );
});

Deno.test("createDefaultRuntimeConfig accepts logging overrides", () => {
  const config = createDefaultRuntimeConfig({
    runtimeDir: ".kato/runtime",
    statusPath: ".kato/runtime/status.json",
    controlPath: ".kato/runtime/control.json",
    allowedWriteRoots: [".kato"],
    logging: {
      operationalLevel: "debug",
      auditLevel: "warn",
    },
  });

  assertEquals(config.logging, {
    operationalLevel: "debug",
    auditLevel: "warn",
  });
});

Deno.test("createDefaultRuntimeConfig derives katoDir from runtimeDir", () => {
  const config = createDefaultRuntimeConfig({
    runtimeDir: ".kato/runtime",
    statusPath: ".kato/runtime/status.json",
    controlPath: ".kato/runtime/control.json",
    allowedWriteRoots: [".kato"],
  });

  assertEquals(config.katoDir, ".kato");
});

Deno.test("resolveDefaultConfigPath defaults to kato-config.yaml beside runtime dir", () => {
  const resolved = resolveDefaultConfigPath(".kato/runtime");
  assertEquals(resolved, ".kato/kato-config.yaml");
});

Deno.test("createDefaultRuntimeConfig accepts explicit katoDir override", () => {
  const config = createDefaultRuntimeConfig({
    runtimeDir: ".kato/runtime",
    katoDir: ".kato-explicit",
    statusPath: ".kato/runtime/status.json",
    controlPath: ".kato/runtime/control.json",
    allowedWriteRoots: [".kato"],
  });

  assertEquals(config.katoDir, ".kato-explicit");
});

Deno.test("createDefaultRuntimeConfig reads logging env overrides", () => {
  const originalOperational = Deno.env.get("KATO_LOGGING_OPERATIONAL_LEVEL");
  const originalAudit = Deno.env.get("KATO_LOGGING_AUDIT_LEVEL");

  try {
    Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", "warn");
    Deno.env.set("KATO_LOGGING_AUDIT_LEVEL", "error");

    const config = createDefaultRuntimeConfig({
      runtimeDir: ".kato/runtime",
      statusPath: ".kato/runtime/status.json",
      controlPath: ".kato/runtime/control.json",
      allowedWriteRoots: [".kato"],
    });

    assertEquals(config.logging, {
      operationalLevel: "warn",
      auditLevel: "error",
    });
  } finally {
    if (originalOperational === undefined) {
      Deno.env.delete("KATO_LOGGING_OPERATIONAL_LEVEL");
    } else {
      Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", originalOperational);
    }
    if (originalAudit === undefined) {
      Deno.env.delete("KATO_LOGGING_AUDIT_LEVEL");
    } else {
      Deno.env.set("KATO_LOGGING_AUDIT_LEVEL", originalAudit);
    }
  }
});

Deno.test("createDefaultRuntimeConfig rejects invalid logging env overrides", () => {
  const originalOperational = Deno.env.get("KATO_LOGGING_OPERATIONAL_LEVEL");

  try {
    Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", "verbose");
    assertThrows(
      () =>
        createDefaultRuntimeConfig({
          runtimeDir: ".kato/runtime",
          statusPath: ".kato/runtime/status.json",
          controlPath: ".kato/runtime/control.json",
          allowedWriteRoots: [".kato"],
        }),
      Error,
      "KATO_LOGGING_OPERATIONAL_LEVEL must be one of",
    );
  } finally {
    if (originalOperational === undefined) {
      Deno.env.delete("KATO_LOGGING_OPERATIONAL_LEVEL");
    } else {
      Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", originalOperational);
    }
  }
});
