import type { DaemonStatusSnapshot } from "@kato/shared";
import type { DaemonCliCommandContext } from "./context.ts";

export async function runStatusCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
): Promise<void> {
  const snapshot: DaemonStatusSnapshot = await ctx.statusStore.load();

  await ctx.operationalLogger.info(
    "daemon.status",
    "Daemon status requested from CLI",
    {
      asJson,
      daemonRunning: snapshot.daemonRunning,
      daemonPid: snapshot.daemonPid,
      statusPath: ctx.runtime.statusPath,
    },
  );
  await ctx.auditLogger.command("status", { asJson });

  if (asJson) {
    ctx.runtime.writeStdout(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  const daemonText = snapshot.daemonRunning
    ? `running (pid: ${snapshot.daemonPid ?? "unknown"})`
    : "stopped";

  ctx.runtime.writeStdout(`daemon: ${daemonText}\n`);
  ctx.runtime.writeStdout(`generatedAt: ${snapshot.generatedAt}\n`);
  ctx.runtime.writeStdout(`providers: ${snapshot.providers.length}\n`);
  ctx.runtime.writeStdout(
    `recordings: ${snapshot.recordings.activeRecordings} active (${snapshot.recordings.destinations} destinations)\n`,
  );
}
