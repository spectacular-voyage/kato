import { join } from "@std/path";

export function readOptionalEnv(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    if (value === undefined || value.length === 0) {
      return undefined;
    }
    return value;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      return undefined;
    }
    throw error;
  }
}

export function resolveHomeDir(): string | undefined {
  return readOptionalEnv("HOME") ?? readOptionalEnv("USERPROFILE");
}

export function expandHomePath(path: string): string {
  if (!path.startsWith("~")) {
    return path;
  }

  const home = resolveHomeDir();
  if (!home) {
    return path;
  }

  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }

  return path;
}
