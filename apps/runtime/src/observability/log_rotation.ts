import { basename, dirname, extname, join } from "@std/path";

/** Default number of days rotated JSONL log files are kept. */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COLLISION_INDEX = 999;

export interface RotatedLogFile {
  path: string;
  /** UTC day (`YYYY-MM-DD`) of the rotated file's last write. */
  day: string;
}

/** Formats a date as its UTC calendar day, `YYYY-MM-DD`. */
export function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isValidLogRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function splitLogFileName(activePath: string): {
  dir: string;
  stem: string;
  ext: string;
} {
  const name = basename(activePath);
  const ext = extname(name);
  return {
    dir: dirname(activePath),
    stem: ext.length > 0 ? name.slice(0, -ext.length) : name,
    ext,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRealUtcDay(day: string): boolean {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && formatUtcDay(parsed) === day;
}

/**
 * Rotated sibling name for an active log file:
 * `security-audit.jsonl` → `security-audit.2026-11-07.jsonl`, or
 * `security-audit.2026-11-07.1.jsonl` when `collisionIndex > 0`.
 */
export function buildRotatedLogFilePath(
  activePath: string,
  day: string,
  collisionIndex: number = 0,
): string {
  const { dir, stem, ext } = splitLogFileName(activePath);
  const suffix = collisionIndex > 0 ? `.${collisionIndex}` : "";
  return join(dir, `${stem}.${day}${suffix}${ext}`);
}

/**
 * Returns the UTC day encoded in `entryName` when it is a rotated sibling of
 * `activePath`, otherwise `undefined`.
 */
export function parseRotatedLogDay(
  activePath: string,
  entryName: string,
): string | undefined {
  const { stem, ext } = splitLogFileName(activePath);
  const pattern = new RegExp(
    `^${escapeRegExp(stem)}\\.(\\d{4}-\\d{2}-\\d{2})(?:\\.\\d+)?${
      escapeRegExp(ext)
    }$`,
  );
  const match = pattern.exec(entryName);
  if (!match) {
    return undefined;
  }
  const day = match[1]!;
  return isRealUtcDay(day) ? day : undefined;
}

export async function listRotatedLogFiles(
  activePath: string,
): Promise<RotatedLogFile[]> {
  const { dir } = splitLogFileName(activePath);
  const files: RotatedLogFile[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) {
        continue;
      }
      const day = parseRotatedLogDay(activePath, entry.name);
      if (day !== undefined) {
        files.push({ path: join(dir, entry.name), day });
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function pathIsFree(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return true;
    }
    throw error;
  }
}

/**
 * Renames the active log aside when its last write happened on a UTC day
 * earlier than `today`. The rotated name carries the last-write day, so a file
 * is only pruned once everything in it is older than the retention window.
 * Never overwrites an existing file. Returns the rotated path, if any.
 */
export async function rotateLogFileIfStale(
  activePath: string,
  today: string,
): Promise<string | undefined> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(activePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile || !info.mtime) {
    return undefined;
  }
  const fileDay = formatUtcDay(info.mtime);
  if (fileDay >= today) {
    return undefined;
  }

  for (let index = 0; index <= MAX_COLLISION_INDEX; index += 1) {
    const candidate = buildRotatedLogFilePath(activePath, fileDay, index);
    if (await pathIsFree(candidate)) {
      await Deno.rename(activePath, candidate);
      return candidate;
    }
  }
  return undefined;
}

/**
 * Deletes rotated siblings of `activePath` whose day is older than
 * `today - retentionDays`. The active file is never touched.
 * Returns the deleted paths.
 */
export async function pruneRotatedLogFiles(
  activePath: string,
  today: string,
  retentionDays: number,
): Promise<string[]> {
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  if (Number.isNaN(todayMs) || !isValidLogRetentionDays(retentionDays)) {
    return [];
  }
  const cutoffDay = formatUtcDay(new Date(todayMs - retentionDays * DAY_MS));
  const deleted: string[] = [];
  for (const file of await listRotatedLogFiles(activePath)) {
    if (file.day >= cutoffDay) {
      continue;
    }
    try {
      await Deno.remove(file.path);
      deleted.push(file.path);
    } catch {
      // Best-effort: a file that cannot be removed now (already gone, locked
      // on Windows, permissions) is retried on the next prune.
    }
  }
  return deleted;
}
