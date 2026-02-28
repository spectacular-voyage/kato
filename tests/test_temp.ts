import { join } from "@std/path";

const TEST_TEMP_ROOT = join(Deno.cwd(), ".test-tmp");

function ensureTestTempRoot(): void {
  Deno.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
}

async function pruneTestTempRootIfEmpty(): Promise<void> {
  try {
    for await (const _ of Deno.readDir(TEST_TEMP_ROOT)) {
      return;
    }
    await Deno.remove(TEST_TEMP_ROOT);
  } catch {
    // Best-effort cleanup for the shared test temp root; ignore races.
  }
}

export async function makeTestTempDir(prefix: string): Promise<string> {
  ensureTestTempRoot();
  return await Deno.makeTempDir({
    dir: TEST_TEMP_ROOT,
    prefix,
  });
}

export function makeTestTempPath(prefix: string): string {
  ensureTestTempRoot();
  return join(TEST_TEMP_ROOT, `${prefix}${crypto.randomUUID()}`);
}

export async function removePathIfPresent(
  path: string | undefined,
): Promise<void> {
  if (!path) {
    return;
  }
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  await pruneTestTempRootIfEmpty();
}

export async function withTestTempDir<T>(
  prefix: string,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await makeTestTempDir(prefix);
  try {
    return await run(dir);
  } finally {
    await removePathIfPresent(dir);
  }
}
