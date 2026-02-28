import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { RuntimeConfig } from "@kato/shared";
import {
  runDaemonSubprocess,
  type RunDaemonSubprocessOptions,
  type RuntimeConfigStoreLike,
} from "../apps/daemon/src/mod.ts";
import { makeTestTempDir, removePathIfPresent } from "./test_temp.ts";

function makeRuntimeConfig(runtimeDir = ".kato/runtime"): RuntimeConfig {
  return {
    schemaVersion: 1,
    runtimeDir,
    statusPath: join(runtimeDir, "status.json"),
    controlPath: join(runtimeDir, "control.json"),
    allowedWriteRoots: [runtimeDir],
    providerSessionRoots: {
      claude: ["/sessions/claude"],
      codex: ["/sessions/codex"],
      gemini: ["/sessions/gemini"],
    },
    featureFlags: {
      writerIncludeCommentary: true,
      writerIncludeThinking: false,
      writerIncludeToolCalls: false,
      writerItalicizeUserMessages: true,
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

Deno.test("runDaemonSubprocess fails closed when runtime config cannot be loaded", async () => {
  const stderr: string[] = [];
  const configStore: RuntimeConfigStoreLike = {
    load() {
      return Promise.reject(new Error("bad config"));
    },
    ensureInitialized() {
      throw new Error("not used");
    },
  };

  const options: RunDaemonSubprocessOptions = {
    runtimeDir: ".kato/runtime",
    configStore,
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
});

Deno.test("runDaemonSubprocess wires export feature flag into runtime loop options", async () => {
  const config = makeRuntimeConfig();
  const configStore: RuntimeConfigStoreLike = {
    load() {
      return Promise.resolve(config);
    },
    ensureInitialized() {
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

Deno.test("runDaemonSubprocess writes operational and audit logs to runtime log files", async () => {
  const runtimeDir = await makeTestTempDir("daemon-main-logs-");

  try {
    const config = makeRuntimeConfig(runtimeDir);
    const configStore: RuntimeConfigStoreLike = {
      load() {
        return Promise.resolve(config);
      },
      ensureInitialized() {
        throw new Error("not used");
      },
    };

    const exitCode = await runDaemonSubprocess({
      configStore,
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

Deno.test("runDaemonSubprocess respects configured logger min levels", async () => {
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
      ensureInitialized() {
        throw new Error("not used");
      },
    };

    const exitCode = await runDaemonSubprocess({
      configStore,
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

Deno.test("runDaemonSubprocess applies log-level env overrides", async () => {
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
      ensureInitialized() {
        throw new Error("not used");
      },
    };

    Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", "info");
    Deno.env.set("KATO_LOGGING_AUDIT_LEVEL", "info");

    const exitCode = await runDaemonSubprocess({
      configStore,
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

Deno.test("runDaemonSubprocess fails closed on invalid log-level env override", async () => {
  const originalOperational = Deno.env.get("KATO_LOGGING_OPERATIONAL_LEVEL");
  const stderr: string[] = [];

  try {
    Deno.env.set("KATO_LOGGING_OPERATIONAL_LEVEL", "verbose");
    const configStore: RuntimeConfigStoreLike = {
      load() {
        return Promise.resolve(makeRuntimeConfig());
      },
      ensureInitialized() {
        throw new Error("not used");
      },
    };

    const exitCode = await runDaemonSubprocess({
      configStore,
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

Deno.test("runDaemonSubprocess prefers runtimeConfig.katoDir for session state paths", async () => {
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
      ensureInitialized() {
        throw new Error("not used");
      },
    };

    const observedMetadataPaths: string[] = [];
    const exitCode = await runDaemonSubprocess({
      configStore,
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
      observedMetadataPaths[0]?.startsWith(join(explicitKatoDir, "sessions")),
      true,
    );
  } finally {
    await removePathIfPresent(rootDir);
  }
});
