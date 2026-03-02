import type { DaemonCliCommandContext } from "./context.ts";
import {
  ensureWorkspaceConfigInitialized,
  loadWorkspaceTemplateScaffold,
  resolveWorkspaceInitPath,
} from "./workspace_shared.ts";

export async function runWorkspaceInitCommand(
  ctx: DaemonCliCommandContext,
  dirPath?: string,
): Promise<void> {
  const target = await resolveWorkspaceInitPath(ctx, dirPath);
  const scaffold = await loadWorkspaceTemplateScaffold(ctx);
  const created = await ensureWorkspaceConfigInitialized(
    target.configPath,
    scaffold,
  );

  await ctx.operationalLogger.info(
    "workspace.init",
    created
      ? "Workspace config initialized"
      : "Workspace config already present",
    {
      workspaceRoot: target.workspaceRoot,
      configPath: target.configPath,
      created,
    },
  );
  await ctx.auditLogger.command("workspace-init", {
    workspaceRoot: target.workspaceRoot,
    configPath: target.configPath,
    created,
  });

  ctx.runtime.writeStdout(
    `${
      created
        ? "created workspace config at"
        : "workspace config already exists at"
    } ${target.configPath}\n`,
  );
}
