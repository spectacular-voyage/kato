import type { DaemonStatusSnapshot } from "@kato/shared";
import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";

export async function runStatusCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
): Promise<void> {
  const snapshot: DaemonStatusSnapshot = await ctx.statusStore.load();
  const stale = isStatusSnapshotStale(snapshot, ctx.runtime.now());

  await ctx.operationalLogger.info(
    "daemon.status",
    "Daemon status requested from CLI",
    {
      asJson,
      daemonRunning: snapshot.daemonRunning,
      daemonPid: snapshot.daemonPid,
      stale,
      statusPath: ctx.runtime.statusPath,
    },
  );
  await ctx.auditLogger.command("status", { asJson });

  if (asJson) {
    ctx.runtime.writeStdout(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  const daemonText = snapshot.daemonRunning
    ? `running (pid: ${snapshot.daemonPid ?? "unknown"}${
      stale ? ", stale heartbeat" : ""
    })`
    : "stopped";

  ctx.runtime.writeStdout(`daemon: ${daemonText}\n`);
  ctx.runtime.writeStdout(`schemaVersion: ${snapshot.schemaVersion}\n`);
  ctx.runtime.writeStdout(`generatedAt: ${snapshot.generatedAt}\n`);
  ctx.runtime.writeStdout(`heartbeatAt: ${snapshot.heartbeatAt}\n`);
  ctx.runtime.writeStdout(`providers: ${snapshot.providers.length}\n`);
  ctx.runtime.writeStdout(
    `recordings: ${snapshot.recordings.activeRecordings} active (${snapshot.recordings.destinations} destinations)\n`,
  );
}
