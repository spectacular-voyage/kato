import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";
import { runStartCommand } from "./start.ts";
import { runStopCommand } from "./stop.ts";

const DEFAULT_STOP_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_WAIT_POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDaemonToStop(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const deadline = Date.now() + DEFAULT_STOP_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const snapshot = await ctx.statusStore.load();
    if (!snapshot.daemonRunning) {
      return;
    }

    const stale = isStatusSnapshotStale(snapshot, ctx.runtime.now());
    if (stale) {
      return;
    }

    await sleep(DEFAULT_STOP_WAIT_POLL_INTERVAL_MS);
  }

  throw new Error(
    "Timed out waiting for daemon to stop before restart",
  );
}

export async function runRestartCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const snapshot = await ctx.statusStore.load();
  const stale = isStatusSnapshotStale(snapshot, ctx.runtime.now());

  if (!snapshot.daemonRunning || stale) {
    await ctx.operationalLogger.info(
      "daemon.restart.start_only",
      "Daemon restart used start-only path because daemon was not running or status was stale",
      {
        daemonRunning: snapshot.daemonRunning,
        staleBeforeRestart: stale,
        previousPid: snapshot.daemonPid,
      },
    );
    await ctx.auditLogger.command("restart", {
      daemonRunning: snapshot.daemonRunning,
      staleBeforeRestart: stale,
      previousPid: snapshot.daemonPid,
      restartMode: "start-only",
    });

    await runStartCommand(ctx);
    return;
  }

  await runStopCommand(ctx);
  await waitForDaemonToStop(ctx);
  await runStartCommand(ctx);

  await ctx.operationalLogger.info(
    "daemon.restart",
    "Daemon restart completed (stop then start)",
    {
      previousPid: snapshot.daemonPid,
    },
  );
  await ctx.auditLogger.command("restart", {
    previousPid: snapshot.daemonPid,
    restartMode: "stop-then-start",
  });
}
