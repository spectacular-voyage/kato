import { dirname, join } from "@std/path";
import type { AuditLogger } from "../observability/audit_logger.ts";
import type { StructuredLogger } from "../observability/logger.ts";
import { resolveDefaultRuntimeDir } from "../orchestrator/control_plane.ts";
import {
  PersistentSessionStateStore,
  resolveDefaultDaemonControlIndexPath,
  resolveDefaultSessionsDir,
} from "../orchestrator/session_state_store.ts";
import { resolveExportsLogPath } from "../utils/exports_log.ts";

type PathMutationResult = "missing" | "flushed" | "would-flush";

interface SessionFileCandidate {
  path: string;
  mtimeMs: number;
}

interface SessionCleanupCandidate {
  key: string;
  files: SessionFileCandidate[];
  newestMtimeMs: number;
}

export interface MaintenanceCleanStats {
  logFilesFlushed: number;
  logFilesWouldFlush: number;
  missingFiles: number;
  deletionFailures: number;
  sessionFilesDeleted: number;
  sessionFilesWouldDelete: number;
  sessionsDeleted: number;
  sessionsWouldDelete: number;
  sessionsMatched: number;
  skippedScopes: string[];
}

export interface MaintenanceCleanOptions {
  all: boolean;
  dryRun: boolean;
  recordingsDays?: number;
  sessionsDays?: number;
  runtimeDir?: string;
  katoDir?: string;
  now?: () => Date;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
  source?: "cli" | "web";
}

export interface MaintenanceCleanResult {
  mode: "dry-run" | "execute";
  stats: MaintenanceCleanStats;
  summary: string;
}

function parseSessionStorageKey(fileName: string): {
  key: string;
  kind: "meta" | "twin";
} | undefined {
  if (fileName.endsWith(".meta.json")) {
    return { key: fileName.slice(0, -".meta.json".length), kind: "meta" };
  }
  if (fileName.endsWith(".twin.jsonl")) {
    return { key: fileName.slice(0, -".twin.jsonl".length), kind: "twin" };
  }
  return undefined;
}

async function listSessionCleanupCandidates(
  sessionsDir: string,
): Promise<SessionCleanupCandidate[]> {
  const byKey = new Map<string, SessionCleanupCandidate>();
  try {
    for await (const entry of Deno.readDir(sessionsDir)) {
      if (!entry.isFile) {
        continue;
      }

      const parsed = parseSessionStorageKey(entry.name);
      if (!parsed) {
        continue;
      }

      const path = join(sessionsDir, entry.name);
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          continue;
        }
        throw error;
      }
      if (!stat.mtime) {
        continue;
      }
      const mtimeMs = stat.mtime.getTime();
      const existing = byKey.get(parsed.key);
      if (!existing) {
        byKey.set(parsed.key, {
          key: parsed.key,
          files: [{ path, mtimeMs }],
          newestMtimeMs: mtimeMs,
        });
        continue;
      }
      existing.files.push({ path, mtimeMs });
      if (mtimeMs > existing.newestMtimeMs) {
        existing.newestMtimeMs = mtimeMs;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function shouldDeleteSessionCandidate(
  candidate: SessionCleanupCandidate,
  olderThanMs: number,
): boolean {
  return candidate.newestMtimeMs <= olderThanMs;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function flushFileIfExists(
  path: string,
  dryRun: boolean,
): Promise<PathMutationResult> {
  if (!(await pathExists(path))) {
    return "missing";
  }

  if (dryRun) {
    return "would-flush";
  }

  await Deno.writeTextFile(path, "");
  return "flushed";
}

function applyMutationResult(
  result: PathMutationResult,
  stats: MaintenanceCleanStats,
): void {
  if (result === "missing") {
    stats.missingFiles += 1;
    return;
  }
  if (result === "flushed") {
    stats.logFilesFlushed += 1;
    return;
  }
  stats.logFilesWouldFlush += 1;
}

function createEmptyStats(): MaintenanceCleanStats {
  return {
    logFilesFlushed: 0,
    logFilesWouldFlush: 0,
    missingFiles: 0,
    deletionFailures: 0,
    sessionFilesDeleted: 0,
    sessionFilesWouldDelete: 0,
    sessionsDeleted: 0,
    sessionsWouldDelete: 0,
    sessionsMatched: 0,
    skippedScopes: [],
  };
}

async function executeSessionCleanup(
  options: {
    dryRun: boolean;
    sessionsDays: number | undefined;
    now: () => Date;
    katoDir: string;
    operationalLogger?: StructuredLogger;
    source: "cli" | "web";
  },
  stats: MaintenanceCleanStats,
): Promise<void> {
  if (options.sessionsDays === undefined) {
    return;
  }

  const nowMs = options.now().getTime();
  const olderThanMs = nowMs - (options.sessionsDays * 24 * 60 * 60 * 1000);
  const sessionsDir = resolveDefaultSessionsDir(options.katoDir);
  const sessionStateStore = new PersistentSessionStateStore({
    daemonControlIndexPath: resolveDefaultDaemonControlIndexPath(
      options.katoDir,
    ),
    sessionsDir,
    now: options.now,
  });
  const candidates = await listSessionCleanupCandidates(sessionsDir);
  const matched = candidates.filter((candidate) =>
    shouldDeleteSessionCandidate(candidate, olderThanMs)
  );
  stats.sessionsMatched = matched.length;

  for (const candidate of matched) {
    if (options.dryRun) {
      stats.sessionsWouldDelete += 1;
      stats.sessionFilesWouldDelete += candidate.files.length;
      continue;
    }

    let sessionFailed = false;
    let deletedFiles = 0;
    let missingFiles = 0;
    let deletionFailures = 0;
    for (const file of candidate.files) {
      try {
        await Deno.remove(file.path);
        deletedFiles += 1;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          missingFiles += 1;
          continue;
        }
        sessionFailed = true;
        deletionFailures += 1;
      }
    }
    stats.missingFiles += missingFiles;
    if (sessionFailed) {
      stats.deletionFailures += deletionFailures;
      continue;
    }

    stats.sessionsDeleted += 1;
    stats.sessionFilesDeleted += deletedFiles;
  }

  if (!options.dryRun) {
    await sessionStateStore.rebuildDaemonControlIndex();
  }

  await options.operationalLogger?.info(
    "clean.sessions",
    "Session artifact cleanup completed",
    {
      source: options.source,
      dryRun: options.dryRun,
      sessionsDays: options.sessionsDays,
      sessionsMatched: matched.length,
      sessionsDeleted: stats.sessionsDeleted,
      sessionsWouldDelete: stats.sessionsWouldDelete,
      sessionFilesDeleted: stats.sessionFilesDeleted,
      sessionFilesWouldDelete: stats.sessionFilesWouldDelete,
    },
  );
}

function buildSummary(
  options: Pick<
    MaintenanceCleanOptions,
    "all" | "dryRun" | "recordingsDays" | "sessionsDays"
  >,
  stats: MaintenanceCleanStats,
): string {
  const mode = options.dryRun ? "dry-run" : "execute";
  const parts: string[] = [`clean completed mode=${mode}`];
  if (options.all) {
    parts.push("all=true");
  }
  if (options.recordingsDays !== undefined) {
    parts.push(`recordings=${options.recordingsDays}d`);
  }
  if (options.sessionsDays !== undefined) {
    parts.push(`sessions=${options.sessionsDays}d`);
  }
  if (options.dryRun) {
    parts.push(`logsToFlush=${stats.logFilesWouldFlush}`);
  } else {
    parts.push(`logsFlushed=${stats.logFilesFlushed}`);
  }
  if (options.sessionsDays !== undefined) {
    if (options.dryRun) {
      parts.push(`sessionsToDelete=${stats.sessionsWouldDelete}`);
      parts.push(`sessionFilesToDelete=${stats.sessionFilesWouldDelete}`);
    } else {
      parts.push(`sessionsDeleted=${stats.sessionsDeleted}`);
      parts.push(`sessionFilesDeleted=${stats.sessionFilesDeleted}`);
    }
  }
  parts.push(`missingFiles=${stats.missingFiles}`);
  parts.push(`deletionFailures=${stats.deletionFailures}`);
  if (stats.skippedScopes.length > 0) {
    parts.push(`scopesNotImplemented=${stats.skippedScopes.join(",")}`);
  }
  return parts.join(" ");
}

async function recordAuditEvent(
  auditLogger: AuditLogger | undefined,
  options: Pick<
    MaintenanceCleanOptions,
    "all" | "dryRun" | "recordingsDays" | "sessionsDays" | "source"
  >,
  stats: MaintenanceCleanStats,
): Promise<void> {
  if (!auditLogger) {
    return;
  }

  const attributes = {
    all: options.all,
    dryRun: options.dryRun,
    recordingsDays: options.recordingsDays,
    sessionsDays: options.sessionsDays,
    logFilesFlushed: stats.logFilesFlushed,
    logFilesWouldFlush: stats.logFilesWouldFlush,
    sessionFilesDeleted: stats.sessionFilesDeleted,
    sessionFilesWouldDelete: stats.sessionFilesWouldDelete,
    sessionsDeleted: stats.sessionsDeleted,
    sessionsWouldDelete: stats.sessionsWouldDelete,
    missingFiles: stats.missingFiles,
    deletionFailures: stats.deletionFailures,
    skippedScopes: [...stats.skippedScopes],
  };

  if (options.source === "web") {
    await auditLogger.record(
      "web.maintenance.clean",
      "Web maintenance clean handled",
      attributes,
    );
    return;
  }

  await auditLogger.command("clean", attributes);
}

export async function runMaintenanceClean(
  options: MaintenanceCleanOptions,
): Promise<MaintenanceCleanResult> {
  const now = options.now ?? (() => new Date());
  const runtimeDir = options.runtimeDir ?? resolveDefaultRuntimeDir();
  const katoDir = options.katoDir ?? dirname(runtimeDir);
  const source = options.source ?? "cli";

  if (
    !options.all &&
    options.recordingsDays === undefined &&
    options.sessionsDays === undefined
  ) {
    throw new Error("At least one cleanup scope is required");
  }

  const stats = createEmptyStats();

  if (options.all) {
    for (
      const path of [
        join(runtimeDir, "logs", "operational.jsonl"),
        join(runtimeDir, "logs", "security-audit.jsonl"),
        join(katoDir, "web", "logs", "operational.jsonl"),
        join(katoDir, "web", "logs", "security-audit.jsonl"),
        resolveExportsLogPath(runtimeDir),
      ]
    ) {
      applyMutationResult(
        await flushFileIfExists(path, options.dryRun),
        stats,
      );
    }
  }

  await executeSessionCleanup({
    dryRun: options.dryRun,
    sessionsDays: options.sessionsDays,
    now,
    katoDir,
    operationalLogger: options.operationalLogger,
    source,
  }, stats);

  if (options.recordingsDays !== undefined) {
    stats.skippedScopes.push("recordings");
  }

  if (stats.skippedScopes.length > 0) {
    await options.operationalLogger?.warn(
      "clean.scope_unimplemented",
      "Clean scope accepted but not yet implemented",
      {
        source,
        scopes: [...stats.skippedScopes],
      },
    );
  }

  await options.operationalLogger?.info(
    "clean.completed",
    "Clean command handled",
    {
      source,
      all: options.all,
      dryRun: options.dryRun,
      recordingsDays: options.recordingsDays,
      sessionsDays: options.sessionsDays,
      logFilesFlushed: stats.logFilesFlushed,
      logFilesWouldFlush: stats.logFilesWouldFlush,
      sessionFilesDeleted: stats.sessionFilesDeleted,
      sessionFilesWouldDelete: stats.sessionFilesWouldDelete,
      sessionsDeleted: stats.sessionsDeleted,
      sessionsWouldDelete: stats.sessionsWouldDelete,
      missingFiles: stats.missingFiles,
      deletionFailures: stats.deletionFailures,
      skippedScopes: [...stats.skippedScopes],
    },
  );

  await recordAuditEvent(options.auditLogger, {
    all: options.all,
    dryRun: options.dryRun,
    recordingsDays: options.recordingsDays,
    sessionsDays: options.sessionsDays,
    source,
  }, stats);

  return {
    mode: options.dryRun ? "dry-run" : "execute",
    stats,
    summary: buildSummary(options, stats),
  };
}
