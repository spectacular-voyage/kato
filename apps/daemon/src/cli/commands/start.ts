import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";

export async function runStartCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const existingSnapshot = await ctx.statusStore.load();
  const stale = isStatusSnapshotStale(existingSnapshot, ctx.runtime.now());
  if (existingSnapshot.daemonRunning && !stale) {
    ctx.runtime.writeStdout(
      `kato daemon is already running (pid: ${
        existingSnapshot.daemonPid ?? "unknown"
      }).\n`,
    );
    return;
  }

  const launchedPid = await ctx.daemonLauncher.launchDetached();
  const nowIso = ctx.runtime.now().toISOString();
  await ctx.statusStore.save({
    ...existingSnapshot,
    daemonRunning: true,
    daemonPid: launchedPid,
    generatedAt: nowIso,
    heartbeatAt: nowIso,
  });

  await ctx.operationalLogger.info(
    "daemon.start",
    "Daemon start launched from CLI",
    {
      launchedPid,
      requestedByPid: ctx.runtime.pid,
      staleBeforeLaunch: stale,
      statusPath: ctx.runtime.statusPath,
    },
  );
  await ctx.auditLogger.command("start", {
    launchedPid,
    staleBeforeLaunch: stale,
  });

  ctx.runtime.writeStdout(
    `kato daemon started in background (pid: ${launchedPid}).\n`,
  );
}
