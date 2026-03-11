import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultWebServerStatus,
  DenoDetachedWebLauncher,
  isProcessAlive,
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

Deno.test(
  "DenoDetachedWebLauncher launches via detached shell without requiring a vite binary path",
  async () => {
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
        "setsid '/fake/deno' 'run' '--ext=js' '-A' 'vite' '--host' '127.0.0.1' '--port' '5173'",
      );
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        "nohup '/fake/deno' 'run' '--ext=js' '-A' 'vite' '--host' '127.0.0.1' '--port' '5173'",
      );
    });
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
          args: string[],
          workingDirectory: string,
        ): Promise<number>;
      }
    ).launchDetachedViaPowerShell(
      ["run", "--ext=js", "-A", "vite", "--port", "3173"],
      "C:\\repo\\apps\\web",
    );

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
              args: string[],
              workingDirectory: string,
            ): Promise<number>;
          }
        ).launchDetachedViaPowerShell(["run"], "C:\\repo\\apps\\web"),
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
              args: string[],
              workingDirectory: string,
            ): Promise<number>;
          }
        ).launchDetachedViaPowerShell(["run"], "C:\\repo\\apps\\web"),
      Error,
      "did not return a valid PID",
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

Deno.test("WebServerStatusFileStore saves status and isProcessAlive handles obvious cases", async () => {
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
    assertEquals(isProcessAlive(undefined), false);
    assertEquals(isProcessAlive(0), false);
    assertEquals(isProcessAlive(-1), false);
  });
});
