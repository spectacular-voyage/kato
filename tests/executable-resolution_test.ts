import { assertEquals } from "@std/assert";
import { resolveInstalledExecutablePath } from "../apps/runtime/src/mod.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";

Deno.test("resolveInstalledExecutablePath prefers env override", async () => {
  await withLockedEnvironment(() => {
    const snapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: "/home/tester",
        USERPROFILE: undefined,
      });

      const path = resolveInstalledExecutablePath({
        envVarName: "KATO_DAEMON_BIN",
        siblingBaseName: "kato-daemon",
        launcherExecutablePath: "/opt/kato/kato",
        readEnv: (name) =>
          name === "KATO_DAEMON_BIN" ? "~/bin/custom-daemon" : undefined,
      });

      assertEquals(path, "/home/tester/bin/custom-daemon");
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("resolveInstalledExecutablePath falls back to sibling executable for installed kato", () => {
  const path = resolveInstalledExecutablePath({
    envVarName: "KATO_DAEMON_BIN",
    siblingBaseName: "kato-daemon",
    launcherExecutablePath: "/opt/kato/kato",
    readEnv: () => undefined,
  });

  assertEquals(path, "/opt/kato/kato-daemon");
});

Deno.test("resolveInstalledExecutablePath keeps Windows executable suffix for sibling binaries", () => {
  if (Deno.build.os !== "windows") {
    return;
  }

  const path = resolveInstalledExecutablePath({
    envVarName: "KATO_WEB_BIN",
    siblingBaseName: "kato-web",
    launcherExecutablePath: "C:\\Programs\\Kato\\kato.exe",
    readEnv: () => undefined,
  });

  assertEquals(path, "C:\\Programs\\Kato\\kato-web.exe");
});

Deno.test("resolveInstalledExecutablePath does not infer sibling binaries from deno source runs", () => {
  const path = resolveInstalledExecutablePath({
    envVarName: "KATO_WEB_BIN",
    siblingBaseName: "kato-web",
    launcherExecutablePath: "/usr/bin/deno",
    readEnv: () => undefined,
  });

  assertEquals(path, undefined);
});
