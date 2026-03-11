import type { DaemonCliCommandContext } from "./context.ts";
import { unregisterWorkspace } from "@kato/runtime";
import { formatWorkspaceEntry } from "./workspace_shared.ts";

export async function runWorkspaceUnregisterCommand(
  ctx: DaemonCliCommandContext,
  selector: string,
): Promise<void> {
  const result = await unregisterWorkspace({
    selector,
    katoDir: ctx.runtimeConfig.katoDir,
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
  });

  ctx.runtime.writeStdout(
    `workspace unregistered: ${formatWorkspaceEntry(result.entry)}\n`,
  );
}
