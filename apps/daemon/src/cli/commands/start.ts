import type { DaemonCliCommandContext } from "./context.ts";

export async function runStartCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const request = await ctx.controlStore.enqueue({
    command: "start",
    payload: {
      requestedByPid: ctx.runtime.pid,
    },
  });

  await ctx.operationalLogger.info(
    "daemon.start",
    "Daemon start enqueued from CLI",
    {
      requestId: request.requestId,
      requestedByPid: ctx.runtime.pid,
      controlPath: ctx.runtime.controlPath,
    },
  );
  await ctx.auditLogger.command("start", {
    requestId: request.requestId,
  });

  ctx.runtime.writeStdout(
    `kato daemon start request queued (requestId: ${request.requestId}).\n`,
  );
}
