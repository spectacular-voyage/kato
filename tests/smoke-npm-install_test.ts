import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  localProjectCommandPath,
  resolveSmokePackagePaths,
} from "../scripts/smoke-npm-install.ts";

function currentNodeArch(): string {
  switch (Deno.build.arch) {
    case "x86_64":
      return "x64";
    case "aarch64":
      return "arm64";
    default:
      return Deno.build.arch;
  }
}

function currentNodePlatform(): string {
  return Deno.build.os === "windows" ? "win32" : Deno.build.os;
}

Deno.test("resolveSmokePackagePaths falls back to downloaded artifact directories", async () => {
  const root = join(
    Deno.cwd(),
    ".test-tmp",
    "smoke-npm-install",
    crypto.randomUUID(),
  );
  await Deno.mkdir(join(root, "wrapper"), { recursive: true });
  await Deno.mkdir(join(root, "platforms", "linux-x64-gnu"), {
    recursive: true,
  });

  const resolved = await resolveSmokePackagePaths(
    {
      createdAt: "2026-03-12T00:00:00.000Z",
      version: "0.2.5",
      wrapperPackageName: "@spectacular-voyage/kato",
      platformPackagePrefix: "@spectacular-voyage/kato",
      commandName: "kato",
      wrapperDir: "/stale/source/wrapper",
      platformPackages: [
        {
          packageName: "@spectacular-voyage/kato-linux-x64-gnu",
          label: "linux-x64",
          target: "linux-x86_64",
          packageDir: "/stale/source/platforms/linux-x64-gnu",
          os: currentNodePlatform(),
          cpu: currentNodeArch(),
          ...(Deno.build.os === "linux" ? { libc: "glibc" } : {}),
          executablePath: "bin/kato",
        },
      ],
    },
    root,
    Deno.build.os === "linux" ? "glibc" : undefined,
  );

  assertEquals(resolved.wrapperDir, join(root, "wrapper"));
  assertEquals(
    resolved.platformPackage.packageDir,
    join(root, "platforms", "linux-x64-gnu"),
  );
});

Deno.test("localProjectCommandPath uses cmd shim on Windows", () => {
  assertEquals(
    localProjectCommandPath("/tmp/project", "kato", "windows"),
    join("/tmp/project", "node_modules", ".bin", "kato.cmd"),
  );
  assertEquals(
    localProjectCommandPath("/tmp/project", "kato", "linux"),
    join("/tmp/project", "node_modules", ".bin", "kato"),
  );
});
