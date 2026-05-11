import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultWebServerStatus,
  DenoDetachedWebLauncher,
  isProcessAlive,
  selectAvailableWebPort,
  WebServerStatusFileStore,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

function decodePowerShellEncodedCommand(encodedCommand: string): string {
  const binary = atob(encodedCommand);
  let script = "";
  for (let i = 0; i < binary.length; i += 2) {
    script += String.fromCharCode(
      binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8),
    );
  }
  return script;
}

function makeFakeListener(onClose: () => void = () => {}): Deno.Listener {
  return {
    addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
    accept() {
      return Promise.reject(new Error("unused test listener"));
    },
    close() {
      onClose();
    },
    ref() {},
    unref() {},
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        },
      };
    },
  } as unknown as Deno.Listener;
}

Deno.test("selectAvailableWebPort returns the preferred port when it can bind", async () => {
  let closed = false;
  const selected = await selectAvailableWebPort(
    { hostname: "127.0.0.1", preferredPort: 5173 },
    {
      buildOs: "linux",
      readTextFile: () => Promise.resolve("Linux"),
      listen(options) {
        assertEquals((options as { port: number }).port, 5173);
        return makeFakeListener(() => {
          closed = true;
        });
      },
    },
  );

  assertEquals(selected, 5173);
  assertEquals(closed, true);
});

Deno.test("selectAvailableWebPort tries the next port after a local bind collision", async () => {
  const attempts: number[] = [];
  const selected = await selectAvailableWebPort(
    { hostname: "127.0.0.1", preferredPort: 5173 },
    {
      buildOs: "linux",
      readTextFile: () => Promise.resolve("Linux"),
      listen(options) {
        const port = (options as { port: number }).port;
        attempts.push(port);
        if (port === 5173) {
          const error = new Error("Address already in use");
          error.name = "AddrInUse";
          throw error;
        }
        return makeFakeListener();
      },
    },
  );

  assertEquals(selected, 5174);
  assertEquals(attempts, [5173, 5174]);
});

Deno.test("selectAvailableWebPort skips a Windows-host listener when running under WSL", async () => {
  const bindAttempts: number[] = [];
  const windowsProbePorts: number[] = [];
  const selected = await selectAvailableWebPort(
    { hostname: "127.0.0.1", preferredPort: 5173 },
    {
      buildOs: "linux",
      readTextFile(path) {
        assertEquals(path, "/proc/sys/kernel/osrelease");
        return Promise.resolve("5.15.167.4-microsoft-standard-WSL2");
      },
      listen(options) {
        bindAttempts.push((options as { port: number }).port);
        return makeFakeListener();
      },
      commandFactory(_command, options) {
        const decoded = decodePowerShellEncodedCommand(
          String(options?.args?.[3] ?? ""),
        );
        const port = Number.parseInt(
          decoded.match(/\$port = (\d+);/)?.[1] ?? "",
          10,
        );
        windowsProbePorts.push(port);
        return {
          spawn() {
            throw new Error("unexpected spawn call");
          },
          output() {
            return Promise.resolve({
              code: port === 5173 ? 0 : 1,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            });
          },
        };
      },
    },
  );

  assertEquals(selected, 5174);
  assertEquals(bindAttempts, [5173, 5174]);
  assertEquals(windowsProbePorts, [5173, 5174]);
});

Deno.test(
  "DenoDetachedWebLauncher builds then launches the bundled web server via detached shell",
  async () => {
    if (Deno.build.os === "windows") {
      return;
    }

    let capturedCommand: string | undefined;
    let capturedOptions:
      | ConstructorParameters<typeof Deno.Command>[1]
      | undefined;

    await withTestTempDir("web-launcher-", async (workspaceRoot) => {
      const expectedWebRoot = join(workspaceRoot, "apps", "web");

      const launcher = new DenoDetachedWebLauncher(
        "/fake/deno",
        workspaceRoot,
        (command, options) => {
          capturedCommand = command;
          capturedOptions = options;
          return {
            spawn() {
              throw new Error("unexpected spawn call");
            },
            output() {
              return Promise.resolve({
                code: 0,
                stdout: new TextEncoder().encode("12345\n"),
                stderr: new Uint8Array(),
              });
            },
          };
        },
      );

      const pid = await launcher.launchDetached({
        hostname: "127.0.0.1",
        port: 5173,
      });

      assertEquals(pid, 12345);
      assertEquals(capturedCommand, "sh");
      assertEquals(capturedOptions?.stdin, "null");
      assertEquals(capturedOptions?.stdout, "piped");
      assertEquals(capturedOptions?.stderr, "piped");
      assertEquals(capturedOptions?.env?.CI, "true");
      assertEquals(capturedOptions?.args?.[0], "-lc");
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        `cd '${expectedWebRoot}'`,
      );
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        "command -v setsid >/dev/null 2>&1",
      );
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        "'/fake/deno' 'run' '--node-modules-dir=auto' '--ext=js' '-A' 'vite' 'build' >/dev/null",
      );
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        "KATO_BUILD_MS",
      );
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        "setsid '/fake/deno' 'serve' '--node-modules-dir=auto' '-A' '--host' '127.0.0.1' '--port' '5173' '_fresh/server.js'",
      );
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        "nohup '/fake/deno' 'serve' '--node-modules-dir=auto' '-A' '--host' '127.0.0.1' '--port' '5173' '_fresh/server.js'",
      );
    });
  },
);

Deno.test(
  "DenoDetachedWebLauncher skips source build when Fresh output is current",
  async () => {
    if (Deno.build.os === "windows") {
      return;
    }

    let capturedOptions:
      | ConstructorParameters<typeof Deno.Command>[1]
      | undefined;

    await withTestTempDir("web-launcher-current-", async (workspaceRoot) => {
      const webRoot = join(workspaceRoot, "apps", "web");
      await Deno.mkdir(join(webRoot, "_fresh"), { recursive: true });
      await Deno.mkdir(join(webRoot, "routes"), { recursive: true });
      await Deno.mkdir(join(workspaceRoot, "apps", "runtime", "src"), {
        recursive: true,
      });
      await Deno.mkdir(join(workspaceRoot, "shared", "src"), {
        recursive: true,
      });
      await Deno.writeTextFile(join(webRoot, "routes", "index.tsx"), "route");
      await Deno.writeTextFile(
        join(workspaceRoot, "apps", "runtime", "src", "mod.ts"),
        "runtime",
      );
      await Deno.writeTextFile(
        join(workspaceRoot, "shared", "src", "mod.ts"),
        "shared",
      );
      await Deno.writeTextFile(join(webRoot, "_fresh", "server.js"), "server");

      const launcher = new DenoDetachedWebLauncher(
        "/fake/deno",
        workspaceRoot,
        (_command, options) => {
          capturedOptions = options;
          return {
            spawn() {
              throw new Error("unexpected spawn call");
            },
            output() {
              return Promise.resolve({
                code: 0,
                stdout: new TextEncoder().encode("12345\n"),
                stderr: new Uint8Array(),
              });
            },
          };
        },
      );

      const result = await launcher.launchDetachedDetailed({
        hostname: "127.0.0.1",
        port: 5173,
      });

      assertEquals(result.pid, 12345);
      const script = capturedOptions?.args?.[1] ?? "";
      assertStringIncludes(script, "KATO_BUILD_MS=0");
      assertEquals(script.includes("'vite' 'build'"), false);
    });
  },
);

Deno.test(
  "DenoDetachedWebLauncher Windows source path auto-materializes npm modules and fails closed on build errors",
  async () => {
    if (Deno.build.os !== "windows") {
      return;
    }

    let capturedCommand: string | undefined;
    let capturedOptions:
      | ConstructorParameters<typeof Deno.Command>[1]
      | undefined;

    const launcher = new DenoDetachedWebLauncher(
      "C:\\fake\\deno.exe",
      "C:\\repo",
      (command, options) => {
        capturedCommand = command;
        capturedOptions = options;
        return {
          spawn() {
            throw new Error("unexpected spawn call");
          },
          output() {
            return Promise.resolve({
              code: 0,
              stdout: new TextEncoder().encode("2468\n"),
              stderr: new Uint8Array(),
            });
          },
        };
      },
    );

    const pid = await launcher.launchDetached({
      hostname: "127.0.0.1",
      port: 5173,
    });

    assertEquals(pid, 2468);
    assertEquals(capturedCommand, "powershell.exe");
    const decoded = decodePowerShellEncodedCommand(
      capturedOptions?.args?.[3] ?? "",
    );
    assertStringIncludes(
      decoded,
      "'run' '--node-modules-dir=auto' '--ext=js' '-A' 'vite' 'build'",
    );
    assertStringIncludes(decoded, "KATO_BUILD_MS");
    assertStringIncludes(decoded, "$LASTEXITCODE -ne 0");
    assertStringIncludes(
      decoded,
      "$argList = @('serve', '--node-modules-dir=auto', '-A', '--host', '127.0.0.1', '--port', '5173', '_fresh/server.js');",
    );
  },
);

Deno.test(
  "DenoDetachedWebLauncher PowerShell helper encodes Start-Process and returns the pid",
  async () => {
    let capturedCommand: string | undefined;
    let capturedOptions:
      | ConstructorParameters<typeof Deno.Command>[1]
      | undefined;

    const launcher = new DenoDetachedWebLauncher(
      "/fake/deno",
      "C:\\repo",
      (command, options) => {
        capturedCommand = command;
        capturedOptions = options;
        return {
          spawn() {
            throw new Error("unexpected spawn call");
          },
          output() {
            return Promise.resolve({
              code: 0,
              stdout: new TextEncoder().encode("4321\n"),
              stderr: new Uint8Array(),
            });
          },
        };
      },
    );

    const pid = await (
      launcher as unknown as {
        launchDetachedViaPowerShell(
          executablePath: string,
          args: string[],
          workingDirectory: string,
        ): Promise<{ pid: number }>;
      }
    ).launchDetachedViaPowerShell(
      "/fake/deno",
      ["run", "--ext=js", "-A", "vite", "--port", "3173"],
      "C:\\repo\\apps\\web",
    ).then((result) => result.pid);

    assertEquals(pid, 4321);
    assertEquals(capturedCommand, "powershell.exe");
    assertEquals(capturedOptions?.args?.[0], "-NoProfile");
    assertEquals(capturedOptions?.args?.[1], "-NonInteractive");
    assertEquals(capturedOptions?.args?.[2], "-EncodedCommand");
    assertEquals(capturedOptions?.env?.CI, "true");
    const decoded = decodePowerShellEncodedCommand(
      capturedOptions?.args?.[3] ?? "",
    );
    assertStringIncludes(decoded, "Start-Process -FilePath '/fake/deno'");
    assertStringIncludes(decoded, "-WorkingDirectory 'C:\\repo\\apps\\web'");
    assertStringIncludes(decoded, "'run', '--ext=js', '-A', 'vite'");
  },
);

Deno.test(
  "DenoDetachedWebLauncher PowerShell helper surfaces launch failures and invalid pid output",
  async () => {
    const failingLauncher = new DenoDetachedWebLauncher(
      "/fake/deno",
      "C:\\repo",
      () => ({
        spawn() {
          throw new Error("unexpected spawn call");
        },
        output() {
          return Promise.resolve({
            code: 1,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode("powershell boom"),
          });
        },
      }),
    );

    await assertRejects(
      () =>
        (
          failingLauncher as unknown as {
            launchDetachedViaPowerShell(
              executablePath: string,
              args: string[],
              workingDirectory: string,
            ): Promise<{ pid: number }>;
          }
        ).launchDetachedViaPowerShell(
          "/fake/deno",
          ["run"],
          "C:\\repo\\apps\\web",
        ),
      Error,
      "PowerShell Start-Process launch failed",
    );

    const invalidPidLauncher = new DenoDetachedWebLauncher(
      "/fake/deno",
      "C:\\repo",
      () => ({
        spawn() {
          throw new Error("unexpected spawn call");
        },
        output() {
          return Promise.resolve({
            code: 0,
            stdout: new TextEncoder().encode("not-a-pid\n"),
            stderr: new Uint8Array(),
          });
        },
      }),
    );

    await assertRejects(
      () =>
        (
          invalidPidLauncher as unknown as {
            launchDetachedViaPowerShell(
              executablePath: string,
              args: string[],
              workingDirectory: string,
            ): Promise<{ pid: number }>;
          }
        ).launchDetachedViaPowerShell(
          "/fake/deno",
          ["run"],
          "C:\\repo\\apps\\web",
        ),
      Error,
      "did not return a valid PID",
    );
  },
);

Deno.test(
  "DenoDetachedWebLauncher PowerShell script helper accepts build output before the pid",
  async () => {
    const launcher = new DenoDetachedWebLauncher(
      "/fake/deno",
      "C:\\repo",
      () => ({
        spawn() {
          throw new Error("unexpected spawn call");
        },
        output() {
          return Promise.resolve({
            code: 0,
            stdout: new TextEncoder().encode(
              [
                "vite v7.3.1 building client environment for production...",
                "transforming...",
                "✓ 2 modules transformed.",
                "KATO_BUILD_MS=1234",
                "29284",
                "",
              ].join("\n"),
            ),
            stderr: new Uint8Array(),
          });
        },
      }),
    );

    const result = await (
      launcher as unknown as {
        launchDetachedScriptViaPowerShell(
          script: string,
        ): Promise<{ pid: number; buildLatencyMs?: number }>;
      }
    ).launchDetachedScriptViaPowerShell("Write-Output 'stub'");

    assertEquals(result.pid, 29284);
    assertEquals(result.buildLatencyMs, 1234);
  },
);

Deno.test(
  "DenoDetachedWebLauncher can launch an installed web binary directly",
  async () => {
    let capturedCommand: string | undefined;
    let capturedOptions:
      | ConstructorParameters<typeof Deno.Command>[1]
      | undefined;

    const launcher = new DenoDetachedWebLauncher(
      "/fake/deno",
      "/repo",
      (command, options) => {
        capturedCommand = command;
        capturedOptions = options;
        return {
          spawn() {
            throw new Error("unexpected spawn call");
          },
          output() {
            return Promise.resolve({
              code: 0,
              stdout: new TextEncoder().encode("2468\n"),
              stderr: new Uint8Array(),
            });
          },
        };
      },
      false,
      { installedExecutablePath: "/opt/kato/kato-web" },
    );

    const pid = await launcher.launchDetached({
      hostname: "127.0.0.1",
      port: 5173,
    });

    assertEquals(pid, 2468);
    assertEquals(capturedCommand, "sh");
    assertStringIncludes(
      capturedOptions?.args?.[1] ?? "",
      "setsid '/opt/kato/kato-web' '--host' '127.0.0.1' '--port' '5173'",
    );
    assertStringIncludes(
      capturedOptions?.args?.[1] ?? "",
      "nohup '/opt/kato/kato-web' '--host' '127.0.0.1' '--port' '5173'",
    );
    assertStringIncludes(
      capturedOptions?.args?.[1] ?? "",
      "cd '/opt/kato'",
    );
  },
);

Deno.test(
  "WebServerStatusFileStore falls back on missing and invalid status files",
  async () => {
    await withTestTempDir("web-status-store-", async (rootDir) => {
      const statusPath = join(rootDir, "kato-web-status.json");
      const now = () => new Date("2026-03-11T10:00:00.000Z");
      const store = new WebServerStatusFileStore(statusPath, now);

      assertEquals(await store.load(), createDefaultWebServerStatus(now()));

      await Deno.writeTextFile(statusPath, "{bad json");
      assertEquals(await store.load(), createDefaultWebServerStatus(now()));

      await Deno.writeTextFile(
        statusPath,
        JSON.stringify({ schemaVersion: 99, running: true }),
      );
      assertEquals(await store.load(), createDefaultWebServerStatus(now()));
    });
  },
);

Deno.test("WebServerStatusFileStore saves status and isProcessAlive handles live and invalid pids", async () => {
  await withTestTempDir("web-status-roundtrip-", async (rootDir) => {
    const statusPath = join(rootDir, "kato-web-status.json");
    const store = new WebServerStatusFileStore(statusPath);
    const status = {
      schemaVersion: 1 as const,
      running: true,
      hostname: "127.0.0.1",
      port: 3173,
      pid: Deno.pid,
      startedAt: "2026-03-11T10:00:00.000Z",
      heartbeatAt: "2026-03-11T10:00:05.000Z",
      url: "http://127.0.0.1:3173/",
      version: "0.2.2",
    };

    await store.save(status);
    assertEquals(await store.load(), status);
    const canProbeCurrentProcess = Deno.build.os === "windows"
      ? (await Deno.permissions.query({
        name: "run",
        command: "powershell.exe",
      })).state === "granted"
      : (await Deno.permissions.query({ name: "run" })).state === "granted";
    assertEquals(isProcessAlive(Deno.pid), canProbeCurrentProcess);
    assertEquals(isProcessAlive(undefined), false);
    assertEquals(isProcessAlive(0), false);
    assertEquals(isProcessAlive(-1), false);
  });
});

Deno.test("isProcessAlive treats permission denied as alive and rethrows unexpected probe failures", () => {
  if (Deno.build.os === "windows") {
    return;
  }

  const originalKill = Deno.kill;
  try {
    Deno.kill = ((_: number, __?: Deno.Signal) => {
      throw new Deno.errors.PermissionDenied("probe blocked");
    }) as typeof Deno.kill;
    assertEquals(isProcessAlive(1234), true);

    Deno.kill = ((_: number, __?: Deno.Signal) => {
      throw new Deno.errors.NotFound("missing");
    }) as typeof Deno.kill;
    assertEquals(isProcessAlive(1234), false);

    Deno.kill = ((_: number, __?: Deno.Signal) => {
      throw new Error("unexpected probe failure");
    }) as typeof Deno.kill;
    assertThrows(
      () => isProcessAlive(1234),
      Error,
      "unexpected probe failure",
    );
  } finally {
    Deno.kill = originalKill;
  }
});
