import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, resolve } from "@std/path";
import { DenoDetachedWebLauncher } from "../apps/runtime/src/mod.ts";

Deno.test("DenoDetachedWebLauncher launches via detached shell from the repo root", async () => {
  let capturedCommand: string | undefined;
  let capturedOptions:
    | ConstructorParameters<typeof Deno.Command>[1]
    | undefined;

  const launcher = new DenoDetachedWebLauncher(
    "/fake/deno",
    undefined,
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

  const expectedWorkspaceRoot = resolve(
    dirname(fromFileUrl(import.meta.url)),
    "..",
  );
  const expectedWebRoot = resolve(expectedWorkspaceRoot, "apps", "web");
  const expectedVitePath = Deno.realPathSync(
    resolve(expectedWebRoot, "node_modules", ".bin", "vite"),
  );

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
