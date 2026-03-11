import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DenoDetachedWebLauncher } from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

Deno.test(
  "DenoDetachedWebLauncher launches via detached shell from the repo root",
  async () => {
    let capturedCommand: string | undefined;
    let capturedOptions:
      | ConstructorParameters<typeof Deno.Command>[1]
      | undefined;

    await withTestTempDir("web-launcher-", async (workspaceRoot) => {
      const expectedWebRoot = join(workspaceRoot, "apps", "web");
      const expectedVitePath = join(
        expectedWebRoot,
        "node_modules",
        ".bin",
        "vite",
      );
      await Deno.mkdir(join(expectedWebRoot, "node_modules", ".bin"), {
        recursive: true,
      });
      await Deno.writeTextFile(expectedVitePath, "#!/bin/sh\n");

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
        `setsid '/fake/deno' 'run' '--ext=js' '-A' '${expectedVitePath}' '--host' '127.0.0.1' '--port' '5173'`,
      );
      assertStringIncludes(
        capturedOptions?.args?.[1] ?? "",
        `nohup '/fake/deno' 'run' '--ext=js' '-A' '${expectedVitePath}' '--host' '127.0.0.1' '--port' '5173'`,
      );
    });
  },
);
