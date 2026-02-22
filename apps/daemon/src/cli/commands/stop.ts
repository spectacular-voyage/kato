import type { DaemonCliCommandContext } from "./context.ts";

export async function runStopCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const request = await ctx.controlStore.enqueue({
    command: "stop",
    payload: {
      requestedByPid: ctx.runtime.pid,
    },
  });

  await ctx.operationalLogger.info(
    "daemon.stop",
    "Daemon stop enqueued from CLI",
    {
      requestId: request.requestId,
      requestedByPid: ctx.runtime.pid,
      controlPath: ctx.runtime.controlPath,
    },
  );
  await ctx.auditLogger.command("stop", {
    requestId: request.requestId,
  });

  ctx.runtime.writeStdout(
    `kato daemon stop request queued (requestId: ${request.requestId}).\n`,
  );
}
