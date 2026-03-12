import { join } from "@std/path";

const UNIX_PLATFORM_BINARIES = ["kato", "kato-daemon", "kato-web"] as const;

async function setExecutableMode(path: string): Promise<void> {
  await Deno.chmod(path, 0o755).catch(() => {
    // chmod is best-effort and may be unsupported on some platforms.
  });
}

async function setExecutableModeIfFile(path: string): Promise<void> {
  const stat = await Deno.stat(path).catch((error) => {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  });
  if (stat?.isFile) {
    await setExecutableMode(path);
  }
}

export async function restoreWrapperPackageExecutableModes(
  wrapperDir: string,
): Promise<void> {
  await setExecutableModeIfFile(join(wrapperDir, "bin", "kato.cjs"));
}

export async function restorePlatformPackageExecutableModes(
  packageDir: string,
  target: string,
): Promise<void> {
  if (target.includes("windows")) {
    return;
  }
  await Promise.all(
    UNIX_PLATFORM_BINARIES.map((fileName) =>
      setExecutableModeIfFile(join(packageDir, "bin", fileName))
    ),
  );
}
