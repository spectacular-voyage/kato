import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";

const STARTUP_ACK_TIMEOUT_MS = 10_000;
const STARTUP_ACK_POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDaemonStartupAck(
  ctx: DaemonCliCommandContext,
  launchedPid: number,
  launchedAtMs: number,
): Promise<{
  heartbeatAt: string;
  ackLatencyMs: number;
}> {
  const deadline = Date.now() + STARTUP_ACK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const snapshot = await ctx.statusStore.load();
    if (snapshot.daemonRunning && snapshot.daemonPid === launchedPid) {
      const heartbeatMs = Date.parse(snapshot.heartbeatAt);
      if (Number.isFinite(heartbeatMs) && heartbeatMs >= launchedAtMs) {
        return {
          heartbeatAt: snapshot.heartbeatAt,
          ackLatencyMs: Math.max(0, heartbeatMs - launchedAtMs),
        };
      }
    }
    await sleep(STARTUP_ACK_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for daemon startup acknowledgement (pid: ${launchedPid})`,
  );
}

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

  const launchedAtMs = ctx.runtime.now().getTime();
  const launchedPid = await ctx.daemonLauncher.launchDetached();
  const ack = await waitForDaemonStartupAck(ctx, launchedPid, launchedAtMs);

  await ctx.operationalLogger.info(
    "daemon.start",
    "Daemon start acknowledged by runtime heartbeat",
    {
      launchedPid,
      requestedByPid: ctx.runtime.pid,
      staleBeforeLaunch: stale,
      startupAckHeartbeatAt: ack.heartbeatAt,
      startupAckLatencyMs: ack.ackLatencyMs,
      statusPath: ctx.runtime.statusPath,
    },
  );
  await ctx.auditLogger.command("start", {
    launchedPid,
    staleBeforeLaunch: stale,
    startupAckHeartbeatAt: ack.heartbeatAt,
    startupAckLatencyMs: ack.ackLatencyMs,
  });

  ctx.runtime.writeStdout(
    `kato daemon started in background (pid: ${launchedPid}).\n`,
  );
}
