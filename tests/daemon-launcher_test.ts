import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { DenoDetachedDaemonLauncher } from "../apps/runtime/src/mod.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { resolveTestTempPath } from "./test_temp.ts";

const LAUNCHER_RUNTIME_DIR = resolveTestTempPath("launcher", "runtime");
const LAUNCHER_CONFIG_PATH = resolveTestTempPath(
  "launcher",
  "config",
  "kato-daemon-config.yaml",
);
const LAUNCHER_STATUS_PATH = resolveTestTempPath(
  "launcher",
  "status",
  "status.json",
);
const LAUNCHER_CONTROL_PATH = resolveTestTempPath(
  "launcher",
  "control",
  "control.json",
);
const LAUNCHER_HOME_DIR = resolveTestTempPath("launcher", "home");

function decodeUtf16LeBase64(value: string): string {
  const raw = atob(value);
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-16le").decode(bytes);
}

Deno.test("DenoDetachedDaemonLauncher passes configured paths to daemon subprocess", async () => {
  const runtime = {
    runtimeDir: ".kato/custom-runtime",
    configPath: ".kato/custom/kato-daemon-config.yaml",
    statusPath: ".kato/custom/status/status.json",
    controlPath: ".kato/custom/control/control.json",
    allowedWriteRoots: ["./notes", "./exports"],
    providerSessionRoots: {
      claude: ["/sessions/claude"],
      codex: ["/sessions/codex"],
      gemini: ["/sessions/gemini"],
    },
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    writeStdout: (_text: string) => {},
    writeStderr: (_text: string) => {},
  };

  let capturedCommand: string | undefined;
  let capturedOptions:
    | ConstructorParameters<typeof Deno.Command>[1]
    | undefined;

  const launcher = new DenoDetachedDaemonLauncher(
    runtime,
    "/deno",
    "/app/daemon/main.ts",
    (command, options) => {
      capturedCommand = command;
      capturedOptions = options;
      return {
        spawn() {
          return { pid: 31337 };
        },
      };
    },
    false,
  );

  const pid = await launcher.launchDetached();
  assertEquals(pid, 31337);
  assertEquals(capturedCommand, "/deno");

  const args = capturedOptions?.args ?? [];
  assertEquals(args[0], "run");
  const allowReadArg = args[1];
  if (!allowReadArg?.startsWith("--allow-read=")) {
    throw new Error("launcher did not set --allow-read");
  }
  assertEquals(args[3], "--allow-env");
  assertEquals(args[4], "/app/daemon/main.ts");
  assertEquals(args[5], "__daemon-run");

  const allowReadRoots = allowReadArg
    .slice("--allow-read=".length)
    .split(",");
  assertEquals(allowReadRoots.includes(runtime.runtimeDir), true);
  assertEquals(allowReadRoots.includes(dirname(runtime.configPath)), true);
  assertEquals(allowReadRoots.includes(dirname(runtime.statusPath)), true);
  assertEquals(allowReadRoots.includes(dirname(runtime.controlPath)), true);
  assertEquals(allowReadRoots.includes("./notes"), true);
  assertEquals(allowReadRoots.includes("./exports"), true);
  assertEquals(allowReadRoots.includes("/sessions/claude"), true);
  assertEquals(allowReadRoots.includes("/sessions/codex"), true);
  assertEquals(allowReadRoots.includes("/sessions/gemini"), true);

  const allowWriteArg = args[2];
  if (!allowWriteArg?.startsWith("--allow-write=")) {
    throw new Error("launcher did not set --allow-write");
  }
  const allowWriteRoots = allowWriteArg
    .slice("--allow-write=".length)
    .split(",");
  assertEquals(allowWriteRoots.includes(runtime.runtimeDir), true);
  assertEquals(allowWriteRoots.includes(dirname(runtime.configPath)), true);
  assertEquals(allowWriteRoots.includes(dirname(runtime.statusPath)), true);
  assertEquals(allowWriteRoots.includes(dirname(runtime.controlPath)), true);
  assertEquals(allowWriteRoots.includes("./notes"), true);
  assertEquals(allowWriteRoots.includes("./exports"), true);

  const env = capturedOptions?.env ?? {};
  assertEquals(capturedOptions?.stdin, "null");
  assertEquals(capturedOptions?.stdout, "null");
  assertEquals(capturedOptions?.stderr, "inherit");
  assertEquals(env["KATO_RUNTIME_DIR"], runtime.runtimeDir);
  assertEquals(env["KATO_CONFIG_PATH"], runtime.configPath);
  assertEquals(env["KATO_DAEMON_STATUS_PATH"], runtime.statusPath);
  assertEquals(env["KATO_DAEMON_CONTROL_PATH"], runtime.controlPath);
  assertEquals(
    env["KATO_ALLOWED_WRITE_ROOTS_JSON"],
    JSON.stringify(runtime.allowedWriteRoots),
  );
  assertEquals(
    env["KATO_CLAUDE_SESSION_ROOTS"],
    JSON.stringify(runtime.providerSessionRoots.claude),
  );
  assertEquals(
    env["KATO_CODEX_SESSION_ROOTS"],
    JSON.stringify(runtime.providerSessionRoots.codex),
  );
  assertEquals(
    env["KATO_GEMINI_SESSION_ROOTS"],
    JSON.stringify(runtime.providerSessionRoots.gemini),
  );
});

Deno.test("DenoDetachedDaemonLauncher preserves Windows-style paths", async () => {
  if (Deno.build.os !== "windows") {
    return;
  }

  const runtime = {
    runtimeDir: "C:\\Users\\tester\\.kato\\daemon",
    configPath: "C:\\Users\\tester\\.kato\\daemon\\kato-daemon-config.yaml",
    statusPath: "C:\\Users\\tester\\.kato\\shared\\status.json",
    controlPath: "C:\\Users\\tester\\.kato\\shared\\ipc\\daemon-control.json",
    allowedWriteRoots: [
      "C:\\Users\\tester\\notes",
      "C:\\Users\\tester\\exports",
    ],
    providerSessionRoots: {
      claude: ["C:\\Users\\tester\\.claude\\projects"],
      codex: ["C:\\Users\\tester\\.codex\\sessions"],
      gemini: ["C:\\Users\\tester\\.gemini\\tmp"],
    },
    now: () => new Date("2026-03-04T10:00:00.000Z"),
    pid: 4242,
    writeStdout: (_text: string) => {},
    writeStderr: (_text: string) => {},
  };

  let capturedOptions:
    | ConstructorParameters<typeof Deno.Command>[1]
    | undefined;

  const launcher = new DenoDetachedDaemonLauncher(
    runtime,
    "C:\\deno\\deno.exe",
    "C:\\repo\\apps\\daemon\\src\\main.ts",
    (_command, options) => {
      capturedOptions = options;
      return {
        spawn() {
          return { pid: 31337 };
        },
      };
    },
    false,
  );

  const pid = await launcher.launchDetached();
  assertEquals(pid, 31337);

  const args = capturedOptions?.args ?? [];
  const allowReadArg = args[1];
  if (!allowReadArg?.startsWith("--allow-read=")) {
    throw new Error("launcher did not set --allow-read");
  }
  const allowWriteArg = args[2];
  if (!allowWriteArg?.startsWith("--allow-write=")) {
    throw new Error("launcher did not set --allow-write");
  }

  const allowReadRoots = allowReadArg
    .slice("--allow-read=".length)
    .split(",");
  const allowWriteRoots = allowWriteArg
    .slice("--allow-write=".length)
    .split(",");

  assertEquals(allowReadRoots.includes(runtime.runtimeDir), true);
  assertEquals(allowReadRoots.includes(dirname(runtime.configPath)), true);
  assertEquals(allowReadRoots.includes(dirname(runtime.statusPath)), true);
  assertEquals(allowReadRoots.includes(dirname(runtime.controlPath)), true);
  assertEquals(
    allowReadRoots.includes(runtime.providerSessionRoots.claude[0]),
    true,
  );
  assertEquals(
    allowReadRoots.includes(runtime.providerSessionRoots.codex[0]),
    true,
  );
  assertEquals(
    allowReadRoots.includes(runtime.providerSessionRoots.gemini[0]),
    true,
  );

  assertEquals(allowWriteRoots.includes(runtime.runtimeDir), true);
  assertEquals(allowWriteRoots.includes(dirname(runtime.configPath)), true);
  assertEquals(allowWriteRoots.includes(dirname(runtime.statusPath)), true);
  assertEquals(allowWriteRoots.includes(dirname(runtime.controlPath)), true);
  assertEquals(allowWriteRoots.includes(runtime.allowedWriteRoots[0]), true);
  assertEquals(allowWriteRoots.includes(runtime.allowedWriteRoots[1]), true);

  const env = capturedOptions?.env ?? {};
  assertEquals(env["KATO_RUNTIME_DIR"], runtime.runtimeDir);
  assertEquals(env["KATO_CONFIG_PATH"], runtime.configPath);
  assertEquals(env["KATO_DAEMON_STATUS_PATH"], runtime.statusPath);
  assertEquals(env["KATO_DAEMON_CONTROL_PATH"], runtime.controlPath);
  assertEquals(
    env["KATO_ALLOWED_WRITE_ROOTS_JSON"],
    JSON.stringify(runtime.allowedWriteRoots),
  );
});

Deno.test("DenoDetachedDaemonLauncher omits user config dir when home is unavailable", async () => {
  await withLockedEnvironment(async () => {
    const snapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: undefined,
        USERPROFILE: undefined,
      });

      const runtime = {
        runtimeDir: LAUNCHER_RUNTIME_DIR,
        configPath: LAUNCHER_CONFIG_PATH,
        statusPath: LAUNCHER_STATUS_PATH,
        controlPath: LAUNCHER_CONTROL_PATH,
      };

      let capturedOptions:
        | ConstructorParameters<typeof Deno.Command>[1]
        | undefined;

      const launcher = new DenoDetachedDaemonLauncher(
        runtime,
        "/deno",
        "/repo/apps/daemon/src/main.ts",
        (_command, options) => {
          capturedOptions = options;
          return {
            spawn() {
              return { pid: 31337 };
            },
          };
        },
        false,
      );

      const pid = await launcher.launchDetached();
      assertEquals(pid, 31337);

      const args = capturedOptions?.args ?? [];
      const allowReadArg = args[1];
      if (!allowReadArg?.startsWith("--allow-read=")) {
        throw new Error("launcher did not set --allow-read");
      }
      const allowReadRoots = new Set(
        allowReadArg.slice("--allow-read=".length).split(","),
      );

      assertEquals(
        allowReadRoots,
        new Set([
          runtime.runtimeDir,
          dirname(runtime.configPath),
          dirname(runtime.statusPath),
          dirname(runtime.controlPath),
          "/repo/apps/daemon/src/main.ts",
          "/repo/apps/daemon/src",
          "/repo",
        ]),
      );

      const env = capturedOptions?.env ?? {};
      assertEquals(env["KATO_ALLOWED_WRITE_ROOTS_JSON"], "[]");
      assertEquals(env["KATO_CLAUDE_SESSION_ROOTS"], "[]");
      assertEquals(env["KATO_CODEX_SESSION_ROOTS"], "[]");
      assertEquals(env["KATO_GEMINI_SESSION_ROOTS"], "[]");
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("DenoDetachedDaemonLauncher includes user config dir when home is available", async () => {
  await withLockedEnvironment(async () => {
    const snapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: LAUNCHER_HOME_DIR,
        USERPROFILE: undefined,
      });

      const runtime = {
        runtimeDir: LAUNCHER_RUNTIME_DIR,
        configPath: LAUNCHER_CONFIG_PATH,
        statusPath: LAUNCHER_STATUS_PATH,
        controlPath: LAUNCHER_CONTROL_PATH,
      };

      let capturedOptions:
        | ConstructorParameters<typeof Deno.Command>[1]
        | undefined;

      const launcher = new DenoDetachedDaemonLauncher(
        runtime,
        "/deno",
        "/repo/apps/daemon/src/main.ts",
        (_command, options) => {
          capturedOptions = options;
          return {
            spawn() {
              return { pid: 31337 };
            },
          };
        },
        false,
      );

      await launcher.launchDetached();

      const args = capturedOptions?.args ?? [];
      const allowReadArg = args[1];
      if (!allowReadArg?.startsWith("--allow-read=")) {
        throw new Error("launcher did not set --allow-read");
      }
      const allowReadRoots = allowReadArg
        .slice("--allow-read=".length)
        .split(",");

      assertEquals(
        allowReadRoots.includes(join(LAUNCHER_HOME_DIR, ".kato")),
        true,
      );
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("DenoDetachedDaemonLauncher encodes PowerShell launch script and returns pid", async () => {
  let capturedCommand: string | undefined;
  let capturedOptions:
    | ConstructorParameters<typeof Deno.Command>[1]
    | undefined;

  const launcher = new DenoDetachedDaemonLauncher(
    {
      runtimeDir: LAUNCHER_RUNTIME_DIR,
      configPath: LAUNCHER_CONFIG_PATH,
      statusPath: LAUNCHER_STATUS_PATH,
      controlPath: LAUNCHER_CONTROL_PATH,
    },
    "/deno's/bin/deno",
    "/repo/apps/daemon/src/main.ts",
    (command, options) => {
      capturedCommand = command;
      capturedOptions = options;
      return {
        spawn() {
          throw new Error("spawn should not be used for PowerShell path");
        },
        output() {
          return Promise.resolve({
            code: 0,
            stdout: new TextEncoder().encode("31337\n"),
            stderr: new Uint8Array(),
          });
        },
      };
    },
    true,
  );

  const powerShellLauncher = launcher as unknown as {
    launchDetachedViaPowerShell(
      args: string[],
      env: Record<string, string>,
    ): Promise<number>;
  };

  const pid = await powerShellLauncher.launchDetachedViaPowerShell(
    ["run", "--flag", "arg'withquote"],
    {
      KATO_RUNTIME_DIR: LAUNCHER_RUNTIME_DIR,
      SPECIAL_VALUE: "O'Brien",
    },
  );

  assertEquals(pid, 31337);
  assertEquals(capturedCommand, "powershell.exe");
  assertEquals(capturedOptions?.stdin, "null");
  assertEquals(capturedOptions?.stdout, "piped");
  assertEquals(capturedOptions?.stderr, "piped");
  assertEquals(capturedOptions?.args?.[0], "-NoProfile");
  assertEquals(capturedOptions?.args?.[1], "-NonInteractive");
  assertEquals(capturedOptions?.args?.[2], "-EncodedCommand");

  const encoded = capturedOptions?.args?.[3];
  if (!encoded) {
    throw new Error("launcher did not encode PowerShell command");
  }
  const script = decodeUtf16LeBase64(encoded);
  assertStringIncludes(script, "$env:SPECIAL_VALUE='O''Brien'");
  assertStringIncludes(
    script,
    "$argList = @('run', '--flag', 'arg''withquote')",
  );
  assertStringIncludes(script, "-FilePath '/deno''s/bin/deno'");
});

Deno.test("DenoDetachedDaemonLauncher surfaces PowerShell launch failures", async () => {
  const launcher = new DenoDetachedDaemonLauncher(
    {
      runtimeDir: LAUNCHER_RUNTIME_DIR,
      configPath: LAUNCHER_CONFIG_PATH,
      statusPath: LAUNCHER_STATUS_PATH,
      controlPath: LAUNCHER_CONTROL_PATH,
    },
    "/deno",
    "/repo/apps/daemon/src/main.ts",
    () => ({
      spawn() {
        throw new Error("spawn should not be used for PowerShell path");
      },
      output() {
        return Promise.resolve({
          code: 1,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("boom"),
        });
      },
    }),
    true,
  );

  const powerShellLauncher = launcher as unknown as {
    launchDetachedViaPowerShell(
      args: string[],
      env: Record<string, string>,
    ): Promise<number>;
  };

  await assertRejects(
    () => powerShellLauncher.launchDetachedViaPowerShell(["run"], {}),
    Error,
    "PowerShell Start-Process launch failed (exit 1): boom",
  );
});

Deno.test("DenoDetachedDaemonLauncher rejects invalid PowerShell pid output", async () => {
  const launcher = new DenoDetachedDaemonLauncher(
    {
      runtimeDir: LAUNCHER_RUNTIME_DIR,
      configPath: LAUNCHER_CONFIG_PATH,
      statusPath: LAUNCHER_STATUS_PATH,
      controlPath: LAUNCHER_CONTROL_PATH,
    },
    "/deno",
    "/repo/apps/daemon/src/main.ts",
    () => ({
      spawn() {
        throw new Error("spawn should not be used for PowerShell path");
      },
      output() {
        return Promise.resolve({
          code: 0,
          stdout: new TextEncoder().encode("not-a-pid"),
          stderr: new Uint8Array(),
        });
      },
    }),
    true,
  );

  const powerShellLauncher = launcher as unknown as {
    launchDetachedViaPowerShell(
      args: string[],
      env: Record<string, string>,
    ): Promise<number>;
  };

  await assertRejects(
    () => powerShellLauncher.launchDetachedViaPowerShell(["run"], {}),
    Error,
    "PowerShell Start-Process did not return a valid PID",
  );
});
