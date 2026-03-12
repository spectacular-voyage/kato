import { basename, dirname, extname, join } from "@std/path";
import { expandHomePath, readOptionalEnv } from "./env.ts";

const DENO_EXECUTABLE_NAMES = new Set(["deno", "deno.exe"]);

export interface ResolveInstalledExecutablePathOptions {
  envVarName: string;
  siblingBaseName: string;
  launcherExecutablePath?: string;
  readEnv?: (name: string) => string | undefined;
}

export function resolveInstalledExecutablePath(
  options: ResolveInstalledExecutablePathOptions,
): string | undefined {
  const readEnv = options.readEnv ?? readOptionalEnv;
  const configuredPath = readEnv(options.envVarName)?.trim();
  if (configuredPath) {
    return expandHomePath(configuredPath);
  }

  if (!options.launcherExecutablePath) {
    return undefined;
  }

  const launcherName = basename(options.launcherExecutablePath).toLowerCase();
  if (DENO_EXECUTABLE_NAMES.has(launcherName)) {
    return undefined;
  }

  const launcherExtension = extname(options.launcherExecutablePath);
  const siblingName = launcherExtension.length > 0
    ? `${options.siblingBaseName}${launcherExtension}`
    : options.siblingBaseName;
  return join(dirname(options.launcherExecutablePath), siblingName);
}
