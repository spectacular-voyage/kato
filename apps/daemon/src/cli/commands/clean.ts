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
  const request = await ctx.controlStore.enqueue({
    command: "clean",
    payload: {
      all: options.all,
      dryRun: options.dryRun,
      ...(options.recordingsDays !== undefined
        ? { recordingsDays: options.recordingsDays }
        : {}),
      ...(options.sessionsDays !== undefined
        ? { sessionsDays: options.sessionsDays }
        : {}),
      requestedByPid: ctx.runtime.pid,
    },
  });

  await ctx.operationalLogger.info(
    "clean.requested",
    "Cleanup enqueued from CLI",
    {
      requestId: request.requestId,
      all: options.all,
      dryRun: options.dryRun,
      recordingsDays: options.recordingsDays,
      sessionsDays: options.sessionsDays,
      controlPath: ctx.runtime.controlPath,
    },
  );
  await ctx.auditLogger.command("clean", {
    requestId: request.requestId,
    all: options.all,
    dryRun: options.dryRun,
    recordingsDays: options.recordingsDays,
    sessionsDays: options.sessionsDays,
  });

  const mode = options.dryRun ? "dry-run" : "execute";
  const parts: string[] = [`clean request queued mode=${mode}`];
  if (options.all) {
    parts.push("all=true");
  }
  if (options.recordingsDays !== undefined) {
    parts.push(`recordings=${options.recordingsDays}d`);
  }
  if (options.sessionsDays !== undefined) {
    parts.push(`sessions=${options.sessionsDays}d`);
  }
  parts.push(`requestId=${request.requestId}`);

  ctx.runtime.writeStdout(`${parts.join(" ")}\n`);
}
