import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { stringify } from "@std/yaml";
import {
  CliConfigFileStore,
  createDefaultCliConfig,
  createDefaultRuntimeConfig,
  createDefaultSharedBehaviorConfig,
  resolveDefaultConfigPath,
  resolveDefaultProviderSessionRoots,
  resolveDefaultSharedConfigPath,
  RuntimeConfigFileStore,
  SharedBehaviorConfigFileStore,
} from "@kato/runtime";
import { withIsolatedEnvironment } from "./test_env.ts";
import {
  makeTestTempPath,
  removePathIfPresent,
  resolveTestTempPath,
} from "./test_temp.ts";

const INVALID_RUNTIME_DIR = resolveTestTempPath("kato-daemon");
const INVALID_ALLOWED_WRITE_ROOT = resolveTestTempPath("allowed-write-root");

function makeSandboxRoot(): string {
  return makeTestTempPath("test-runtime-config-");
}

const CONFIG_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "KATO_CLAUDE_SESSION_ROOTS",
  "KATO_CODEX_SESSION_ROOTS",
  "KATO_GEMINI_SESSION_ROOTS",
  "KATO_LOGGING_OPERATIONAL_LEVEL",
  "KATO_LOGGING_AUDIT_LEVEL",
  "KATO_DAEMON_MAX_MEMORY_MB",
  "KATO_CONFIG_PATH",
] as const;

type ConfigEnvKey = (typeof CONFIG_ENV_KEYS)[number];

function snapshotConfigEnv(): Record<ConfigEnvKey, string | undefined> {
  return Object.fromEntries(
    CONFIG_ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  ) as Record<ConfigEnvKey, string | undefined>;
}

function setConfigEnv(
  values: Partial<Record<ConfigEnvKey, string | undefined>>,
): void {
  for (const key of CONFIG_ENV_KEYS) {
    if (!(key in values)) {
      continue;
    }
    const value = values[key];
    if (value === undefined) {
      Deno.env.delete(key);
      continue;
    }
    Deno.env.set(key, value);
  }
}

function restoreConfigEnv(
  snapshot: Record<ConfigEnvKey, string | undefined>,
): void {
  setConfigEnv(snapshot);
}

Deno.test("RuntimeConfigFileStore initializes missing daemon config", async () => {
  const root = makeSandboxRoot();
  const runtimeDir = join(root, "daemon");
  const configPath = join(runtimeDir, "kato-daemon-config.yaml");
  const defaultConfig = createDefaultRuntimeConfig({
    runtimeDir,
  });
  const store = new RuntimeConfigFileStore(configPath);

  try {
    const initialized = await store.ensureInitialized(defaultConfig);
    assertEquals(initialized.created, true);
    assertEquals(initialized.path, configPath);

    const loaded = await store.load();
    assertEquals(loaded.schemaVersion, 1);
    assertEquals(loaded.runtimeDir, runtimeDir);
    assertEquals(
      loaded.providerSessionRoots,
      defaultConfig.providerSessionRoots,
    );
    assertEquals(loaded.providerAutoGenerateTwins, { codex: true });
    assertEquals(loaded.daemonFeatureFlags, defaultConfig.daemonFeatureFlags);
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore defaults missing providerAutoGenerateTwins to codex", async () => {
  const root = makeSandboxRoot();
  const runtimeDir = join(root, "daemon");
  const configPath = join(runtimeDir, "kato-daemon-config.yaml");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(runtimeDir, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        providerSessionRoots: {
          claude: [],
          codex: [],
          gemini: [],
        },
        globalAutoGenerateTwins: false,
        cleanSessionStatesOnShutdown: false,
        daemonFeatureFlags: {
          daemonExportEnabled: true,
          captureIncludeSystemEvents: false,
        },
        logging: {
          operationalLevel: "info",
          auditLevel: "info",
        },
        daemonMaxMemoryMb: 500,
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.providerAutoGenerateTwins, { codex: true });
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore defaults codex when providerAutoGenerateTwins is empty", async () => {
  const root = makeSandboxRoot();
  const runtimeDir = join(root, "daemon");
  const configPath = join(runtimeDir, "kato-daemon-config.yaml");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(runtimeDir, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir,
        providerSessionRoots: {
          claude: [],
          codex: [],
          gemini: [],
        },
        globalAutoGenerateTwins: false,
        providerAutoGenerateTwins: {},
        cleanSessionStatesOnShutdown: false,
        daemonFeatureFlags: {
          daemonExportEnabled: true,
          captureIncludeSystemEvents: false,
        },
        logging: {
          operationalLevel: "info",
          auditLevel: "info",
        },
        daemonMaxMemoryMb: 500,
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.providerAutoGenerateTwins, { codex: true });
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test(
  "resolveDefaultProviderSessionRoots honors env overrides and expands home paths",
  async () => {
    await withIsolatedEnvironment(async () => {
      const root = makeSandboxRoot();
      const homeDir = join(root, "home");
      const snapshot = snapshotConfigEnv();

      try {
        await Deno.mkdir(homeDir, { recursive: true });
        setConfigEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_CLAUDE_SESSION_ROOTS: JSON.stringify([
            "~/claude/projects",
            " ~/claude/projects ",
            "~/claude/alt",
          ]),
          KATO_CODEX_SESSION_ROOTS: JSON.stringify([
            join(homeDir, "codex", "sessions"),
          ]),
          KATO_GEMINI_SESSION_ROOTS: JSON.stringify([
            "~/gemini/tmp",
          ]),
        });

        assertEquals(resolveDefaultProviderSessionRoots(), {
          claude: [
            join(homeDir, "claude", "projects"),
            join(homeDir, "claude", "alt"),
          ],
          codex: [join(homeDir, "codex", "sessions")],
          gemini: [join(homeDir, "gemini", "tmp")],
        });
      } finally {
        restoreConfigEnv(snapshot);
        await removePathIfPresent(root);
      }
    });
  },
);

Deno.test(
  "resolveDefaultProviderSessionRoots falls back to home defaults on invalid env values",
  async () => {
    await withIsolatedEnvironment(async () => {
      const root = makeSandboxRoot();
      const homeDir = join(root, "home");
      const snapshot = snapshotConfigEnv();

      try {
        await Deno.mkdir(homeDir, { recursive: true });
        setConfigEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_CLAUDE_SESSION_ROOTS: "not-json",
          KATO_CODEX_SESSION_ROOTS: JSON.stringify([]),
          KATO_GEMINI_SESSION_ROOTS: JSON.stringify([" "]),
        });

        assertEquals(resolveDefaultProviderSessionRoots(), {
          claude: [join(homeDir, ".claude", "projects")],
          codex: [join(homeDir, ".codex", "sessions")],
          gemini: [join(homeDir, ".gemini", "tmp")],
        });
      } finally {
        restoreConfigEnv(snapshot);
        await removePathIfPresent(root);
      }
    });
  },
);

Deno.test("createDefaultRuntimeConfig applies env defaults and home shorthand", async () => {
  await withIsolatedEnvironment(async () => {
    const root = makeSandboxRoot();
    const homeDir = join(root, "home");
    const snapshot = snapshotConfigEnv();

    try {
      await Deno.mkdir(homeDir, { recursive: true });
      setConfigEnv({
        HOME: homeDir,
        USERPROFILE: undefined,
        KATO_CODEX_SESSION_ROOTS: JSON.stringify([
          join(homeDir, "captures", "codex"),
        ]),
        KATO_LOGGING_OPERATIONAL_LEVEL: "warn",
        KATO_LOGGING_AUDIT_LEVEL: "debug",
        KATO_DAEMON_MAX_MEMORY_MB: "768",
      });

      const config = createDefaultRuntimeConfig({
        runtimeDir: join(homeDir, ".kato", "daemon"),
        useHomeShorthand: true,
      });

      assertEquals(config.runtimeDir, "~/.kato/daemon");
      assertEquals(config.katoDir, "~/.kato");
      assertEquals(config.providerSessionRoots, {
        claude: ["~/.claude/projects"],
        codex: ["~/captures/codex"],
        gemini: ["~/.gemini/tmp"],
      });
      assertEquals(config.logging, {
        operationalLevel: "warn",
        auditLevel: "debug",
      });
      assertEquals(config.daemonMaxMemoryMb, 768);
      assertEquals(config.providerAutoGenerateTwins, { codex: true });
    } finally {
      restoreConfigEnv(snapshot);
      await removePathIfPresent(root);
    }
  });
});

Deno.test("createDefaultRuntimeConfig rejects invalid env logging override", async () => {
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotConfigEnv();
    try {
      setConfigEnv({
        KATO_LOGGING_OPERATIONAL_LEVEL: "verbose",
      });
      assertThrows(
        () =>
          createDefaultRuntimeConfig({
            runtimeDir: INVALID_RUNTIME_DIR,
          }),
        Error,
        "KATO_LOGGING_OPERATIONAL_LEVEL must be one of",
      );
    } finally {
      restoreConfigEnv(snapshot);
    }
  });
});

Deno.test("createDefaultRuntimeConfig rejects invalid daemonMaxMemoryMb override", () => {
  assertThrows(
    () =>
      createDefaultRuntimeConfig({
        runtimeDir: INVALID_RUNTIME_DIR,
        daemonMaxMemoryMb: 0,
      }),
    Error,
    "daemonMaxMemoryMb must be a positive integer",
  );
});

Deno.test("RuntimeConfigFileStore rejects legacy mixed fields", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-daemon-config.yaml");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir: join(root, "daemon"),
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

Deno.test("RuntimeConfigFileStore rejects deprecated auto-twin snapshot keys with rename guidance", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "kato-daemon-config.yaml");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        runtimeDir: join(root, "daemon"),
        providerSessionRoots: {
          claude: [],
          codex: [],
          gemini: [],
        },
        globalAutoGenerateSnapshots: false,
        providerAutoGenerateSnapshots: {
          codex: true,
        },
        cleanSessionStatesOnShutdown: false,
        daemonFeatureFlags: {
          daemonExportEnabled: true,
          captureIncludeSystemEvents: false,
        },
        logging: {
          operationalLevel: "info",
          auditLevel: "info",
        },
        daemonMaxMemoryMb: 500,
      }),
    );

    await assertRejects(
      () => store.load(),
      Error,
      "Rename them to globalAutoGenerateTwins/providerAutoGenerateTwins",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore loads explicit katoDir and normalizes config values", async () => {
  await withIsolatedEnvironment(async () => {
    const root = makeSandboxRoot();
    const homeDir = join(root, "home");
    const configPath = join(root, "kato-daemon-config.yaml");
    const store = new RuntimeConfigFileStore(configPath);
    const snapshot = snapshotConfigEnv();

    try {
      await Deno.mkdir(homeDir, { recursive: true });
      setConfigEnv({
        HOME: homeDir,
        USERPROFILE: undefined,
      });
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        configPath,
        stringify({
          schemaVersion: 1,
          runtimeDir: "~/.kato/daemon",
          katoDir: "~/.kato",
          providerSessionRoots: {
            codex: ["~/captures/codex"],
          },
          globalAutoGenerateTwins: true,
          providerAutoGenerateTwins: {
            claude: false,
            gemini: true,
          },
          cleanSessionStatesOnShutdown: true,
          daemonFeatureFlags: {
            captureIncludeSystemEvents: true,
          },
          logging: {
            operationalLevel: " WARN ",
            auditLevel: "ERROR",
          },
          daemonMaxMemoryMb: 1024,
        }),
      );

      const loaded = await store.load();
      assertEquals(loaded.runtimeDir, join(homeDir, ".kato", "daemon"));
      assertEquals(loaded.katoDir, join(homeDir, ".kato"));
      assertEquals(loaded.providerSessionRoots, {
        claude: [join(homeDir, ".claude", "projects")],
        codex: [join(homeDir, "captures", "codex")],
        gemini: [join(homeDir, ".gemini", "tmp")],
      });
      assertEquals(loaded.providerAutoGenerateTwins, {
        claude: false,
        codex: true,
        gemini: true,
      });
      assertEquals(loaded.daemonFeatureFlags, {
        daemonExportEnabled: true,
        captureIncludeSystemEvents: true,
      });
      assertEquals(loaded.logging, {
        operationalLevel: "warn",
        auditLevel: "error",
      });
      assertEquals(loaded.globalAutoGenerateTwins, true);
      assertEquals(loaded.cleanSessionStatesOnShutdown, true);
      assertEquals(loaded.daemonMaxMemoryMb, 1024);
    } finally {
      restoreConfigEnv(snapshot);
      await removePathIfPresent(root);
    }
  });
});

Deno.test("RuntimeConfigFileStore rejects invalid YAML and non-yaml paths", async () => {
  const root = makeSandboxRoot();
  const yamlPath = join(root, "kato-daemon-config.yaml");
  const jsonPath = join(root, "kato-daemon-config.json");

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(yamlPath, "schemaVersion: [");

    await assertRejects(
      () => new RuntimeConfigFileStore(yamlPath).load(),
      Error,
      "invalid YAML",
    );
    await assertRejects(
      () =>
        new RuntimeConfigFileStore(jsonPath).ensureInitialized(
          createDefaultRuntimeConfig({
            runtimeDir: join(root, "daemon"),
          }),
        ),
      Error,
      "must end with .yaml",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("RuntimeConfigFileStore ensureInitialized returns existing config without rewriting", async () => {
  const root = makeSandboxRoot();
  const runtimeDir = join(root, "daemon");
  const configPath = join(runtimeDir, "kato-daemon-config.yaml");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    const initial = createDefaultRuntimeConfig({
      runtimeDir,
      daemonMaxMemoryMb: 900,
    });
    const fallback = createDefaultRuntimeConfig({
      runtimeDir,
      daemonMaxMemoryMb: 100,
    });

    await store.ensureInitialized(initial);
    const ensured = await store.ensureInitialized(fallback);

    assertEquals(ensured.created, false);
    assertEquals(ensured.path, configPath);
    assertEquals(ensured.config.daemonMaxMemoryMb, 900);
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("SharedBehaviorConfigFileStore initializes missing shared config", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "shared", "kato-shared-config.yaml");
  const defaultConfig = createDefaultSharedBehaviorConfig({
    allowedWriteRoots: [root],
  });
  const store = new SharedBehaviorConfigFileStore(configPath);

  try {
    const initialized = await store.ensureInitialized(defaultConfig);
    assertEquals(initialized.created, true);
    assertEquals(initialized.path, configPath);

    const loaded = await store.load();
    assertEquals(loaded.allowedWriteRoots, [root]);
    assertEquals(
      loaded.exportMarkdownFrontmatter.includeFrontmatterInMarkdownRecordings,
      true,
    );
    assertEquals(loaded.exportTimezone, "local");
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("SharedBehaviorConfigFileStore rejects unknown keys", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "shared", "kato-shared-config.yaml");
  const store = new SharedBehaviorConfigFileStore(configPath);

  try {
    await Deno.mkdir(join(root, "shared"), { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        allowedWriteRoots: [root],
        exportTimezone: "local",
        extra: true,
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

Deno.test("createDefaultSharedBehaviorConfig applies home shorthand and nested overrides", async () => {
  await withIsolatedEnvironment(async () => {
    const root = makeSandboxRoot();
    const homeDir = join(root, "home");
    const snapshot = snapshotConfigEnv();

    try {
      await Deno.mkdir(homeDir, { recursive: true });
      setConfigEnv({
        HOME: homeDir,
        USERPROFILE: undefined,
      });

      const config = createDefaultSharedBehaviorConfig({
        allowedWriteRoots: [
          join(homeDir, "notes"),
          join(homeDir, "notes"),
          join(homeDir, "exports"),
        ],
        exportTimezone: "UTC",
        exportMarkdownFrontmatter: {
          includeRecordingIds: false,
          addParticipantUsernameToHeadings: true,
        },
        exportFeatureFlags: {
          writerIncludeToolCalls: true,
          writerItalicizeUserMessages: true,
        },
        useHomeShorthand: true,
      });

      assertEquals(config.allowedWriteRoots, ["~/notes", "~/exports"]);
      assertEquals(config.exportTimezone, "UTC");
      assertEquals(
        config.exportMarkdownFrontmatter.addParticipantUsernameToHeadings,
        true,
      );
      assertEquals(
        config.exportMarkdownFrontmatter.includeRecordingIds,
        false,
      );
      assertEquals(config.exportMarkdownFrontmatter.includeSessionIds, true);
      assertEquals(config.exportFeatureFlags.writerIncludeToolCalls, true);
      assertEquals(config.exportFeatureFlags.writerItalicizeUserMessages, true);
      assertEquals(config.exportFeatureFlags.writerIncludeCommentary, true);
    } finally {
      restoreConfigEnv(snapshot);
      await removePathIfPresent(root);
    }
  });
});

Deno.test("createDefaultSharedBehaviorConfig rejects invalid export timezones", () => {
  assertThrows(
    () =>
      createDefaultSharedBehaviorConfig({
        allowedWriteRoots: [INVALID_ALLOWED_WRITE_ROOT],
        exportTimezone: "Mars/Phobos",
      }),
    Error,
    'exportTimezone must be "local", "UTC", or a valid IANA timezone',
  );
});

Deno.test("SharedBehaviorConfigFileStore loads expanded roots and nested shared settings", async () => {
  await withIsolatedEnvironment(async () => {
    const root = makeSandboxRoot();
    const homeDir = join(root, "home");
    const configPath = join(root, "shared", "kato-shared-config.yaml");
    const store = new SharedBehaviorConfigFileStore(configPath);
    const snapshot = snapshotConfigEnv();

    try {
      await Deno.mkdir(join(root, "shared"), { recursive: true });
      await Deno.mkdir(homeDir, { recursive: true });
      setConfigEnv({
        HOME: homeDir,
        USERPROFILE: undefined,
      });

      await Deno.writeTextFile(
        configPath,
        stringify({
          schemaVersion: 1,
          allowedWriteRoots: ["~/.kato/exports", "~/.kato/exports"],
          exportTimezone: "America/Los_Angeles",
          exportMarkdownFrontmatter: {
            includeSessionIds: false,
            addParticipantUsernameToFrontmatter: true,
          },
          exportFeatureFlags: {
            writerIncludeToolCalls: true,
            writerIncludeToolResults: true,
          },
        }),
      );

      const loaded = await store.load();
      assertEquals(loaded.allowedWriteRoots, [
        join(homeDir, ".kato", "exports"),
      ]);
      assertEquals(loaded.exportTimezone, "America/Los_Angeles");
      assertEquals(
        loaded.exportMarkdownFrontmatter.includeSessionIds,
        false,
      );
      assertEquals(
        loaded.exportMarkdownFrontmatter.addParticipantUsernameToFrontmatter,
        true,
      );
      assertEquals(
        loaded.exportMarkdownFrontmatter.includeWorkspaceIds,
        true,
      );
      assertEquals(loaded.exportFeatureFlags.writerIncludeToolCalls, true);
      assertEquals(loaded.exportFeatureFlags.writerIncludeToolResults, true);
      assertEquals(loaded.exportFeatureFlags.writerIncludeCommentary, true);
    } finally {
      restoreConfigEnv(snapshot);
      await removePathIfPresent(root);
    }
  });
});

Deno.test("SharedBehaviorConfigFileStore ensureInitialized returns existing config without rewriting", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "shared", "kato-shared-config.yaml");
  const initial = createDefaultSharedBehaviorConfig({
    allowedWriteRoots: [join(root, "allowed")],
    exportTimezone: "UTC",
  });
  const fallback = createDefaultSharedBehaviorConfig({
    allowedWriteRoots: [join(root, "fallback")],
    exportTimezone: "local",
  });
  const store = new SharedBehaviorConfigFileStore(configPath);

  try {
    await store.ensureInitialized(initial);
    const ensured = await store.ensureInitialized(fallback);

    assertEquals(ensured.created, false);
    assertEquals(ensured.path, configPath);
    assertEquals(ensured.config.allowedWriteRoots, [join(root, "allowed")]);
    assertEquals(ensured.config.exportTimezone, "UTC");
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("SharedBehaviorConfigFileStore rejects invalid YAML and non-.yaml paths", async () => {
  const root = makeSandboxRoot();
  const yamlPath = join(root, "shared", "kato-shared-config.yaml");
  const jsonPath = join(root, "shared", "kato-shared-config.json");
  const defaultConfig = createDefaultSharedBehaviorConfig({
    allowedWriteRoots: [root],
  });

  try {
    await Deno.mkdir(join(root, "shared"), { recursive: true });
    await Deno.writeTextFile(yamlPath, "allowedWriteRoots: [");

    await assertRejects(
      () => new SharedBehaviorConfigFileStore(yamlPath).load(),
      Error,
      "invalid YAML",
    );
    await assertRejects(
      () =>
        new SharedBehaviorConfigFileStore(jsonPath).ensureInitialized(
          defaultConfig,
        ),
      Error,
      "must end with .yaml",
    );
    await assertRejects(
      () => new SharedBehaviorConfigFileStore(jsonPath).save(defaultConfig),
      Error,
      "must end with .yaml",
    );
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("CliConfigFileStore initializes missing CLI config", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "cli", "kato-cli-config.yaml");
  const defaultConfig = createDefaultCliConfig();
  const store = new CliConfigFileStore(configPath);

  try {
    const initialized = await store.ensureInitialized(defaultConfig);
    assertEquals(initialized.created, true);
    assertEquals(initialized.config.logging.operationalLevel, "info");

    const loaded = await store.load();
    assertEquals(loaded.logging.auditLevel, "info");
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("CliConfigFileStore rejects invalid logging level", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "cli", "kato-cli-config.yaml");
  const store = new CliConfigFileStore(configPath);

  try {
    await Deno.mkdir(join(root, "cli"), { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        logging: {
          operationalLevel: "verbose",
          auditLevel: "info",
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

Deno.test("resolveDefaultConfigPath keeps daemon config inside daemon dir", () => {
  const resolved = resolveDefaultConfigPath(".kato/daemon");
  assertEquals(resolved, join(".kato", "daemon", "kato-daemon-config.yaml"));
});

Deno.test("resolveDefaultSharedConfigPath keeps shared config under ~/.kato/shared", () => {
  const resolved = resolveDefaultSharedConfigPath(".kato");
  assertEquals(resolved, join(".kato", "shared", "kato-shared-config.yaml"));
});

Deno.test("SharedBehaviorConfigFileStore defaults absent secretsPolicy to redact", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "shared", "kato-shared-config.yaml");
  const store = new SharedBehaviorConfigFileStore(configPath);

  try {
    await Deno.mkdir(join(root, "shared"), { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        allowedWriteRoots: [root],
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.secretsPolicy, {
      mode: "redact",
      disabledRules: [],
      allowlist: [],
    });
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("SharedBehaviorConfigFileStore loads explicit secretsPolicy settings", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "shared", "kato-shared-config.yaml");
  const store = new SharedBehaviorConfigFileStore(configPath);

  try {
    await Deno.mkdir(join(root, "shared"), { recursive: true });
    await Deno.writeTextFile(
      configPath,
      stringify({
        schemaVersion: 1,
        allowedWriteRoots: [root],
        secretsPolicy: {
          mode: "detect",
          disabledRules: ["jwt"],
          // split so scanners never see a contiguous key-shaped literal
          allowlist: ["AKIA" + "IOSFODNN7EXAMPLE", "/EXAMPLE$/"],
        },
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.secretsPolicy.mode, "detect");
    assertEquals(loaded.secretsPolicy.disabledRules, ["jwt"]);
    assertEquals(loaded.secretsPolicy.allowlist, [
      "AKIA" + "IOSFODNN7EXAMPLE",
      "/EXAMPLE$/",
    ]);
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("SharedBehaviorConfigFileStore rejects invalid secretsPolicy values", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "shared", "kato-shared-config.yaml");
  const store = new SharedBehaviorConfigFileStore(configPath);

  const invalidCases: Array<Record<string, unknown>> = [
    { mode: "audit" },
    { mode: 1 },
    { mode: null },
    { unknownKey: true },
    { disabledRules: "jwt" },
    { disabledRules: [1] },
    { allowlist: [""] },
    { allowlist: ["/[unclosed/"] },
  ];

  try {
    await Deno.mkdir(join(root, "shared"), { recursive: true });
    for (const secretsPolicy of invalidCases) {
      await Deno.writeTextFile(
        configPath,
        stringify({
          schemaVersion: 1,
          allowedWriteRoots: [root],
          secretsPolicy,
        }),
      );
      await assertRejects(
        () => store.load(),
        Error,
        "unsupported schema",
        `expected rejection for ${JSON.stringify(secretsPolicy)}`,
      );
    }
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test("createDefaultSharedBehaviorConfig carries secretsPolicy overrides", () => {
  const config = createDefaultSharedBehaviorConfig({
    allowedWriteRoots: [INVALID_ALLOWED_WRITE_ROOT],
    secretsPolicy: { mode: "detect", disabledRules: ["jwt"] },
  });
  assertEquals(config.secretsPolicy, {
    mode: "detect",
    disabledRules: ["jwt"],
    allowlist: [],
  });
});
