import type { DaemonCliCommandContext } from "./context.ts";
import {
  appendExportsLogEntry,
  resolveExportsLogPath,
} from "../../utils/exports_log.ts";

export async function runExportCommand(
  ctx: DaemonCliCommandContext,
  sessionId: string,
  outputPath?: string,
  format?: "markdown" | "jsonl",
): Promise<void> {
  let resolvedOutputPath = outputPath;
  if (outputPath) {
    const policyDecision = await ctx.pathPolicyGate.evaluateWritePath(
      outputPath,
    );
    await ctx.auditLogger.policyDecision(
      policyDecision.decision,
      outputPath,
      policyDecision.reason,
      {
        command: "export",
        canonicalTargetPath: policyDecision.canonicalTargetPath,
        matchedRoot: policyDecision.matchedRoot,
      },
    );

    if (policyDecision.decision === "deny") {
      await ctx.operationalLogger.warn(
        "export.denied",
        "Export request denied by path policy",
        {
          sessionId,
          outputPath,
          reason: policyDecision.reason,
          canonicalTargetPath: policyDecision.canonicalTargetPath,
        },
      );
      throw new Error(
        `Export path denied by policy: ${policyDecision.reason} (${outputPath})`,
      );
    }

    resolvedOutputPath = policyDecision.canonicalTargetPath ?? outputPath;
  }

  const request = await ctx.controlStore.enqueue({
    command: "export",
    payload: {
      sessionId,
      ...(outputPath ? { outputPath } : {}),
      ...(resolvedOutputPath ? { resolvedOutputPath } : {}),
      ...(format ? { format } : {}),
      requestedByPid: ctx.runtime.pid,
    },
  });

  await ctx.operationalLogger.info(
    "export.requested",
    "One-off export enqueued from CLI",
    {
      requestId: request.requestId,
      sessionId,
      outputPath,
      resolvedOutputPath,
      format,
      controlPath: ctx.runtime.controlPath,
    },
  );
  await ctx.auditLogger.command("export", {
    requestId: request.requestId,
    sessionId,
    outputPath,
    resolvedOutputPath,
    format,
  });

  const exportsLogPath = resolveExportsLogPath(ctx.runtime.runtimeDir);
  try {
    await appendExportsLogEntry(exportsLogPath, {
      recordedAt: ctx.runtime.now().toISOString(),
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      status: "queued",
      sessionId,
      ...(resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
      ...(format ? { format } : {}),
    });
  } catch (error) {
    await ctx.operationalLogger.warn(
      "export.history.write_failed",
      "Failed to append queued export event",
      {
        requestId: request.requestId,
        sessionId,
        outputPath: resolvedOutputPath,
        exportsLogPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  ctx.runtime.writeStdout(
    `export request queued: session=${sessionId}${
      outputPath ? ` output=${outputPath}` : ""
    }${format ? ` format=${format}` : ""} requestId=${request.requestId}\n`,
  );
}
