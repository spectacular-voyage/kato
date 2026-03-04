import type { DaemonCliCommandContext } from "./context.ts";
import {
  appendExportsLogEntry,
  isStatusSnapshotStale,
  resolveExportsLogPath,
} from "@kato/runtime";

export async function runExportCommand(
  ctx: DaemonCliCommandContext,
  sessionId: string,
  outputPath?: string,
  format?: "markdown" | "jsonl",
): Promise<void> {
  const snapshot = await ctx.statusStore.load();
  const staleStatus = isStatusSnapshotStale(snapshot, ctx.runtime.now());
  if (!snapshot.daemonRunning || staleStatus) {
    await ctx.operationalLogger.warn(
      "export.rejected.daemon_unavailable",
      "Export request rejected because daemon status is unavailable or stale",
      {
        daemonRunning: snapshot.daemonRunning,
        staleStatus,
        daemonPid: snapshot.daemonPid,
      },
    );
    await ctx.auditLogger.command("export", {
      daemonRunning: snapshot.daemonRunning,
      staleStatus,
      daemonPid: snapshot.daemonPid,
      requestEnqueued: false,
    });
    throw new Error(
      "Export requires a running daemon with a fresh heartbeat. Start or restart the daemon and retry.",
    );
  }

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
      resolvedExportTimezone: ctx.sharedConfig.exportTimezone,
      resolvedExportMarkdownFrontmatter: {
        ...ctx.sharedConfig.exportMarkdownFrontmatter,
      },
      resolvedExportFeatureFlags: { ...ctx.sharedConfig.exportFeatureFlags },
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
    requestEnqueued: true,
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
