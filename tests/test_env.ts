export const RUNTIME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "KATO_RUNTIME_DIR",
] as const;
export type RuntimeEnvKey = (typeof RUNTIME_ENV_KEYS)[number];

export function snapshotRuntimeEnv(): Record<
  RuntimeEnvKey,
  string | undefined
> {
  return {
    HOME: Deno.env.get("HOME"),
    USERPROFILE: Deno.env.get("USERPROFILE"),
    KATO_RUNTIME_DIR: Deno.env.get("KATO_RUNTIME_DIR"),
  };
}

export function setRuntimeEnv(
  values: Partial<Record<RuntimeEnvKey, string | undefined>>,
): void {
  for (const key of RUNTIME_ENV_KEYS) {
    if (!(key in values)) {
      continue;
    }
    const value = values[key];
    if (value === undefined) {
      Deno.env.delete(key);
      continue;
    }
    Deno.env.set(key, value);
  }
}

export function restoreRuntimeEnv(
  snapshot: Record<RuntimeEnvKey, string | undefined>,
): void {
  setRuntimeEnv(snapshot);
}
