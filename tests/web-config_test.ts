import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultWebConfig,
  createInitializedWebConfig,
  hashWebPassword,
  resolveDefaultWebConfigPath,
  WebConfigFileStore,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

function encodeBase64(bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

Deno.test("hashWebPassword is deterministic for the same password and salt", async () => {
  const salt = encodeBase64(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );

  const first = await hashWebPassword("secret-pass", salt);
  const second = await hashWebPassword("secret-pass", salt);
  const different = await hashWebPassword("other-pass", salt);

  assertEquals(first, second);
  assertNotEquals(first, different);
});

Deno.test("createInitializedWebConfig trims inputs and stores a verifiable password hash", async () => {
  const config = await createInitializedWebConfig({
    hostname: " 127.0.0.1 ",
    port: 3187,
    username: " dj ",
    password: "secret-pass",
  });

  assertEquals(config.hostname, "127.0.0.1");
  assertEquals(config.port, 3187);
  assertEquals(config.auth.username, "dj");
  assertNotEquals(config.auth.passwordHash, "secret-pass");
  assertEquals(
    await hashWebPassword("secret-pass", config.auth.passwordSalt),
    config.auth.passwordHash,
  );
});

Deno.test("WebConfigFileStore initializes once and preserves an existing config", async () => {
  await withTestTempDir("web-config-store-", async (rootDir) => {
    const configPath = join(rootDir, "web", "kato-web-config.yaml");
    const store = new WebConfigFileStore(configPath);
    const initialConfig = createDefaultWebConfig({
      hostname: "127.0.0.1",
      port: 3187,
      auth: {
        username: "dj",
        passwordSalt: encodeBase64([1, 2, 3, 4]),
        passwordHash: "abcd",
        sessionSecret: encodeBase64([5, 6, 7, 8]),
        cookieName: "kato_web_test",
      },
    });

    const created = await store.ensureInitialized(initialConfig);
    assertEquals(created.created, true);
    assertEquals(created.path, configPath);
    assertEquals((await store.load()).auth.username, "dj");

    const alternateConfig = createDefaultWebConfig({
      hostname: "0.0.0.0",
      port: 9999,
      auth: {
        username: "other",
        passwordSalt: encodeBase64([9, 10, 11, 12]),
        passwordHash: "beef",
        sessionSecret: encodeBase64([13, 14, 15, 16]),
        cookieName: "alternate_cookie",
      },
    });
    const preserved = await store.ensureInitialized(alternateConfig);
    assertEquals(preserved.created, false);
    assertEquals(preserved.config.hostname, "127.0.0.1");
    assertEquals(preserved.config.port, 3187);
    assertEquals(preserved.config.auth.cookieName, "kato_web_test");
  });
});

Deno.test("WebConfigFileStore rejects invalid file paths and malformed config documents", async () => {
  await withTestTempDir("web-config-invalid-", async (rootDir) => {
    const invalidExtensionPath = join(rootDir, "web", "kato-web-config.json");
    const invalidExtensionStore = new WebConfigFileStore(invalidExtensionPath);
    await assertRejects(
      () => invalidExtensionStore.load(),
      Error,
      "must end with .yaml",
    );

    const yamlPath = join(rootDir, "web", "kato-web-config.yaml");
    const store = new WebConfigFileStore(yamlPath);

    await Deno.mkdir(join(rootDir, "web"), { recursive: true });
    await Deno.writeTextFile(yamlPath, "auth: [broken");
    await assertRejects(() => store.load(), Error, "invalid YAML");

    await Deno.writeTextFile(
      yamlPath,
      [
        "schemaVersion: 1",
        "hostname: 127.0.0.1",
        "port: 3187",
        "auth:",
        "  username: dj",
        "  passwordSalt: salt",
        "  passwordHash: abcd",
        "  sessionSecret: secret",
        "  cookieName: kato_web_test",
        "extraField: nope",
        "",
      ].join("\n"),
    );
    await assertRejects(
      () => store.load(),
      Error,
      "unsupported schema",
    );

    await assertRejects(
      () =>
        store.ensureInitialized({
          schemaVersion: 1,
          hostname: "127.0.0.1",
          port: 0,
          auth: {
            username: "dj",
            passwordSalt: "salt",
            passwordHash: "abcd",
            sessionSecret: "secret",
            cookieName: "kato_web_test",
          },
        }),
      Error,
      "unsupported schema",
    );
  });
});

Deno.test("resolveDefaultWebConfigPath nests the config under the kato web directory", () => {
  const katoDir = join(".test-tmp", "kato-home");
  assertStringIncludes(
    resolveDefaultWebConfigPath(katoDir),
    join(katoDir, "web", "kato-web-config.yaml"),
  );
});
