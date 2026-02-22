import type { DaemonCliCommandContext } from "./context.ts";

export async function runExportCommand(
  ctx: DaemonCliCommandContext,
  sessionId: string,
  outputPath?: string,
): Promise<void> {
  await ctx.operationalLogger.info(
    "export.requested",
    "One-off export requested from CLI",
    {
      sessionId,
      outputPath,
    },
  );
  await ctx.auditLogger.command("export", {
    sessionId,
    outputPath,
  });

  ctx.runtime.writeStdout(
    `export queued (scaffold mode): session=${sessionId}${
      outputPath ? ` output=${outputPath}` : ""
    }\n`,
  );
}
