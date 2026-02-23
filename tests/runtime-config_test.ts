import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultRuntimeConfig,
  createDefaultRuntimeFeatureFlags,
  RuntimeConfigFileStore,
} from "../apps/daemon/src/mod.ts";

function makeSandboxRoot(): string {
  return join(".kato", "test-runtime-config", crypto.randomUUID());
}

Deno.test("RuntimeConfigFileStore initializes missing config atomically", async () => {
  const root = makeSandboxRoot();
  const runtimeDir = join(root, "runtime");
  const configPath = join(root, "config.json");
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
    const loadedAgain = await store.load();
    assertEquals(loadedAgain.allowedWriteRoots.includes("mutated"), false);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("RuntimeConfigFileStore rejects unsupported schema", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "config.json");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
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
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("RuntimeConfigFileStore backfills default feature flags for legacy config", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "config.json");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
      }),
    );

    const loaded = await store.load();
    assertEquals(loaded.featureFlags, createDefaultRuntimeFeatureFlags());
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("RuntimeConfigFileStore rejects unknown feature flag keys", async () => {
  const root = makeSandboxRoot();
  const configPath = join(root, "config.json");
  const runtimeDir = join(root, "runtime");
  const store = new RuntimeConfigFileStore(configPath);

  try {
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        runtimeDir,
        statusPath: join(runtimeDir, "status.json"),
        controlPath: join(runtimeDir, "control.json"),
        allowedWriteRoots: [root],
        featureFlags: {
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
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
