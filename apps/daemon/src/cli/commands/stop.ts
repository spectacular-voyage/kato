import type { DaemonCliCommandContext } from "./context.ts";

export async function runStopCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const state = await ctx.stateStore.load();
  if (!state.daemonRunning) {
    ctx.runtime.writeStdout(
      "kato daemon is not currently marked as running.\n",
    );
    return;
  }

  const nowIso = ctx.runtime.now().toISOString();
  await ctx.stateStore.save({
    daemonRunning: false,
    updatedAt: nowIso,
  });

  await ctx.operationalLogger.info(
    "daemon.stop",
    "Daemon stop requested from CLI",
    {
      previousPid: state.daemonPid,
      statePath: ctx.runtime.statePath,
    },
  );
  await ctx.auditLogger.command("stop");

  ctx.runtime.writeStdout("kato daemon marked as stopped.\n");
}
