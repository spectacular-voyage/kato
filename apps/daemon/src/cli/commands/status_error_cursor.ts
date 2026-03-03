import { dirname, join } from "@std/path";

const STATUS_ERROR_CURSOR_FILENAME = "status-error-cursor.json";
const STATUS_ERROR_CURSOR_SCHEMA_VERSION = 1;
const MAX_SUPPRESSED_RECENT_ERROR_KEYS = 256;

interface StatusErrorCursorDocument {
  schemaVersion: number;
  updatedAt: string;
  suppressedRecentErrorKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatusErrorCursorDocument(
  value: unknown,
): value is StatusErrorCursorDocument {
  if (!isRecord(value)) {
    return false;
  }
  if (value["schemaVersion"] !== STATUS_ERROR_CURSOR_SCHEMA_VERSION) {
    return false;
  }
  if (typeof value["updatedAt"] !== "string") {
    return false;
  }
  const keys = value["suppressedRecentErrorKeys"];
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) {
    return false;
  }
  return true;
}

function normalizeSuppressedRecentErrorKeys(
  values: Iterable<string>,
): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    normalized.add(trimmed);
    if (normalized.size >= MAX_SUPPRESSED_RECENT_ERROR_KEYS) {
      break;
    }
  }
  return [...normalized];
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  let cleanupError: unknown = undefined;
  try {
    await Deno.writeTextFile(tmpPath, JSON.stringify(value, null, 2), {
      createNew: true,
    });
    try {
      await Deno.rename(tmpPath, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw error;
      }
      try {
        await Deno.remove(path);
      } catch (removeError) {
        if (!(removeError instanceof Deno.errors.NotFound)) {
          throw removeError;
        }
      }
      await Deno.rename(tmpPath, path);
    }
  } finally {
    try {
      await Deno.remove(tmpPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        cleanupError = error;
      }
    }
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

export function resolveStatusErrorCursorPath(runtimeDir: string): string {
  return join(runtimeDir, STATUS_ERROR_CURSOR_FILENAME);
}

export async function loadSuppressedRecentErrorKeys(
  cursorPath: string,
): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(cursorPath);
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return new Set<string>();
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isStatusErrorCursorDocument(parsed)) {
      return new Set<string>();
    }
    return new Set(
      normalizeSuppressedRecentErrorKeys(parsed.suppressedRecentErrorKeys),
    );
  } catch {
    return new Set<string>();
  }
}

export async function saveSuppressedRecentErrorKeys(
  cursorPath: string,
  keys: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<void> {
  const document: StatusErrorCursorDocument = {
    schemaVersion: STATUS_ERROR_CURSOR_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    suppressedRecentErrorKeys: normalizeSuppressedRecentErrorKeys(keys),
  };
  await writeJsonAtomically(cursorPath, document);
}
