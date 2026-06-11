import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type {
  RuntimeConfig as DaemonRuntimeConfig,
  SharedBehaviorConfig,
} from "@kato/shared";
import {
  createDefaultExportFeatureFlags,
  createDefaultRuntimeMarkdownFrontmatterConfig,
  createDefaultSecretsPolicyConfig,
  createDefaultUserConfig,
  DEFAULT_WORKSPACE_REGISTRY_FILENAME,
  runDaemonSubprocess,
  type RunDaemonSubprocessOptions,
  type RuntimeConfigStoreLike,
  type UserConfigStoreLike,
} from "../apps/daemon/src/mod.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withIsolatedEnvironment,
} from "./test_env.ts";
import {
  makeTestTempDir,
  makeTestTempPath,
  removePathIfPresent,
} from "./test_temp.ts";

type RuntimeConfig = DaemonRuntimeConfig;

const PLANTED_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

function makeRuntimeConfig(
  runtimeDir = makeTestTempPath("daemon-main-runtime-"),
): RuntimeConfig {
  return {
    schemaVersion: 1,
    runtimeDir,
    providerSessionRoots: {
      claude: ["/sessions/claude"],
      codex: ["/sessions/codex"],
      gemini: ["/sessions/gemini"],
    },
    daemonFeatureFlags: {
      daemonExportEnabled: false,
      captureIncludeSystemEvents: false,
    },
    logging: {
      operationalLevel: "info",
      auditLevel: "info",
    },
    daemonMaxMemoryMb: 200,
  };
}

function cloneSharedConfig(config: SharedBehaviorConfig): SharedBehaviorConfig {
  return {
    schemaVersion: config.schemaVersion,
    allowedWriteRoots: [...config.allowedWriteRoots],
    exportTimezone: config.exportTimezone,
    exportMarkdownFrontmatter: { ...config.exportMarkdownFrontmatter },
    exportFeatureFlags: { ...config.exportFeatureFlags },
    secretsPolicy: {
      ...config.secretsPolicy,
      disabledRules: [...config.secretsPolicy.disabledRules],
      allowlist: [...config.secretsPolicy.allowlist],
    },
  };
}

function makeSharedConfig(
  overrides: Partial<SharedBehaviorConfig> = {},
): SharedBehaviorConfig {
  return {
    schemaVersion: 1,
    allowedWriteRoots: [...(overrides.allowedWriteRoots ?? ["."])],
    exportTimezone: overrides.exportTimezone ?? "local",
    exportMarkdownFrontmatter: {
      ...createDefaultRuntimeMarkdownFrontmatterConfig(),
      ...(overrides.exportMarkdownFrontmatter ?? {}),
    },
    exportFeatureFlags: {
      ...createDefaultExportFeatureFlags({ writerItalicizeUserMessages: true }),
      ...(overrides.exportFeatureFlags ?? {}),
    },
    secretsPolicy: createDefaultSecretsPolicyConfig(overrides.secretsPolicy),
  };
}

function makeSharedConfigStore(
  initial: SharedBehaviorConfig = makeSharedConfig(),
): RunDaemonSubprocessOptions["sharedConfigStore"] {
  let state = cloneSharedConfig(initial);
  return {
    load() {
      return Promise.resolve(cloneSharedConfig(state));
    },
    ensureInitialized(_defaultConfig) {
      return Promise.resolve({
        created: false,
        path: ".test-tmp/kato-shared-config.yaml",
        config: cloneSharedConfig(state),
      });
    },
    save(config) {
      state = cloneSharedConfig(config);
      return Promise.resolve();
    },
  };
}

function makeUserConfigStore(
  initial = createDefaultUserConfig(),
): UserConfigStoreLike {
  let state = {
    schemaVersion: initial.schemaVersion,
    participants: {
      defaultUsername: initial.participants.defaultUsername,
      workspaceUsernames: { ...initial.participants.workspaceUsernames },
      excludeMeFromParticipantList:
        initial.participants.excludeMeFromParticipantList,
    },
  };
  return {
    load() {
      return Promise.resolve({
        schemaVersion: state.schemaVersion,
        participants: {
          defaultUsername: state.participants.defaultUsername,
          workspaceUsernames: { ...state.participants.workspaceUsernames },
          excludeMeFromParticipantList:
            state.participants.excludeMeFromParticipantList,
        },
      });
    },
    ensureInitialized(_defaultConfig) {
      return Promise.resolve({
        created: false,
        path: ".test-tmp/kato-user-config.yaml",
        config: {
          schemaVersion: state.schemaVersion,
          participants: {
            defaultUsername: state.participants.defaultUsername,
            workspaceUsernames: { ...state.participants.workspaceUsernames },
            excludeMeFromParticipantList:
              state.participants.excludeMeFromParticipantList,
          },
        },
      });
    },
    save(config) {
      state = {
        schemaVersion: config.schemaVersion,
        participants: {
          defaultUsername: config.participants.defaultUsername,
          workspaceUsernames: { ...config.participants.workspaceUsernames },
          excludeMeFromParticipantList:
            config.participants.excludeMeFromParticipantList,
        },
      };
      return Promise.resolve();
    },
  };
}

async function withIsolatedDaemonPathEnv<T>(
  run: () => Promise<T> | T,
): Promise<T> {
  return await withIsolatedEnvironment(async () => {
    const originalStatusPath = Deno.env.get("KATO_DAEMON_STATUS_PATH");
    const originalControlPath = Deno.env.get("KATO_DAEMON_CONTROL_PATH");
    try {
      Deno.env.delete("KATO_DAEMON_STATUS_PATH");
      Deno.env.delete("KATO_DAEMON_CONTROL_PATH");
      return await run();
    } finally {
      if (originalStatusPath === undefined) {
        Deno.env.delete("KATO_DAEMON_STATUS_PATH");
      } else {
        Deno.env.set("KATO_DAEMON_STATUS_PATH", originalStatusPath);
      }
      if (originalControlPath === undefined) {
        Deno.env.delete("KATO_DAEMON_CONTROL_PATH");
      } else {
        Deno.env.set("KATO_DAEMON_CONTROL_PATH", originalControlPath);
      }
    }
  });
}

Deno.test("runDaemonSubprocess fails cleanly when runtime root cannot be resolved", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const snapshot = snapshotRuntimeEnv();
    const stderr: string[] = [];
    try {
      setRuntimeEnv({
        HOME: undefined,
        USERPROFILE: undefined,
        KATO_RUNTIME_DIR: undefined,
      });
      const exitCode = await runDaemonSubprocess({
        writeStderr(text: string) {
          stderr.push(text);
        },
        runtimeLoop() {
          throw new Error("runtime loop should not be called");
        },
      });

      assertEquals(exitCode, 1);
      assertStringIncludes(
        stderr.join(""),
        "Daemon startup failed: unable to resolve runtime directory",
      );
      assertStringIncludes(stderr.join(""), "HOME/USERPROFILE is not set");
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("runDaemonSubprocess fails closed when runtime config cannot be loaded", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const stderr: string[] = [];
    const runtimeDir = await makeTestTempDir("daemon-main-config-load-fail-");
    const configStore: RuntimeConfigStoreLike = {
      load() {
        return Promise.reject(new Error("bad config"));
      },
      ensureInitialized(_defaultConfig) {
        throw new Error("not used");
      },
    };

    try {
      const options: RunDaemonSubprocessOptions = {
        runtimeDir,
        configStore,
        userConfigStore: makeUserConfigStore(),
        writeStderr(text: string) {
          stderr.push(text);
        },
        runtimeLoop() {
          throw new Error("runtime loop should not be called");
        },
      };

      const exitCode = await runDaemonSubprocess(options);
      assertEquals(exitCode, 1);
      assertStringIncludes(stderr.join(""), "Daemon startup failed");
      assertStringIncludes(stderr.join(""), "bad config");

      const operationalLogPath = join(runtimeDir, "logs", "operational.jsonl");
      const operationalLog = await Deno.readTextFile(operationalLogPath);
      assertStringIncludes(
        operationalLog,
        '"event":"daemon.startup.config_load_failed"',
      );
      assertStringIncludes(operationalLog, '"severity":"critical"');
      assertStringIncludes(operationalLog, '"error":"bad config"');
    } finally {
      await removePathIfPresent(runtimeDir);
    }
  });
});

Deno.test("runDaemonSubprocess logs fatal runtime loop failures to operational log", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const stderr: string[] = [];
    const runtimeDir = await makeTestTempDir("daemon-main-runtime-fail-");

    try {
      const config = makeRuntimeConfig(runtimeDir);
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(config);
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };

      const exitCode = await runDaemonSubprocess({
        runtimeDir,
        configStore,
        sharedConfigStore: makeSharedConfigStore(),
        userConfigStore: makeUserConfigStore(),
        writeStderr(text: string) {
          stderr.push(text);
        },
        runtimeLoop() {
          throw new Error("boom");
        },
      });

      assertEquals(exitCode, 1);
      assertStringIncludes(stderr.join(""), "Daemon runtime failed");
      assertStringIncludes(stderr.join(""), "boom");

      const operationalLogPath = join(runtimeDir, "logs", "operational.jsonl");
      const operationalLog = await Deno.readTextFile(operationalLogPath);
      assertStringIncludes(operationalLog, '"event":"daemon.runtime.failed"');
      assertStringIncludes(
        operationalLog,
        '"message":"Daemon runtime loop failed"',
      );
      assertStringIncludes(operationalLog, '"error":"boom"');
      assertStringIncludes(operationalLog, '"severity":"critical"');
    } finally {
      await removePathIfPresent(runtimeDir);
    }
  });
});

Deno.test("runDaemonSubprocess wires export feature flag into runtime loop options", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const config = makeRuntimeConfig();
    const configStore: RuntimeConfigStoreLike = {
      load() {
        return Promise.resolve(config);
      },
      ensureInitialized(_defaultConfig) {
        throw new Error("not used");
      },
    };

    const captured: Array<{
      exportEnabled: boolean | undefined;
      hasSnapshotLoader: boolean;
      hasSessionSnapshotStore: boolean;
    }> = [];
    const stderr: string[] = [];

    const exitCode = await runDaemonSubprocess({
      configStore,
      sharedConfigStore: makeSharedConfigStore(),
      userConfigStore: makeUserConfigStore(),
      writeStderr(text: string) {
        stderr.push(text);
      },
      runtimeLoop(options = {}) {
        captured.push({
          exportEnabled: options.exportEnabled,
          hasSnapshotLoader: typeof options.loadSessionSnapshot === "function",
          hasSessionSnapshotStore: !!options.sessionSnapshotStore,
        });
        return Promise.resolve();
      },
    });

    assertEquals(exitCode, 0);
    assertEquals(captured, [{
      exportEnabled: false,
      hasSnapshotLoader: true,
      hasSessionSnapshotStore: true,
    }]);
    assertEquals(stderr.length, 0);
  });
});

Deno.test("runDaemonSubprocess snapshot loader falls back to redacted persisted history", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const rootDir = await makeTestTempDir("daemon-main-snapshot-loader-");

    try {
      const runtimeDir = join(rootDir, "runtime");
      const katoDir = join(rootDir, ".kato");
      const sourceDir = join(rootDir, "sources");
      const sourcePath = join(sourceDir, "session-claude.jsonl");
      const config = makeRuntimeConfig(runtimeDir);
      config.katoDir = katoDir;
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(config);
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };
      let loadedProvider: string | undefined;
      let loadedEventsJson = "";

      const exitCode = await runDaemonSubprocess({
        configStore,
        sharedConfigStore: makeSharedConfigStore(),
        userConfigStore: makeUserConfigStore(),
        async runtimeLoop(options = {}) {
          const store = options.sessionStateStore;
          const loadSessionSnapshot = options.loadSessionSnapshot;
          if (!store || !loadSessionSnapshot) {
            throw new Error("session stores should be wired");
          }
          await Deno.mkdir(sourceDir, { recursive: true });
          await Deno.writeTextFile(
            sourcePath,
            JSON.stringify({
              type: "user",
              uuid: "u1",
              timestamp: "2026-06-10T10:00:00.000Z",
              message: {
                role: "user",
                content: [{ type: "text", text: `key ${PLANTED_AWS_KEY}` }],
              },
            }) + "\n",
          );
          const metadata = await store.getOrCreateSessionMetadata({
            provider: "claude",
            providerSessionId: "session-claude",
            sourceFilePath: sourcePath,
            initialCursor: { kind: "byte-offset", value: 0 },
          });
          const loaded = await loadSessionSnapshot(metadata.providerSessionId);
          loadedProvider = loaded?.provider;
          loadedEventsJson = JSON.stringify(loaded?.events ?? []);
        },
      });

      assertEquals(exitCode, 0);
      assertEquals(loadedProvider, "claude");
      assertEquals(loadedEventsJson.includes(PLANTED_AWS_KEY), false);
      assertStringIncludes(
        loadedEventsJson,
        "[REDACTED:aws-access-key-id]",
      );
    } finally {
      await removePathIfPresent(rootDir);
    }
  });
});

Deno.test("runDaemonSubprocess wires exportTimezone into plain CLI export overrides", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const config = makeRuntimeConfig();
    const configStore: RuntimeConfigStoreLike = {
      load() {
        return Promise.resolve(config);
      },
      ensureInitialized(_defaultConfig) {
        throw new Error("not used");
      },
    };

    const captured: Array<string | undefined> = [];
    const exitCode = await runDaemonSubprocess({
      configStore,
      sharedConfigStore: makeSharedConfigStore(
        makeSharedConfig({ exportTimezone: "UTC" }),
      ),
      userConfigStore: makeUserConfigStore(),
      runtimeLoop(options = {}) {
        captured.push(
          options.defaultCliExportOutputOverrides?.renderOptions
            ?.headingTimestampTimezone,
        );
        return Promise.resolve();
      },
    });

    assertEquals(exitCode, 0);
    assertEquals(captured, ["UTC"]);
  });
});

Deno.test("runDaemonSubprocess plain CLI export uses default user participant username", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const config = makeRuntimeConfig();
    const configStore: RuntimeConfigStoreLike = {
      load() {
        return Promise.resolve(config);
      },
      ensureInitialized(_defaultConfig) {
        throw new Error("not used");
      },
    };

    const captured: Array<string | undefined> = [];
    const exitCode = await runDaemonSubprocess({
      configStore,
      sharedConfigStore: makeSharedConfigStore(
        makeSharedConfig({
          exportMarkdownFrontmatter:
            createDefaultRuntimeMarkdownFrontmatterConfig({
              addParticipantUsernameToFrontmatter: true,
            }),
        }),
      ),
      userConfigStore: makeUserConfigStore(
        createDefaultUserConfig({
          defaultUsername: "Default.User",
          workspaceUsernames: {},
          excludeMeFromParticipantList: false,
        }),
      ),
      runtimeLoop(options = {}) {
        captured.push(
          options.defaultCliExportOutputOverrides?.participantUsername,
        );
        return Promise.resolve();
      },
    });

    assertEquals(exitCode, 0);
    assertEquals(captured, ["Default.User"]);
  });
});

Deno.test("runDaemonSubprocess plain CLI export omits user participant when no explicit username exists", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const config = makeRuntimeConfig();
    const configStore: RuntimeConfigStoreLike = {
      load() {
        return Promise.resolve(config);
      },
      ensureInitialized(_defaultConfig) {
        throw new Error("not used");
      },
    };

    const captured: Array<string | undefined> = [];
    const exitCode = await runDaemonSubprocess({
      configStore,
      sharedConfigStore: makeSharedConfigStore(
        makeSharedConfig({
          exportMarkdownFrontmatter:
            createDefaultRuntimeMarkdownFrontmatterConfig({
              addParticipantUsernameToFrontmatter: true,
            }),
        }),
      ),
      userConfigStore: makeUserConfigStore(
        createDefaultUserConfig({
          defaultUsername: "",
          workspaceUsernames: {},
          excludeMeFromParticipantList: false,
        }),
      ),
      runtimeLoop(options = {}) {
        captured.push(
          options.defaultCliExportOutputOverrides?.participantUsername,
        );
        return Promise.resolve();
      },
    });

    assertEquals(exitCode, 0);
    assertEquals(captured, [undefined]);
  });
});

Deno.test("runDaemonSubprocess writes operational and audit logs to runtime log files", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const runtimeDir = await makeTestTempDir("daemon-main-logs-");

    try {
      const config = makeRuntimeConfig(runtimeDir);
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(config);
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };

      const exitCode = await runDaemonSubprocess({
        configStore,
        userConfigStore: makeUserConfigStore(),
        runtimeLoop(options = {}) {
          return Promise.all([
            options.operationalLogger?.info(
              "test.operational",
              "operational smoke",
            ),
            options.auditLogger?.record("test.audit", "audit smoke"),
          ]).then(() => undefined);
        },
      });

      assertEquals(exitCode, 0);

      const operationalLogPath = join(
        runtimeDir,
        "logs",
        "operational.jsonl",
      );
      const auditLogPath = join(runtimeDir, "logs", "security-audit.jsonl");

      const operationalLog = await Deno.readTextFile(operationalLogPath);
      const auditLog = await Deno.readTextFile(auditLogPath);
      assertStringIncludes(operationalLog, '"event":"test.operational"');
      assertStringIncludes(auditLog, '"event":"test.audit"');
    } finally {
      await removePathIfPresent(runtimeDir);
    }
  });
});

Deno.test("runDaemonSubprocess respects configured logger min levels", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const runtimeDir = await makeTestTempDir("daemon-main-log-levels-");

    try {
      const config = makeRuntimeConfig(runtimeDir);
      config.logging = {
        operationalLevel: "error",
        auditLevel: "error",
      };
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(config);
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };

      const exitCode = await runDaemonSubprocess({
        configStore,
        userConfigStore: makeUserConfigStore(),
        runtimeLoop(options = {}) {
          return Promise.all([
            options.operationalLogger?.info("test.info", "filtered"),
            options.operationalLogger?.error("test.error", "allowed"),
            options.auditLogger?.record("test.audit.info", "filtered"),
          ]).then(() => undefined);
        },
      });

      assertEquals(exitCode, 0);

      const operationalLogPath = join(
        runtimeDir,
        "logs",
        "operational.jsonl",
      );
      const auditLogPath = join(runtimeDir, "logs", "security-audit.jsonl");
      const operationalLog = await Deno.readTextFile(operationalLogPath);
      const auditLog = await Deno.readTextFile(auditLogPath).catch(() => "");

      assertStringIncludes(operationalLog, '"event":"test.error"');
      assertEquals(operationalLog.includes('"event":"test.info"'), false);
      assertEquals(auditLog.includes('"event":"test.audit.info"'), false);
    } finally {
      await removePathIfPresent(runtimeDir);
    }
  });
});

Deno.test("runDaemonSubprocess applies log-level env overrides", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const runtimeDir = await makeTestTempDir("daemon-main-log-level-env-");

    const originalOperational = Deno.env.get("KATO_LOGGING_OPERATIONAL_LEVEL");
    const originalAudit = Deno.env.get("KATO_LOGGING_AUDIT_LEVEL");

    try {
      const config = makeRuntimeConfig(runtimeDir);
      config.logging = {
        operationalLevel: "error",
        auditLevel: "error",
      };
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(config);
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };

      Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", "info");
      Deno.env.set("KATO_LOGGING_AUDIT_LEVEL", "info");

      const exitCode = await runDaemonSubprocess({
        configStore,
        userConfigStore: makeUserConfigStore(),
        runtimeLoop(options = {}) {
          return Promise.all([
            options.operationalLogger?.info("test.operational.info", "allowed"),
            options.auditLogger?.record("test.audit.info", "allowed"),
          ]).then(() => undefined);
        },
      });

      assertEquals(exitCode, 0);

      const operationalLogPath = join(
        runtimeDir,
        "logs",
        "operational.jsonl",
      );
      const auditLogPath = join(runtimeDir, "logs", "security-audit.jsonl");
      const operationalLog = await Deno.readTextFile(operationalLogPath);
      const auditLog = await Deno.readTextFile(auditLogPath);

      assertStringIncludes(operationalLog, '"event":"test.operational.info"');
      assertStringIncludes(auditLog, '"event":"test.audit.info"');
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
      await removePathIfPresent(runtimeDir);
    }
  });
});

Deno.test("runDaemonSubprocess fails closed on invalid log-level env override", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const originalOperational = Deno.env.get("KATO_LOGGING_OPERATIONAL_LEVEL");
    const stderr: string[] = [];

    try {
      Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", "verbose");
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(makeRuntimeConfig());
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };

      const exitCode = await runDaemonSubprocess({
        configStore,
        sharedConfigStore: makeSharedConfigStore(),
        userConfigStore: makeUserConfigStore(),
        writeStderr(text: string) {
          stderr.push(text);
        },
        runtimeLoop() {
          throw new Error("runtime loop should not be called");
        },
      });

      assertEquals(exitCode, 1);
      assertStringIncludes(stderr.join(""), "invalid logging level override");
      assertStringIncludes(
        stderr.join(""),
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
});

Deno.test("runDaemonSubprocess prefers runtimeConfig.katoDir for session state paths", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const rootDir = await makeTestTempDir("daemon-main-katodir-");

    try {
      const runtimeDir = join(rootDir, "runtime");
      const explicitKatoDir = join(rootDir, "state-root");
      const config = makeRuntimeConfig(runtimeDir);
      config.katoDir = explicitKatoDir;
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(config);
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };

      const observedMetadataPaths: string[] = [];
      const exitCode = await runDaemonSubprocess({
        configStore,
        userConfigStore: makeUserConfigStore(),
        runtimeLoop(options = {}) {
          const store = options.sessionStateStore;
          if (!store) {
            throw new Error("sessionStateStore should be defined");
          }
          const location = store.resolveLocation({
            provider: "codex",
            providerSessionId: "session-1",
          });
          observedMetadataPaths.push(location.metadataPath);
          return Promise.resolve();
        },
      });

      assertEquals(exitCode, 0);
      assertEquals(observedMetadataPaths.length, 1);
      assertEquals(
        observedMetadataPaths[0]?.startsWith(
          join(explicitKatoDir, "shared", "sessions"),
        ),
        true,
      );
    } finally {
      await removePathIfPresent(rootDir);
    }
  });
});

Deno.test("runDaemonSubprocess falls back to runtimeDir parent when runtimeConfig.katoDir is empty", async () => {
  await withIsolatedDaemonPathEnv(async () => {
    const rootDir = await makeTestTempDir("daemon-main-empty-katodir-");

    try {
      const runtimeDir = join(rootDir, "runtime");
      const config = makeRuntimeConfig(runtimeDir);
      config.katoDir = "";
      const configStore: RuntimeConfigStoreLike = {
        load() {
          return Promise.resolve(config);
        },
        ensureInitialized(_defaultConfig) {
          throw new Error("not used");
        },
      };

      const exitCode = await runDaemonSubprocess({
        configStore,
        userConfigStore: makeUserConfigStore(),
        runtimeLoop(options = {}) {
          if (!options.workspaceRegistryStore) {
            throw new Error("workspaceRegistryStore should be defined");
          }
          return options.workspaceRegistryStore.save([]);
        },
      });

      assertEquals(exitCode, 0);
      const fallbackRegistryPath = join(
        rootDir,
        "shared",
        DEFAULT_WORKSPACE_REGISTRY_FILENAME,
      );
      const stat = await Deno.stat(fallbackRegistryPath);
      assertEquals(stat.isFile, true);
    } finally {
      await removePathIfPresent(rootDir);
    }
  });
});
