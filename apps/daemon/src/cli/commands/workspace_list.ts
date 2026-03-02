import type { DaemonCliCommandContext } from "./context.ts";
import {
  formatWorkspaceEntry,
  resolveWorkspaceRegistryStore,
} from "./workspace_shared.ts";

export async function runWorkspaceListCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const entries = await resolveWorkspaceRegistryStore(ctx).load();
  if (entries.length === 0) {
    ctx.runtime.writeStdout("no registered workspaces\n");
    return;
  }
  const lines = entries
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => formatWorkspaceEntry(entry));
  ctx.runtime.writeStdout(`${lines.join("\n")}\n`);
}
