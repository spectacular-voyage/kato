import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { RuntimeConfig } from "@kato/shared";
import {
  runDaemonSubprocess,
  type RunDaemonSubprocessOptions,
  type RuntimeConfigStoreLike,
} from "../apps/daemon/src/mod.ts";

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
      writerIncludeThinking: false,
      writerIncludeToolCalls: false,
      writerItalicizeUserMessages: true,
      daemonExportEnabled: false,
      captureIncludeSystemEvents: false,
    },
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
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const runtimeDir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "daemon-main-logs-",
  });

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
    await Deno.remove(runtimeDir, { recursive: true });
  }
});
