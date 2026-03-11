import { dirname } from "@std/path";
import { runMaintenanceClean } from "@kato/runtime";
import type { DaemonCliCommandContext } from "./context.ts";

export interface CleanCommandOptions {
  all: boolean;
  dryRun: boolean;
  recordingsDays?: number;
  sessionsDays?: number;
}

export async function runCleanCommand(
  ctx: DaemonCliCommandContext,
  options: CleanCommandOptions,
): Promise<void> {
  const result = await runMaintenanceClean({
    all: options.all,
    dryRun: options.dryRun,
    recordingsDays: options.recordingsDays,
    sessionsDays: options.sessionsDays,
    runtimeDir: ctx.runtime.runtimeDir,
    katoDir: ctx.runtimeConfig.katoDir ?? dirname(ctx.runtime.runtimeDir),
    now: ctx.runtime.now,
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
    source: "cli",
  });

  ctx.runtime.writeStdout(`${result.summary}\n`);
}
