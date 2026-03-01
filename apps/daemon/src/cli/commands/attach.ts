import { dirname } from "@std/path";
import { PersistentSessionStateStore } from "../../orchestrator/mod.ts";
import type { DaemonCliCommandContext } from "./context.ts";
import {
  discoverNearestWorkspaceConfigPath,
  resolveAttachmentOutputPath,
  resolveSessionSelector,
  synthesizeWorkspaceAttachment,
} from "./attachments_shared.ts";

function resolveCommandCwd(ctx: DaemonCliCommandContext): string {
  if (ctx.runtime.cwdPath) {
    return ctx.runtime.cwdPath;
  }
  return Deno.cwd();
}

export async function runAttachCommand(
  ctx: DaemonCliCommandContext,
  sessionSelector: string,
  outputPath?: string,
): Promise<void> {
  const sessionStateStore = new PersistentSessionStateStore({
    katoDir: ctx.runtimeConfig.katoDir,
  });
  const metadataList = await sessionStateStore.listSessionMetadata();
  const resolvedSession = resolveSessionSelector(sessionSelector, metadataList);

  const workspaceConfigPath = await discoverNearestWorkspaceConfigPath(
    resolveCommandCwd(ctx),
  );
  if (!workspaceConfigPath) {
    throw new Error(
      "No workspace config found. Create one at .kato/kato-config.yaml before attaching.",
    );
  }

  const workspaceRoot = dirname(dirname(workspaceConfigPath));
  const attachment = await synthesizeWorkspaceAttachment({
    globalConfigPath: ctx.runtime.configPath,
    workspaceConfigPath,
    workspaceRoot,
    runtimeConfig: ctx.runtimeConfig,
    now: ctx.runtime.now(),
  });

  let resolvedOutputPath: string | undefined;
  if (outputPath) {
    const candidateOutputPath = await resolveAttachmentOutputPath({
      outputPath,
      metadata: resolvedSession.metadata,
      attachment,
      now: ctx.runtime.now(),
    });
    const policyDecision = await ctx.pathPolicyGate.evaluateWritePath(
      candidateOutputPath,
    );
    await ctx.auditLogger.policyDecision(
      policyDecision.decision,
      candidateOutputPath,
      policyDecision.reason,
      {
        command: "attach",
        canonicalTargetPath: policyDecision.canonicalTargetPath,
        matchedRoot: policyDecision.matchedRoot,
      },
    );
    if (policyDecision.decision === "deny") {
      throw new Error(
        `Attach output path denied by policy: ${policyDecision.reason} (${candidateOutputPath})`,
      );
    }
    resolvedOutputPath = policyDecision.canonicalTargetPath ??
      candidateOutputPath;
  }

  const request = await ctx.controlStore.enqueue({
    command: "attach",
    payload: {
      sessionId: resolvedSession.metadata.sessionId,
      workspaceAttachment: attachment,
      ...(resolvedOutputPath ? { resolvedOutputPath } : {}),
      requestedByPid: ctx.runtime.pid,
      matchedBy: resolvedSession.matchedBy,
    },
  });

  await ctx.operationalLogger.info(
    "workspace.attach.requested",
    "Queued session workspace attachment update",
    {
      requestId: request.requestId,
      sessionId: resolvedSession.metadata.sessionId,
      provider: resolvedSession.metadata.provider,
      providerSessionId: resolvedSession.metadata.providerSessionId,
      workspaceRoot: attachment.workspaceRoot,
      ...(resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
      matchedBy: resolvedSession.matchedBy,
    },
  );
  await ctx.auditLogger.command(
    "attach",
    {
      requestId: request.requestId,
      sessionId: resolvedSession.metadata.sessionId,
      provider: resolvedSession.metadata.provider,
      providerSessionId: resolvedSession.metadata.providerSessionId,
      workspaceRoot: attachment.workspaceRoot,
      sourceConfigPath: attachment.sourceConfigPath,
      ...(resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
      matchedBy: resolvedSession.matchedBy,
    },
  );

  ctx.runtime.writeStdout(
    `attach request queued: session=${resolvedSession.metadata.provider}/${
      resolvedSession.metadata.sessionId.slice(0, 8)
    } workspace=${attachment.workspaceRoot}${
      resolvedOutputPath ? ` output=${resolvedOutputPath}` : ""
    } requestId=${request.requestId}\n`,
  );
}
