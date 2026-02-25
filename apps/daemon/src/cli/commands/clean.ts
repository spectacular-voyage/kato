import { join } from "@std/path";
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
  skippedScopes: string[];
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
  } else {
    if (options.recordingsDays !== undefined) {
      stats.skippedScopes.push("recordings");
    }
    if (options.sessionsDays !== undefined) {
      stats.skippedScopes.push("sessions");
    }
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
      missingFiles: stats.missingFiles,
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
    missingFiles: stats.missingFiles,
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
  parts.push(`missingFiles=${stats.missingFiles}`);
  if (stats.skippedScopes.length > 0) {
    parts.push(`scopesNotImplemented=${stats.skippedScopes.join(",")}`);
  }

  ctx.runtime.writeStdout(`${parts.join(" ")}\n`);
}
