import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname } from "@std/path";
import type { WebConfig } from "@kato/shared";
import {
  clearSessionCookie,
  createCsrfToken,
  createSessionCookieValue,
  isAuthenticatedRequest,
  isSameOriginRequest,
  loadWebConfig,
  loadWebConfigState,
  readCsrfTokenFromRequest,
  setSessionCookie,
  verifyCsrfToken,
  verifyPassword,
} from "../apps/web/src/auth.ts";
import {
  createDefaultWebConfig,
  hashWebPassword,
  resolveDefaultWebConfigPath,
  WebConfigFileStore,
} from "../apps/runtime/src/mod.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

function encodeBase64(bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function makeWebConfig(): Promise<WebConfig> {
  const passwordSalt = encodeBase64(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  const sessionSecret = encodeBase64(
    Array.from({ length: 32 }, (_, index) => index + 17),
  );
  const passwordHash = await hashWebPassword("secret-pass", passwordSalt);
  return createDefaultWebConfig({
    hostname: "127.0.0.1",
    port: 5173,
    auth: {
      username: "dj",
      passwordSalt,
      passwordHash,
      sessionSecret,
      cookieName: "kato_web_test",
    },
  });
}

Deno.test("web auth verifies passwords and signed session cookies", async () => {
  const config = await makeWebConfig();

  assertEquals(await verifyPassword(config, "dj", "secret-pass"), true);
  assertEquals(await verifyPassword(config, "dj", "wrong-pass"), false);
  assertEquals(await verifyPassword(config, "other", "secret-pass"), false);

  const cookieValue = await createSessionCookieValue(config);
  const request = new Request("https://example.test/", {
    headers: { cookie: `${config.auth.cookieName}=${cookieValue}` },
  });
  assertEquals(await isAuthenticatedRequest(request, config), true);

  const tamperedRequest = new Request("https://example.test/", {
    headers: { cookie: `${config.auth.cookieName}=${cookieValue}00` },
  });
  assertEquals(await isAuthenticatedRequest(tamperedRequest, config), false);

  const realDateNow = Date.now;
  try {
    Date.now = () => realDateNow() + 13 * 60 * 60 * 1000;
    assertEquals(await isAuthenticatedRequest(request, config), false);
  } finally {
    Date.now = realDateNow;
  }
});

Deno.test("web auth handles csrf tokens, same-origin checks, and cookies", async () => {
  const config = await makeWebConfig();
  const sessionCookieValue = await createSessionCookieValue(config);
  const request = new Request("https://example.test/settings", {
    headers: {
      cookie: `${config.auth.cookieName}=${sessionCookieValue}`,
      origin: "https://example.test",
    },
  });

  const csrfToken = await createCsrfToken(request, config);
  assertEquals(typeof csrfToken, "string");
  assertEquals(await verifyCsrfToken(request, config, csrfToken), true);
  assertEquals(await verifyCsrfToken(request, config, `${csrfToken}x`), false);

  const headerToken = await readCsrfTokenFromRequest(
    new Request(request, {
      headers: {
        "x-kato-csrf": csrfToken ?? "",
      },
    }),
  );
  assertEquals(headerToken, csrfToken);

  const formToken = await readCsrfTokenFromRequest(
    new Request(request, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrfToken: csrfToken ?? "",
      }),
    }),
  );
  assertEquals(formToken, csrfToken);

  assertEquals(
    await createCsrfToken(new Request("https://example.test/"), config),
    undefined,
  );
  assertEquals(isSameOriginRequest(request), true);
  assertEquals(
    isSameOriginRequest(
      new Request("https://example.test/", {
        headers: { referer: "https://example.test/path" },
      }),
    ),
    true,
  );
  assertEquals(
    isSameOriginRequest(
      new Request("https://example.test/", {
        headers: { origin: "https://evil.test" },
      }),
    ),
    false,
  );
  assertEquals(
    isSameOriginRequest(
      new Request("https://example.test/", {
        headers: { referer: "not a url" },
      }),
    ),
    false,
  );

  const setHeaders = new Headers();
  await setSessionCookie(setHeaders, request, config);
  const setCookieValue = setHeaders.get("set-cookie") ?? "";
  assertStringIncludes(setCookieValue, `${config.auth.cookieName}=`);
  assertStringIncludes(setCookieValue, "HttpOnly");
  assertStringIncludes(setCookieValue, "SameSite=Strict");
  assertStringIncludes(setCookieValue, "Secure");

  const clearHeaders = new Headers();
  clearSessionCookie(clearHeaders, request, config);
  const clearedCookieValue = clearHeaders.get("set-cookie") ?? "";
  assertStringIncludes(clearedCookieValue, `${config.auth.cookieName}=`);
  assertStringIncludes(clearedCookieValue, "Max-Age=0");
  assertMatch(clearedCookieValue, /HttpOnly/i);
});

Deno.test("web auth fails closed for missing config, malformed cookies, and empty csrf submissions", async () => {
  const config = await makeWebConfig();
  const request = new Request("https://example.test/settings");

  assertEquals(await isAuthenticatedRequest(request, undefined), false);
  assertEquals(await isAuthenticatedRequest(request, config), false);
  assertEquals(
    await isAuthenticatedRequest(
      new Request("https://example.test/settings", {
        headers: { cookie: `${config.auth.cookieName}=malformed-cookie` },
      }),
      config,
    ),
    false,
  );
  assertEquals(isSameOriginRequest(request), false);
  assertEquals(
    await verifyCsrfToken(
      new Request("https://example.test/settings", {
        headers: { cookie: `${config.auth.cookieName}=missing-token-cookie` },
      }),
      config,
      undefined,
    ),
    false,
  );
  assertEquals(
    await readCsrfTokenFromRequest(
      new Request("https://example.test/settings", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          csrfToken: "",
        }),
      }),
    ),
    undefined,
  );
});

Deno.test("loadWebConfig and loadWebConfigState handle missing, invalid, and valid config files", async () => {
  await withLockedEnvironment(async () => {
    await withTestTempDir("web-auth-home-", async (homeDir) => {
      const envSnapshot = snapshotRuntimeEnv();
      try {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        assertEquals(await loadWebConfig(), undefined);
        assertEquals(await loadWebConfigState(), {});

        const configPath = resolveDefaultWebConfigPath();
        await Deno.mkdir(dirname(configPath), { recursive: true });
        await Deno.writeTextFile(configPath, "auth: [broken");

        const invalidState = await loadWebConfigState();
        assertStringIncludes(invalidState.error ?? "", "invalid YAML");
        await assertRejects(
          () => loadWebConfig(),
          Error,
          "invalid YAML",
        );

        await Deno.remove(configPath);

        const config = await makeWebConfig();
        const store = new WebConfigFileStore(configPath);
        await store.ensureInitialized(config);

        const loaded = await loadWebConfig();
        assertEquals(loaded?.auth.username, "dj");

        const validState = await loadWebConfigState();
        assertEquals(validState.error, undefined);
        assertEquals(validState.config?.port, 5173);
      } finally {
        restoreRuntimeEnv(envSnapshot);
      }
    });
  });
});
