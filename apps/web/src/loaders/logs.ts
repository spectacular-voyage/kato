import type { LogLevel, LogRecord } from "@kato/runtime";
import { resolveDefaultKatoDir, resolveDefaultStatusPath } from "@kato/runtime";
import { join } from "@std/path";

const DEFAULT_LOG_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_LOG_PAGE_LIMIT = 200;
export const DEFAULT_LOG_LEVEL_FILTER: LogLevelFilter = "warn";

export type LogScope = "daemon" | "web";
export type LogChannel = LogRecord["channel"];
export type LogChannelFilter = LogChannel | "all";
export type LogScopeFilter = LogScope | "all";
export type LogLevelFilter = LogLevel | "all";

export interface LogEntry extends LogRecord {
  scope: LogScope;
}

export interface LoadLogEntriesOptions {
  channel?: LogChannelFilter;
  scope?: LogScopeFilter;
  level?: LogLevelFilter;
  levels?: LogLevel[];
  eventFilter?: string;
  textFilter?: string;
  limit?: number;
  tailBytes?: number;
  statusPath?: string;
  katoDir?: string;
}

export interface LogPageData {
  channel: LogChannelFilter;
  scope: LogScopeFilter;
  level: LogLevelFilter;
  eventFilter?: string;
  textFilter?: string;
  limit: number;
  matchedCount: number;
  rows: LogEntry[];
}

function normalizeFilter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function matchesLevel(
  entry: LogEntry,
  level: LogLevelFilter,
  levels: LogLevel[] | undefined,
): boolean {
  if (levels && levels.length > 0) {
    return levels.includes(entry.level);
  }
  if (!level || level === "all") {
    return true;
  }
  return levelPriority(entry.level) >= levelPriority(level);
}

function levelPriority(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 0;
    case "info":
      return 1;
    case "warn":
      return 2;
    case "error":
      return 3;
  }
}

function matchesEvent(
  entry: LogEntry,
  eventFilter: string | undefined,
): boolean {
  if (!eventFilter) {
    return true;
  }
  return entry.event.toLowerCase().includes(eventFilter.toLowerCase());
}

function matchesText(
  entry: LogEntry,
  textFilter: string | undefined,
): boolean {
  if (!textFilter) {
    return true;
  }
  const needle = textFilter.toLowerCase();
  const haystacks = [
    entry.event,
    entry.message,
    entry.attributes ? JSON.stringify(entry.attributes) : "",
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

function resolveLogPaths(
  channel: LogChannelFilter,
  scope: LogScopeFilter,
  statusPath: string,
  katoDir: string,
): Array<{ path: string; scope: LogScope }> {
  const runtimeDir = resolveRuntimeDirFromStatusPath(statusPath);
  const paths: Array<{ path: string; scope: LogScope }> = [];

  function maybePush(nextScope: LogScope, nextChannel: LogChannel) {
    if (channel !== "all" && channel !== nextChannel) {
      return;
    }
    if (scope !== "all" && scope !== nextScope) {
      return;
    }
    const basePath = nextScope === "daemon"
      ? join(runtimeDir, "logs", `${nextChannel}.jsonl`)
      : join(katoDir, "web", "logs", `${nextChannel}.jsonl`);
    paths.push({ path: basePath, scope: nextScope });
  }

  maybePush("daemon", "operational");
  maybePush("daemon", "security-audit");
  maybePush("web", "operational");
  maybePush("web", "security-audit");

  return paths;
}

export function resolveRuntimeDirFromStatusPath(statusPath: string): string {
  const normalized = statusPath.replaceAll("\\", "/");
  if (normalized.endsWith("/shared/status.json")) {
    return `${normalized.slice(0, -"/shared/status.json".length)}/daemon`;
  }
  return normalized;
}

async function collectFilteredLogEntries(
  options: LoadLogEntriesOptions,
): Promise<LogEntry[]> {
  const statusPath = options.statusPath ?? resolveDefaultStatusPath();
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const channel = options.channel ?? "all";
  const scope = options.scope ?? "all";
  const level = options.level ?? "all";
  const eventFilter = normalizeFilter(options.eventFilter);
  const textFilter = normalizeFilter(options.textFilter);
  const tailBytes = options.tailBytes ?? DEFAULT_LOG_TAIL_BYTES;
  const paths = resolveLogPaths(channel, scope, statusPath, katoDir);

  const tails = await Promise.all(
    paths.map(async ({ path, scope }) => ({
      scope,
      tail: await readTailText(path, tailBytes),
    })),
  );

  const rows: LogEntry[] = [];
  for (const entry of tails) {
    if (!entry.tail) {
      continue;
    }
    const lines = entry.tail.split(/\r\n?|\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) {
        continue;
      }
      const parsed = parseLogEntry(line, entry.scope);
      if (!parsed) {
        continue;
      }
      rows.push(parsed);
    }
  }

  return rows.filter((entry) =>
    matchesLevel(entry, level, options.levels) &&
    matchesEvent(entry, eventFilter) &&
    matchesText(entry, textFilter)
  ).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function parseLogEntry(
  line: string,
  scope: LogScope,
): LogEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const level = parsed["level"];
    const channel = parsed["channel"];
    const timestamp = parsed["timestamp"];
    if (
      (level !== "debug" && level !== "info" && level !== "warn" &&
        level !== "error") ||
      (channel !== "operational" && channel !== "security-audit") ||
      typeof timestamp !== "string"
    ) {
      return undefined;
    }
    return {
      timestamp,
      level,
      channel,
      scope,
      event: typeof parsed["event"] === "string" ? parsed["event"] : "unknown",
      message: typeof parsed["message"] === "string"
        ? parsed["message"].replace(/\s+/g, " ").trim()
        : "no message",
      attributes: typeof parsed["attributes"] === "object" &&
          parsed["attributes"] !== null &&
          !Array.isArray(parsed["attributes"])
        ? parsed["attributes"] as Record<string, unknown>
        : undefined,
    };
  } catch {
    return undefined;
  }
}

async function readTailText(
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(filePath, { read: true });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }
    throw error;
  }

  try {
    const stat = await file.stat();
    if (stat.size <= 0) {
      return "";
    }
    const start = Math.max(0, stat.size - maxBytes);
    await file.seek(start, Deno.SeekMode.Start);

    const bytes = new Uint8Array(Number(stat.size - start));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset));
      if (read === null) {
        break;
      }
      offset += read;
    }
    let text = new TextDecoder().decode(bytes.subarray(0, offset));
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    return text;
  } finally {
    file.close();
  }
}

export async function loadLogEntries(
  options: LoadLogEntriesOptions = {},
): Promise<LogEntry[]> {
  const limit = options.limit ?? DEFAULT_LOG_PAGE_LIMIT;
  const rows = await collectFilteredLogEntries(options);
  return rows.slice(0, limit);
}

export async function loadLogPageData(
  options: {
    channel?: LogChannelFilter;
    scope?: LogScopeFilter;
    level?: LogLevelFilter;
    eventFilter?: string;
    textFilter?: string;
    limit?: number;
    statusPath?: string;
    katoDir?: string;
  },
): Promise<LogPageData> {
  const channel = options.channel ?? "all";
  const scope = options.scope ?? "all";
  const level = options.level ?? DEFAULT_LOG_LEVEL_FILTER;
  const eventFilter = normalizeFilter(options.eventFilter);
  const textFilter = normalizeFilter(options.textFilter);
  const limit = options.limit ?? DEFAULT_LOG_PAGE_LIMIT;
  const filtered = await collectFilteredLogEntries({
    channel,
    scope,
    level,
    eventFilter,
    textFilter,
    statusPath: options.statusPath,
    katoDir: options.katoDir,
  });

  return {
    channel,
    scope,
    level,
    eventFilter,
    textFilter,
    limit,
    matchedCount: filtered.length,
    rows: filtered.slice(0, limit),
  };
}
