import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  restorePlatformPackageExecutableModes,
  restoreWrapperPackageExecutableModes,
} from "../scripts/npm-package-permissions.ts";

function uniquePath(label: string): string {
  return join(
    Deno.cwd(),
    ".test-tmp",
    "npm-package-permissions",
    `${label}-${crypto.randomUUID()}`,
  );
}

async function writeFileWithMode(path: string, mode: number): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, "echo kato\n");
  await Deno.chmod(path, mode).catch(() => {});
}

Deno.test("restoreWrapperPackageExecutableModes restores the wrapper launcher bit", async () => {
  if (Deno.build.os === "windows") {
    return;
  }

  const root = uniquePath("wrapper");
  const launcherPath = join(root, "bin", "kato.cjs");
  await writeFileWithMode(launcherPath, 0o644);

  await restoreWrapperPackageExecutableModes(root);

  const stat = await Deno.stat(launcherPath);
  assert(stat.isFile);
  if (stat.mode !== null) {
    assertEquals(stat.mode & 0o111, 0o111);
  }
});

Deno.test("restorePlatformPackageExecutableModes restores unix binary execute bits", async () => {
  if (Deno.build.os === "windows") {
    return;
  }

  const root = uniquePath("platform-unix");
  for (const fileName of ["kato", "kato-daemon", "kato-web"]) {
    await writeFileWithMode(join(root, "bin", fileName), 0o644);
  }

  await restorePlatformPackageExecutableModes(root, "linux-x86_64");

  for (const fileName of ["kato", "kato-daemon", "kato-web"]) {
    const stat = await Deno.stat(join(root, "bin", fileName));
    assert(stat.isFile);
    if (stat.mode !== null) {
      assertEquals(stat.mode & 0o111, 0o111);
    }
  }
});

Deno.test("restorePlatformPackageExecutableModes skips windows targets", async () => {
  if (Deno.build.os === "windows") {
    return;
  }

  const root = uniquePath("platform-windows");
  const binaryPath = join(root, "bin", "kato.exe");
  await writeFileWithMode(binaryPath, 0o644);

  await restorePlatformPackageExecutableModes(root, "windows-x86_64");

  const stat = await Deno.stat(binaryPath);
  assert(stat.isFile);
  if (stat.mode !== null) {
    assertEquals(stat.mode & 0o111, 0);
  }
});
