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

const SESSION_META_SUFFIX = ".meta.json";
const SESSION_TWIN_SUFFIX = ".twin.jsonl";

interface TwinCleanupCandidate {
  key: string;
  twinPath: string;
  metadataPath: string;
  twinMtimeMs: number;
}

export interface MaintenanceCleanStats {
  logFilesFlushed: number;
  logFilesWouldFlush: number;
  missingFiles: number;
  deletionFailures: number;
  twinFilesDeleted: number;
  twinFilesWouldDelete: number;
  metadataFilesDeleted: number;
  metadataFilesWouldDelete: number;
  twinsDeleted: number;
  twinsWouldDelete: number;
  twinsMatched: number;
  skippedScopes: string[];
}

export interface MaintenanceCleanOptions {
  all: boolean;
  dryRun: boolean;
  recordingsDays?: number;
  twinsDays?: number;
  deleteTwinMetadata?: boolean;
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

async function listTwinCleanupCandidates(
  sessionsDir: string,
): Promise<TwinCleanupCandidate[]> {
  const candidates: TwinCleanupCandidate[] = [];
  try {
    for await (const entry of Deno.readDir(sessionsDir)) {
      if (!entry.isFile || !entry.name.endsWith(SESSION_TWIN_SUFFIX)) {
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
      const key = entry.name.slice(0, -SESSION_TWIN_SUFFIX.length);
      candidates.push({
        key,
        twinPath: path,
        metadataPath: join(sessionsDir, `${key}${SESSION_META_SUFFIX}`),
        twinMtimeMs: stat.mtime.getTime(),
      });
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }

  return candidates.sort((a, b) => a.key.localeCompare(b.key));
}

function shouldDeleteTwinCandidate(
  candidate: TwinCleanupCandidate,
  olderThanMs: number,
): boolean {
  return candidate.twinMtimeMs <= olderThanMs;
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
    twinFilesDeleted: 0,
    twinFilesWouldDelete: 0,
    metadataFilesDeleted: 0,
    metadataFilesWouldDelete: 0,
    twinsDeleted: 0,
    twinsWouldDelete: 0,
    twinsMatched: 0,
    skippedScopes: [],
  };
}

async function executeTwinCleanup(
  options: {
    dryRun: boolean;
    twinsDays: number | undefined;
    deleteTwinMetadata?: boolean;
    now: () => Date;
    katoDir: string;
    operationalLogger?: StructuredLogger;
    source: "cli" | "web";
  },
  stats: MaintenanceCleanStats,
): Promise<void> {
  if (options.twinsDays === undefined) {
    return;
  }

  const nowMs = options.now().getTime();
  const olderThanMs = nowMs - (options.twinsDays * 24 * 60 * 60 * 1000);
  const sessionsDir = resolveDefaultSessionsDir(options.katoDir);
  const deleteTwinMetadata = options.deleteTwinMetadata === true;
  const candidates = await listTwinCleanupCandidates(sessionsDir);
  const matched = candidates.filter((candidate) =>
    shouldDeleteTwinCandidate(candidate, olderThanMs)
  );
  stats.twinsMatched = matched.length;
  const sessionStateStore = options.dryRun
    ? undefined
    : new PersistentSessionStateStore({
      daemonControlIndexPath: resolveDefaultDaemonControlIndexPath(
        options.katoDir,
      ),
      sessionsDir,
      now: options.now,
    });
  if (sessionStateStore && !deleteTwinMetadata) {
    await sessionStateStore.rebuildDaemonControlIndex();
  }
  const metadataByTwinPath = sessionStateStore && !deleteTwinMetadata
    ? new Map(
      (await sessionStateStore.listSessionMetadata()).map((metadata) => [
        metadata.twinPath,
        metadata,
      ]),
    )
    : undefined;

  for (const candidate of matched) {
    if (options.dryRun) {
      stats.twinsWouldDelete += 1;
      stats.twinFilesWouldDelete += 1;
      if (deleteTwinMetadata && await pathExists(candidate.metadataPath)) {
        stats.metadataFilesWouldDelete += 1;
      }
      continue;
    }

    try {
      if (deleteTwinMetadata) {
        try {
          await Deno.remove(candidate.twinPath);
          stats.twinFilesDeleted += 1;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            stats.missingFiles += 1;
          } else {
            throw error;
          }
        }
        try {
          await Deno.remove(candidate.metadataPath);
          stats.metadataFilesDeleted += 1;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            stats.missingFiles += 1;
          } else {
            throw error;
          }
        }
      } else {
        const metadata = metadataByTwinPath?.get(candidate.twinPath);
        if (metadata && sessionStateStore) {
          await sessionStateStore.resetSessionTwinPersistence(metadata, {
            deleteTwinFile: true,
          });
        } else {
          await Deno.remove(candidate.twinPath);
        }
        stats.twinFilesDeleted += 1;
      }
      stats.twinsDeleted += 1;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        stats.missingFiles += 1;
        continue;
      }
      stats.deletionFailures += 1;
    }
  }

  if (sessionStateStore && deleteTwinMetadata) {
    await sessionStateStore.rebuildDaemonControlIndex();
  }

  await options.operationalLogger?.info(
    "clean.twins",
    "Twin cleanup completed",
    {
      source: options.source,
      dryRun: options.dryRun,
      twinsDays: options.twinsDays,
      deleteTwinMetadata,
      twinsMatched: matched.length,
      twinsDeleted: stats.twinsDeleted,
      twinsWouldDelete: stats.twinsWouldDelete,
      twinFilesDeleted: stats.twinFilesDeleted,
      twinFilesWouldDelete: stats.twinFilesWouldDelete,
      metadataFilesDeleted: stats.metadataFilesDeleted,
      metadataFilesWouldDelete: stats.metadataFilesWouldDelete,
    },
  );
}

function buildSummary(
  options: Pick<
    MaintenanceCleanOptions,
    "all" | "dryRun" | "recordingsDays" | "twinsDays" | "deleteTwinMetadata"
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
  if (options.twinsDays !== undefined) {
    parts.push(`twins=${options.twinsDays}d`);
    if (options.deleteTwinMetadata) {
      parts.push("deleteMetadata=true");
    }
  }
  if (options.dryRun) {
    parts.push(`logsToFlush=${stats.logFilesWouldFlush}`);
  } else {
    parts.push(`logsFlushed=${stats.logFilesFlushed}`);
  }
  if (options.twinsDays !== undefined) {
    if (options.dryRun) {
      parts.push(`twinsToDelete=${stats.twinsWouldDelete}`);
      parts.push(`twinFilesToDelete=${stats.twinFilesWouldDelete}`);
      if (options.deleteTwinMetadata) {
        parts.push(`metadataFilesToDelete=${stats.metadataFilesWouldDelete}`);
      }
    } else {
      parts.push(`twinsDeleted=${stats.twinsDeleted}`);
      parts.push(`twinFilesDeleted=${stats.twinFilesDeleted}`);
      if (options.deleteTwinMetadata) {
        parts.push(`metadataFilesDeleted=${stats.metadataFilesDeleted}`);
      }
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
    | "all"
    | "dryRun"
    | "recordingsDays"
    | "twinsDays"
    | "deleteTwinMetadata"
    | "source"
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
    twinsDays: options.twinsDays,
    deleteTwinMetadata: options.deleteTwinMetadata,
    logFilesFlushed: stats.logFilesFlushed,
    logFilesWouldFlush: stats.logFilesWouldFlush,
    twinFilesDeleted: stats.twinFilesDeleted,
    twinFilesWouldDelete: stats.twinFilesWouldDelete,
    metadataFilesDeleted: stats.metadataFilesDeleted,
    metadataFilesWouldDelete: stats.metadataFilesWouldDelete,
    twinsDeleted: stats.twinsDeleted,
    twinsWouldDelete: stats.twinsWouldDelete,
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
    options.twinsDays === undefined
  ) {
    throw new Error("At least one cleanup scope is required");
  }
  if (options.recordingsDays !== undefined && options.recordingsDays < 0) {
    throw new Error("recordingsDays must be greater than or equal to 0");
  }
  if (options.twinsDays !== undefined && options.twinsDays < 0) {
    throw new Error("twinsDays must be greater than or equal to 0");
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

  await executeTwinCleanup({
    dryRun: options.dryRun,
    twinsDays: options.twinsDays,
    deleteTwinMetadata: options.deleteTwinMetadata,
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
      twinsDays: options.twinsDays,
      deleteTwinMetadata: options.deleteTwinMetadata,
      logFilesFlushed: stats.logFilesFlushed,
      logFilesWouldFlush: stats.logFilesWouldFlush,
      twinFilesDeleted: stats.twinFilesDeleted,
      twinFilesWouldDelete: stats.twinFilesWouldDelete,
      metadataFilesDeleted: stats.metadataFilesDeleted,
      metadataFilesWouldDelete: stats.metadataFilesWouldDelete,
      twinsDeleted: stats.twinsDeleted,
      twinsWouldDelete: stats.twinsWouldDelete,
      missingFiles: stats.missingFiles,
      deletionFailures: stats.deletionFailures,
      skippedScopes: [...stats.skippedScopes],
    },
  );

  await recordAuditEvent(options.auditLogger, {
    all: options.all,
    dryRun: options.dryRun,
    recordingsDays: options.recordingsDays,
    twinsDays: options.twinsDays,
    deleteTwinMetadata: options.deleteTwinMetadata,
    source,
  }, stats);

  return {
    mode: options.dryRun ? "dry-run" : "execute",
    stats,
    summary: buildSummary(options, stats),
  };
}
