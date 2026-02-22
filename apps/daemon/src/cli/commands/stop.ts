import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";

export async function runStopCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const snapshot = await ctx.statusStore.load();
  if (!snapshot.daemonRunning) {
    ctx.runtime.writeStdout(
      "kato daemon is not currently running.\n",
    );
    return;
  }

  const stale = isStatusSnapshotStale(snapshot, ctx.runtime.now());
  if (stale) {
    const { daemonPid: _ignoredDaemonPid, ...rest } = snapshot;
    const nowIso = ctx.runtime.now().toISOString();
    await ctx.statusStore.save({
      ...rest,
      daemonRunning: false,
      generatedAt: nowIso,
      heartbeatAt: nowIso,
    });

    await ctx.operationalLogger.warn(
      "daemon.stop.stale",
      "Daemon status was stale; marked daemon as stopped without enqueueing stop request",
      {
        previousPid: snapshot.daemonPid,
        statusPath: ctx.runtime.statusPath,
      },
    );
    await ctx.auditLogger.command("stop", {
      stale: true,
      previousPid: snapshot.daemonPid,
      requestEnqueued: false,
    });

    ctx.runtime.writeStdout(
      "kato daemon status was stale and has been reset to stopped.\n",
    );
    return;
  }

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
      previousPid: snapshot.daemonPid,
    },
  );
  await ctx.auditLogger.command("stop", {
    requestId: request.requestId,
    stale: false,
    previousPid: snapshot.daemonPid,
    requestEnqueued: true,
  });

  ctx.runtime.writeStdout(
    `kato daemon stop request queued (requestId: ${request.requestId}).\n`,
  );
}
