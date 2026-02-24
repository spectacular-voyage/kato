import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { DenoDetachedDaemonLauncher } from "../apps/daemon/src/mod.ts";

Deno.test("DenoDetachedDaemonLauncher passes configured paths to daemon subprocess", async () => {
  const runtime = {
    runtimeDir: ".kato/custom-runtime",
    configPath: ".kato/custom/config.json",
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
