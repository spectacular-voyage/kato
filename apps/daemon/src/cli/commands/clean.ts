import { dirname, join } from "@std/path";
import {
  isStatusSnapshotStale,
  PersistentSessionStateStore,
  resolveDefaultDaemonControlIndexPath,
  resolveDefaultSessionsDir,
} from "../../orchestrator/mod.ts";
import type { DaemonCliCommandContext } from "./context.ts";

export interface CleanCommandOptions {
  all: boolean;
  dryRun: boolean;
  recordingsDays?: number;
  sessionsDays?: number;
}

type PathMutationResult = "missing" | "flushed" | "would-flush";

interface CleanExecutionStats {
  logFilesFlushed: number;
  logFilesWouldFlush: number;
  missingFiles: number;
  deletionFailures: number;
  sessionFilesDeleted: number;
  sessionFilesWouldDelete: number;
  sessionsDeleted: number;
  sessionsWouldDelete: number;
  skippedScopes: string[];
}

interface SessionFileCandidate {
  path: string;
  mtimeMs: number;
}

interface SessionCleanupCandidate {
  key: string;
  files: SessionFileCandidate[];
  newestMtimeMs: number;
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
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(sessionsDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return [];
    }
    throw error;
  }

  for await (const entry of entries) {
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

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function shouldDeleteSessionCandidate(
  candidate: SessionCleanupCandidate,
  olderThanMs: number,
): boolean {
  return candidate.newestMtimeMs <= olderThanMs;
}

async function executeSessionCleanup(
  ctx: DaemonCliCommandContext,
  options: CleanCommandOptions,
  stats: CleanExecutionStats,
): Promise<void> {
  if (options.sessionsDays === undefined) {
    return;
  }

  const snapshot = await ctx.statusStore.load();
  const stale = isStatusSnapshotStale(snapshot, ctx.runtime.now());
  if (snapshot.daemonRunning && !stale) {
    throw new Error(
      "Refusing clean --sessions while daemon is running. Stop the daemon first.",
    );
  }

  const nowMs = ctx.runtime.now().getTime();
  const olderThanMs = nowMs - (options.sessionsDays * 24 * 60 * 60 * 1000);
  const katoDir = dirname(ctx.runtime.runtimeDir);
  const sessionsDir = resolveDefaultSessionsDir(katoDir);
  const sessionStateStore = new PersistentSessionStateStore({
    daemonControlIndexPath: resolveDefaultDaemonControlIndexPath(katoDir),
    sessionsDir,
    now: ctx.runtime.now,
  });
  const candidates = await listSessionCleanupCandidates(sessionsDir);
  const matched = candidates.filter((candidate) =>
    shouldDeleteSessionCandidate(candidate, olderThanMs)
  );

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

  await ctx.operationalLogger.info(
    "clean.sessions",
    "Session artifact cleanup completed",
    {
      dryRun: options.dryRun,
      sessionsDays: options.sessionsDays,
      daemonRunning: snapshot.daemonRunning,
      staleDaemonStatus: stale,
      sessionsMatched: matched.length,
      sessionsDeleted: stats.sessionsDeleted,
      sessionsWouldDelete: stats.sessionsWouldDelete,
      sessionFilesDeleted: stats.sessionFilesDeleted,
      sessionFilesWouldDelete: stats.sessionFilesWouldDelete,
    },
  );
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
  stats: CleanExecutionStats,
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

export async function runCleanCommand(
  ctx: DaemonCliCommandContext,
  options: CleanCommandOptions,
): Promise<void> {
  const stats: CleanExecutionStats = {
    logFilesFlushed: 0,
    logFilesWouldFlush: 0,
    missingFiles: 0,
    deletionFailures: 0,
    sessionFilesDeleted: 0,
    sessionFilesWouldDelete: 0,
    sessionsDeleted: 0,
    sessionsWouldDelete: 0,
    skippedScopes: [],
  };

  if (options.all) {
    for (
      const path of [
        join(ctx.runtime.runtimeDir, "logs", "operational.jsonl"),
        join(ctx.runtime.runtimeDir, "logs", "security-audit.jsonl"),
      ]
    ) {
      applyMutationResult(
        await flushFileIfExists(path, options.dryRun),
        stats,
      );
    }
  }

  await executeSessionCleanup(ctx, options, stats);

  if (options.recordingsDays !== undefined) {
    stats.skippedScopes.push("recordings");
  }

  if (stats.skippedScopes.length > 0) {
    await ctx.operationalLogger.warn(
      "clean.scope_unimplemented",
      "Clean scope accepted but not yet implemented in CLI",
      {
        scopes: [...stats.skippedScopes],
      },
    );
  }

  await ctx.operationalLogger.info(
    "clean.completed",
    "Clean command handled in CLI",
    {
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
  await ctx.auditLogger.command("clean", {
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
  });

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

  ctx.runtime.writeStdout(`${parts.join(" ")}\n`);
}
