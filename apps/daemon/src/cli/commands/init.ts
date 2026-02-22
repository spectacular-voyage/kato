import type { DaemonCliCommandContext } from "./context.ts";

export async function runInitCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const result = await ctx.configStore.ensureInitialized(
    ctx.defaultRuntimeConfig,
  );

  await ctx.operationalLogger.info(
    "config.init",
    result.created
      ? "Runtime config initialized"
      : "Runtime config already present",
    {
      configPath: result.path,
      created: result.created,
    },
  );
  await ctx.auditLogger.command("init", {
    configPath: result.path,
    created: result.created,
  });

  if (result.created) {
    ctx.runtime.writeStdout(
      `created runtime config at ${result.path}\n`,
    );
    return;
  }

  ctx.runtime.writeStdout(
    `runtime config already exists at ${result.path}\n`,
  );
}
