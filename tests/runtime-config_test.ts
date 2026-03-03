import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { stringify } from "@std/yaml";
import {
  CliConfigFileStore,
  createDefaultCliConfig,
  createDefaultRuntimeConfig,
  createDefaultSharedBehaviorConfig,
  resolveDefaultConfigPath,
  resolveDefaultSharedConfigPath,
  RuntimeConfigFileStore,
  SharedBehaviorConfigFileStore,
} from "@kato/runtime";
import { makeTestTempPath, removePathIfPresent } from "./test_temp.ts";

function makeSandboxRoot(): string {
  return makeTestTempPath("test-runtime-config-");
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
    assertEquals(loaded.daemonFeatureFlags, defaultConfig.daemonFeatureFlags);
  } finally {
    await removePathIfPresent(root);
  }
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
  assertEquals(resolved, ".kato/daemon/kato-daemon-config.yaml");
});

Deno.test("resolveDefaultSharedConfigPath keeps shared config under ~/.kato/shared", () => {
  const resolved = resolveDefaultSharedConfigPath(".kato");
  assertEquals(resolved, ".kato/shared/kato-shared-config.yaml");
});
