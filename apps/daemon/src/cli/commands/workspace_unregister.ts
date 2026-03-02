import type { DaemonCliCommandContext } from "./context.ts";
import {
  formatWorkspaceEntry,
  resolveWorkspaceRegistryStore,
} from "./workspace_shared.ts";

export async function runWorkspaceUnregisterCommand(
  ctx: DaemonCliCommandContext,
  selector: string,
): Promise<void> {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new Error("Workspace selector must be a non-empty string");
  }

  const store = resolveWorkspaceRegistryStore(ctx);
  const entries = await store.load();
  const match = entries.find((entry) =>
    entry.alias === trimmed || entry.workspaceId === trimmed
  );
  if (!match) {
    throw new Error(`Workspace not found: ${trimmed}`);
  }

  const nextEntries = entries.filter((entry) => entry.workspaceId !== match.workspaceId);
  await store.save(nextEntries);

  await ctx.operationalLogger.info(
    "workspace.unregister",
    "Removed workspace alias from registry",
    {
      workspaceId: match.workspaceId,
      alias: match.alias,
      workspaceRoot: match.workspaceRoot,
    },
  );
  await ctx.auditLogger.command("workspace-unregister", {
    workspaceId: match.workspaceId,
    alias: match.alias,
    workspaceRoot: match.workspaceRoot,
  });

  ctx.runtime.writeStdout(
    `workspace unregistered: ${formatWorkspaceEntry(match)}\n`,
  );
}
