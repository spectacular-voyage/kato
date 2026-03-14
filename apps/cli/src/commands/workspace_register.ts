import type { DaemonCliCommandContext } from "./context.ts";
import { registerWorkspace } from "@kato/runtime";
import { formatWorkspaceEntry } from "./workspace_shared.ts";
import { runRestartCommand } from "./restart.ts";

export async function runWorkspaceRegisterCommand(
  ctx: DaemonCliCommandContext,
  alias?: string,
  dirPath?: string,
  noRestart = false,
): Promise<void> {
  const result = await registerWorkspace({
    alias,
    workspacePath: dirPath,
    cwdPath: ctx.runtime.cwdPath,
    katoDir: ctx.runtimeConfig.katoDir,
    now: ctx.runtime.now,
    sharedConfigStore: ctx.sharedConfigStore,
    runtimeAllowedWriteRoots: ctx.runtime.allowedWriteRoots,
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
  });

  ctx.sharedConfig = result.sharedConfig;
  ctx.runtime.allowedWriteRoots = [...result.sharedConfig.allowedWriteRoots];

  const shouldAutoRestart = result.runningDaemonMayDenyWrites && !noRestart;
  const lines = [
    `${
      result.created
        ? "workspace registered"
        : result.changed
        ? "workspace registration updated"
        : "workspace already registered"
    }: ${formatWorkspaceEntry(result.entry)}`,
  ];
  if (result.restartRequired && !shouldAutoRestart) {
    lines.push(
      "restart required before alias/root/config-path changes are used by the running daemon",
    );
  }
  if (result.sharedWriteRootsUpdated) {
    lines.push(
      "updated shared config: added workspace root to allowedWriteRoots",
    );
  }
  if (shouldAutoRestart) {
    lines.push("restarting daemon to reload shared allowedWriteRoots");
  } else if (result.runningDaemonMayDenyWrites) {
    lines.push(
      "skipped daemon restart (--no-restart); daemon processes launched before this registration may still deny writes for this workspace until `kato restart` reloads shared allowedWriteRoots",
    );
  }
  ctx.runtime.writeStdout(`${lines.join("\n")}\n`);

  if (shouldAutoRestart) {
    await runRestartCommand(ctx);
  }
}
