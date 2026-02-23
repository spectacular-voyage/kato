import { assertEquals, assertStringIncludes } from "@std/assert";
import type { RuntimeConfig } from "@kato/shared";
import {
  runDaemonSubprocess,
  type RunDaemonSubprocessOptions,
  type RuntimeConfigStoreLike,
} from "../apps/daemon/src/mod.ts";

function makeRuntimeConfig(): RuntimeConfig {
  return {
    schemaVersion: 1,
    runtimeDir: ".kato/runtime",
    statusPath: ".kato/runtime/status.json",
    controlPath: ".kato/runtime/control.json",
    allowedWriteRoots: [".kato/runtime"],
    featureFlags: {
      writerIncludeThinking: false,
      writerIncludeToolCalls: false,
      writerItalicizeUserMessages: true,
      daemonExportEnabled: false,
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

  const captured: Array<{ exportEnabled: boolean | undefined }> = [];
  const stderr: string[] = [];

  const exitCode = await runDaemonSubprocess({
    configStore,
    writeStderr(text: string) {
      stderr.push(text);
    },
    runtimeLoop(options = {}) {
      captured.push({ exportEnabled: options.exportEnabled });
      return Promise.resolve();
    },
  });

  assertEquals(exitCode, 0);
  assertEquals(captured, [{ exportEnabled: false }]);
  assertEquals(stderr.length, 0);
});
