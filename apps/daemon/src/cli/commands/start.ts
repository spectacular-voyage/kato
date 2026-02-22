import type { DaemonCliCommandContext } from "./context.ts";

export async function runStartCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const state = await ctx.stateStore.load();
  if (state.daemonRunning) {
    ctx.runtime.writeStdout(
      `kato daemon is already marked as running (pid: ${
        state.daemonPid ?? "unknown"
      }).\n`,
    );
    return;
  }

  const nowIso = ctx.runtime.now().toISOString();
  await ctx.stateStore.save({
    daemonRunning: true,
    daemonPid: ctx.runtime.pid,
    startedAt: state.startedAt ?? nowIso,
    updatedAt: nowIso,
  });

  await ctx.operationalLogger.info(
    "daemon.start",
    "Daemon start requested from CLI",
    {
      pid: ctx.runtime.pid,
      statePath: ctx.runtime.statePath,
    },
  );
  await ctx.auditLogger.command("start");

  ctx.runtime.writeStdout("kato daemon marked as running (scaffold mode).\n");
}
