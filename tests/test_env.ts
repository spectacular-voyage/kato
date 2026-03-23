export const RUNTIME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "KATO_RUNTIME_DIR",
] as const;
export type RuntimeEnvKey = (typeof RUNTIME_ENV_KEYS)[number];

const ISOLATED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "KATO_RUNTIME_DIR",
  "KATO_DAEMON_STATUS_PATH",
  "KATO_DAEMON_CONTROL_PATH",
  "KATO_CLAUDE_SESSION_ROOTS",
  "KATO_CODEX_SESSION_ROOTS",
  "KATO_GEMINI_SESSION_ROOTS",
  "KATO_DAEMON_MAX_MEMORY_MB",
  "KATO_CONFIG_PATH",
  "KATO_ALLOWED_WRITE_ROOT",
  "KATO_ALLOWED_WRITE_ROOTS_JSON",
  "KATO_WEB_PASSWORD",
  "KATO_LOGGING_OPERATIONAL_LEVEL",
  "KATO_LOGGING_AUDIT_LEVEL",
] as const;

type IsolatedEnvKey = (typeof ISOLATED_ENV_KEYS)[number];
type ProcessEnvSnapshot = Record<IsolatedEnvKey, string | undefined>;

function snapshotProcessEnv(): ProcessEnvSnapshot {
  return Object.fromEntries(
    ISOLATED_ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  ) as ProcessEnvSnapshot;
}

function restoreProcessEnv(snapshot: ProcessEnvSnapshot): void {
  for (const key of ISOLATED_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
}

// The root test tasks now keep env-boundary suites in a dedicated serial slice,
// so this helper only restores process env after each callback instead of
// coordinating the whole suite through a filesystem lock.
export async function withIsolatedEnvironment<T>(
  run: () => Promise<T> | T,
): Promise<T> {
  const snapshot = snapshotProcessEnv();
  try {
    return await run();
  } finally {
    restoreProcessEnv(snapshot);
  }
}

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
