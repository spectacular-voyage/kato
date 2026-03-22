import { assertEquals } from "jsr:@std/assert@1";
import { join } from "@std/path";
import {
  createInitializedWebConfig,
  resolveDefaultWebConfigPath,
  WebConfigFileStore,
} from "@kato/runtime";
import { setRuntimeEnv, snapshotRuntimeEnv } from "../../../tests/test_env.ts";
import { withTestTempDir } from "../../../tests/test_temp.ts";

Deno.test("web app auth middleware returns 401 for API routes and 302 redirects for page routes", async () => {
  await withTestTempDir("web-app-auth-", async (homeDir) => {
    const envSnapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: homeDir,
        USERPROFILE: undefined,
        KATO_RUNTIME_DIR: undefined,
      });

      const katoDir = join(homeDir, ".kato");
      const configStore = new WebConfigFileStore(
        resolveDefaultWebConfigPath(katoDir),
      );
      await configStore.ensureInitialized(
        await createInitializedWebConfig({
          hostname: "127.0.0.1",
          port: 3187,
          username: "dj",
          password: "secret-pass",
        }),
      );

      const { app } = await import("../main.ts");
      const handler = app.handler();

      const apiResponse = await handler(
        new Request("http://kato.local/api/chrome-status"),
        {} as Deno.ServeHandlerInfo<Deno.NetAddr>,
      );
      assertEquals(apiResponse.status, 401);

      const pageResponse = await handler(
        new Request("http://kato.local/settings"),
        {} as Deno.ServeHandlerInfo<Deno.NetAddr>,
      );
      assertEquals(pageResponse.status, 302);
      assertEquals(
        pageResponse.headers.get("location"),
        "http://kato.local/login",
      );
    } finally {
      globalThis.dispatchEvent(new Event("unload"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      setRuntimeEnv(envSnapshot);
    }
  });
});
