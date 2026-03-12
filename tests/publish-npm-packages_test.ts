import { assertEquals } from "@std/assert";
import { publicationOrder } from "../scripts/publish-npm-packages.ts";

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
