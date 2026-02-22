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
  await ctx.operationalLogger.info(
    "clean.requested",
    "Cleanup requested from CLI",
    {
      all: options.all,
      dryRun: options.dryRun,
      recordingsDays: options.recordingsDays,
      sessionsDays: options.sessionsDays,
    },
  );
  await ctx.auditLogger.command("clean", {
    all: options.all,
    dryRun: options.dryRun,
    recordingsDays: options.recordingsDays,
    sessionsDays: options.sessionsDays,
  });

  const mode = options.dryRun ? "dry-run" : "execute";
  const parts: string[] = [`clean mode=${mode}`];
  if (options.all) {
    parts.push("all=true");
  }
  if (options.recordingsDays !== undefined) {
    parts.push(`recordings=${options.recordingsDays}d`);
  }
  if (options.sessionsDays !== undefined) {
    parts.push(`sessions=${options.sessionsDays}d`);
  }

  ctx.runtime.writeStdout(`${parts.join(" ")} (scaffold mode)\n`);
}
