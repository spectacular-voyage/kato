import { PersistentSessionStateStore } from "../../orchestrator/mod.ts";
import type { DaemonCliCommandContext } from "./context.ts";
import { resolveSessionSelector } from "./attachments_shared.ts";

export async function runDetachCommand(
  ctx: DaemonCliCommandContext,
  sessionSelector: string,
): Promise<void> {
  const sessionStateStore = new PersistentSessionStateStore({
    katoDir: ctx.runtimeConfig.katoDir,
  });
  const metadataList = await sessionStateStore.listSessionMetadata();
  const resolvedSession = resolveSessionSelector(sessionSelector, metadataList);
  const nextMetadata = structuredClone(resolvedSession.metadata);
  const previousWorkspaceRoot = nextMetadata.workspaceAttachment?.workspaceRoot;

  if (!nextMetadata.workspaceAttachment) {
    ctx.runtime.writeStdout(
      `session ${nextMetadata.provider}/${
        nextMetadata.sessionId.slice(0, 8)
      } is already using the default workspace\n`,
    );
    return;
  }

  const request = await ctx.controlStore.enqueue({
    command: "detach",
    payload: {
      sessionId: nextMetadata.sessionId,
      requestedByPid: ctx.runtime.pid,
      matchedBy: resolvedSession.matchedBy,
    },
  });

  await ctx.operationalLogger.info(
    "workspace.detach.requested",
    "Queued session workspace attachment removal",
    {
      requestId: request.requestId,
      sessionId: nextMetadata.sessionId,
      provider: nextMetadata.provider,
      providerSessionId: nextMetadata.providerSessionId,
      previousWorkspaceRoot,
      matchedBy: resolvedSession.matchedBy,
    },
  );
  await ctx.auditLogger.command(
    "detach",
    {
      requestId: request.requestId,
      sessionId: nextMetadata.sessionId,
      provider: nextMetadata.provider,
      providerSessionId: nextMetadata.providerSessionId,
      previousWorkspaceRoot,
      matchedBy: resolvedSession.matchedBy,
    },
  );

  ctx.runtime.writeStdout(
    `detach request queued: session=${nextMetadata.provider}/${
      nextMetadata.sessionId.slice(0, 8)
    } requestId=${request.requestId}\n`,
  );
}
