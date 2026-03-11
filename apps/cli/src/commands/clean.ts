import { dirname } from "@std/path";
import { runMaintenanceClean } from "@kato/runtime";
import type { DaemonCliCommandContext } from "./context.ts";

export interface CleanCommandOptions {
  all: boolean;
  dryRun: boolean;
  recordingsDays?: number;
  twinsDays?: number;
  deleteTwinMetadata?: boolean;
}

export async function runCleanCommand(
  ctx: DaemonCliCommandContext,
  options: CleanCommandOptions,
): Promise<void> {
  const result = await runMaintenanceClean({
    all: options.all,
    dryRun: options.dryRun,
    recordingsDays: options.recordingsDays,
    twinsDays: options.twinsDays,
    deleteTwinMetadata: options.deleteTwinMetadata,
    runtimeDir: ctx.runtime.runtimeDir,
    katoDir: ctx.runtimeConfig.katoDir ?? dirname(ctx.runtime.runtimeDir),
    now: ctx.runtime.now,
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
    source: "cli",
  });

  ctx.runtime.writeStdout(`${result.summary}\n`);
}
