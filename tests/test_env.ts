import { join } from "@std/path";

export const RUNTIME_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "KATO_RUNTIME_DIR",
] as const;
export type RuntimeEnvKey = (typeof RUNTIME_ENV_KEYS)[number];

const TEST_ENV_LOCK_DIR = join(Deno.cwd(), ".test-tmp", ".env-lock");
const MAX_LOCK_WAIT_MS = 30_000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireTestEnvLock(): Promise<void> {
  await Deno.mkdir(join(Deno.cwd(), ".test-tmp"), { recursive: true });
  const startTimeMs = Date.now();
  while (true) {
    try {
      await Deno.mkdir(TEST_ENV_LOCK_DIR);
      return;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        if (Date.now() - startTimeMs > MAX_LOCK_WAIT_MS) {
          throw new Error(
            `Timed out acquiring test env lock at ${TEST_ENV_LOCK_DIR}; it may be stale`,
          );
        }
        await sleep(10);
        continue;
      }
      throw error;
    }
  }
}

async function releaseTestEnvLock(): Promise<void> {
  try {
    await Deno.remove(TEST_ENV_LOCK_DIR);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}

export async function withLockedEnvironment<T>(
  run: () => Promise<T> | T,
): Promise<T> {
  await acquireTestEnvLock();
  try {
    return await run();
  } finally {
    await releaseTestEnvLock();
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
