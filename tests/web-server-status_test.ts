import { assertEquals, assertExists } from "@std/assert";
import {
  createDefaultWebConfig,
  resolveDefaultWebConfigPath,
  resolveDefaultWebStatusPath,
  WebConfigFileStore,
  WebServerStatusFileStore,
} from "../apps/runtime/src/mod.ts";
import {
  parseWebListenArgs,
  startWebServerStatusHeartbeat,
} from "../apps/web/src/server_status.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for web status heartbeat");
}

Deno.test("parseWebListenArgs reads split host and port flags", () => {
  const parsed = parseWebListenArgs([
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
  ]);

  assertEquals(parsed.hostname, "127.0.0.1");
  assertEquals(parsed.port, 5173);
});

Deno.test("parseWebListenArgs reads equals-style host and port flags", () => {
  const parsed = parseWebListenArgs([
    "--host=0.0.0.0",
    "--port=3187",
  ]);

  assertEquals(parsed.hostname, "0.0.0.0");
  assertEquals(parsed.port, 3187);
});

Deno.test("parseWebListenArgs ignores invalid port values", () => {
  const parsed = parseWebListenArgs([
    "--host",
    "localhost",
    "--port",
    "not-a-port",
  ]);

  assertEquals(parsed.hostname, "localhost");
  assertEquals(parsed.port, undefined);
});

Deno.test("parseWebListenArgs ignores empty args and falls through to later valid values", () => {
  const parsed = parseWebListenArgs([
    "",
    "--host",
    "",
    "--port",
    "",
    "--host=127.0.0.1",
    "--port=3187",
  ]);

  assertEquals(parsed.hostname, "127.0.0.1");
  assertEquals(parsed.port, 3187);
});

Deno.test({
  name:
    "startWebServerStatusHeartbeat persists running and stopped status from default config",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withLockedEnvironment(async () => {
      await withTestTempDir("web-status-heartbeat-", async (homeDir) => {
        const envSnapshot = snapshotRuntimeEnv();
        try {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

          const configStore = new WebConfigFileStore(
            resolveDefaultWebConfigPath(),
          );
          await configStore.ensureInitialized(
            createDefaultWebConfig({
              hostname: "127.0.0.1",
              port: 3187,
              auth: {
                username: "dj",
                passwordSalt: "salt",
                passwordHash: "abcd",
                sessionSecret: "secret",
                cookieName: "kato_web_test",
              },
            }),
          );

          const statusStore = new WebServerStatusFileStore(
            resolveDefaultWebStatusPath(),
          );

          startWebServerStatusHeartbeat();

          await waitFor(async () =>
            (await statusStore.load()).running === true
          );
          const runningStatus = await statusStore.load();
          assertEquals(runningStatus.running, true);
          assertEquals(runningStatus.hostname, "127.0.0.1");
          assertEquals(runningStatus.port, 3187);
          assertEquals(runningStatus.url, "http://127.0.0.1:3187/");
          assertExists(runningStatus.pid);
          assertExists(runningStatus.startedAt);

          startWebServerStatusHeartbeat();

          globalThis.dispatchEvent(new Event("unload"));

          await waitFor(async () =>
            (await statusStore.load()).running === false
          );
          const stoppedStatus = await statusStore.load();
          assertEquals(stoppedStatus.running, false);
          assertEquals(stoppedStatus.pid, undefined);
        } finally {
          (globalThis as Record<string, unknown>).__katoWebStatusRuntime =
            undefined;
          restoreRuntimeEnv(envSnapshot);
        }
      });
    });
  },
});

Deno.test({
  name:
    "startWebServerStatusHeartbeat uses default listen options when web config is absent",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withLockedEnvironment(async () => {
      await withTestTempDir(
        "web-status-heartbeat-defaults-",
        async (homeDir) => {
          const envSnapshot = snapshotRuntimeEnv();
          try {
            setRuntimeEnv({
              HOME: homeDir,
              USERPROFILE: undefined,
              KATO_RUNTIME_DIR: undefined,
            });

            const statusStore = new WebServerStatusFileStore(
              resolveDefaultWebStatusPath(),
            );

            startWebServerStatusHeartbeat();

            await waitFor(async () =>
              (await statusStore.load()).running === true
            );
            const runningStatus = await statusStore.load();
            assertEquals(runningStatus.hostname, "127.0.0.1");
            assertEquals(runningStatus.port, 5173);

            globalThis.dispatchEvent(new Event("unload"));
            await waitFor(async () =>
              (await statusStore.load()).running === false
            );
          } finally {
            (globalThis as Record<string, unknown>).__katoWebStatusRuntime =
              undefined;
            restoreRuntimeEnv(envSnapshot);
          }
        },
      );
    });
  },
});
