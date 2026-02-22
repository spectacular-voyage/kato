import type { DaemonCliCommandContext } from "./context.ts";

export async function runExportCommand(
  ctx: DaemonCliCommandContext,
  sessionId: string,
  outputPath?: string,
): Promise<void> {
  const request = await ctx.controlStore.enqueue({
    command: "export",
    payload: {
      sessionId,
      ...(outputPath ? { outputPath } : {}),
      requestedByPid: ctx.runtime.pid,
    },
  });

  await ctx.operationalLogger.info(
    "export.requested",
    "One-off export enqueued from CLI",
    {
      requestId: request.requestId,
      sessionId,
      outputPath,
      controlPath: ctx.runtime.controlPath,
    },
  );
  await ctx.auditLogger.command("export", {
    requestId: request.requestId,
    sessionId,
    outputPath,
  });

  ctx.runtime.writeStdout(
    `export request queued: session=${sessionId}${
      outputPath ? ` output=${outputPath}` : ""
    } requestId=${request.requestId}\n`,
  );
}
