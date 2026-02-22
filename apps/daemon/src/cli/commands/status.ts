import type { DaemonStatusSnapshot } from "@kato/shared";
import type { DaemonCliCommandContext } from "./context.ts";

export async function runStatusCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
): Promise<void> {
  const state = await ctx.stateStore.load();
  const snapshot: DaemonStatusSnapshot = {
    generatedAt: ctx.runtime.now().toISOString(),
    daemonRunning: state.daemonRunning,
    ...(state.daemonPid !== undefined ? { daemonPid: state.daemonPid } : {}),
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  await ctx.operationalLogger.info(
    "daemon.status",
    "Daemon status requested from CLI",
    {
      asJson,
      daemonRunning: snapshot.daemonRunning,
      daemonPid: snapshot.daemonPid,
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
  ctx.runtime.writeStdout("providers: 0\n");
  ctx.runtime.writeStdout("recordings: 0\n");
}
