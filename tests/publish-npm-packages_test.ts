import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  publicationOrder,
  resolvedPublicationOrder,
} from "../scripts/publish-npm-packages.ts";

Deno.test("publicationOrder publishes platform packages before the wrapper", () => {
  const ordered = publicationOrder({
    createdAt: "2026-03-12T00:00:00.000Z",
    version: "0.2.4",
    wrapperPackageName: "kato",
    platformPackagePrefix: "@spectacular-voyage/kato",
    commandName: "kato",
    wrapperDir: "/tmp/wrapper",
    platformPackages: [
      {
        packageName: "@spectacular-voyage/kato-win32-x64",
        label: "windows-x64",
        target: "windows-x86_64",
        packageDir: "/tmp/win32",
        os: "win32",
        cpu: "x64",
        executablePath: "bin/kato.exe",
      },
      {
        packageName: "@spectacular-voyage/kato-linux-x64-gnu",
        label: "linux-x64",
        target: "linux-x86_64",
        packageDir: "/tmp/linux",
        os: "linux",
        cpu: "x64",
        libc: "glibc",
        executablePath: "bin/kato",
      },
    ],
  });

  assertEquals(
    ordered.map((entry) => entry.packageName),
    [
      "@spectacular-voyage/kato-linux-x64-gnu",
      "@spectacular-voyage/kato-win32-x64",
      "kato",
    ],
  );
});

Deno.test("resolvedPublicationOrder falls back to downloaded npm package paths", async () => {
  const root = join(
    Deno.cwd(),
    ".test-tmp",
    "publish-npm-packages",
    crypto.randomUUID(),
  );
  await Deno.mkdir(join(root, "wrapper"), { recursive: true });
  await Deno.mkdir(join(root, "platforms", "darwin-arm64"), {
    recursive: true,
  });

  const resolved = await resolvedPublicationOrder(
    {
      createdAt: "2026-03-12T00:00:00.000Z",
      version: "0.2.4",
      wrapperPackageName: "kato",
      platformPackagePrefix: "@spectacular-voyage/kato",
      commandName: "kato",
      wrapperDir: "/stale/source/wrapper",
      platformPackages: [
        {
          packageName: "@spectacular-voyage/kato-darwin-arm64",
          label: "macos-arm64",
          target: "darwin-aarch64",
          packageDir: "/stale/source/platforms/darwin-arm64",
          os: "darwin",
          cpu: "arm64",
          executablePath: "bin/kato",
        },
      ],
    },
    root,
  );

  assertEquals(
    resolved.map((entry) => entry.packageDir),
    [join(root, "platforms", "darwin-arm64"), join(root, "wrapper")],
  );
});
