import type { DaemonCliCommandContext } from "./context.ts";
import type { RuntimeConfig } from "@kato/shared";
import type { RuntimeConfigStoreLike } from "../../config/mod.ts";
import {
  DefaultWorkspaceConfigFileStore,
  resolveDefaultWorkspaceTemplateConfigPath,
} from "../../workspace/mod.ts";

export interface EnsureGlobalConfigInitializationResult {
  runtimeConfigCreated: boolean;
  runtimeConfigPath: string;
  defaultWorkspaceConfigCreated: boolean;
  defaultWorkspaceConfigPath: string;
}

export async function ensureGlobalConfigInitialized(
  options: {
    configStore: RuntimeConfigStoreLike;
    defaultRuntimeConfig: RuntimeConfig;
    runtimeConfigPath: string;
  },
): Promise<EnsureGlobalConfigInitializationResult> {
  const runtimeResult = await options.configStore.ensureInitialized(
    options.defaultRuntimeConfig,
  );
  const defaultWorkspaceConfigStore = new DefaultWorkspaceConfigFileStore(
    resolveDefaultWorkspaceTemplateConfigPath(options.runtimeConfigPath),
  );
  const defaultWorkspaceResult = await defaultWorkspaceConfigStore
    .ensureInitialized();

  return {
    runtimeConfigCreated: runtimeResult.created,
    runtimeConfigPath: runtimeResult.path,
    defaultWorkspaceConfigCreated: defaultWorkspaceResult.created,
    defaultWorkspaceConfigPath: defaultWorkspaceResult.path,
  };
}

export async function runInitCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const result = await ensureGlobalConfigInitialized({
    configStore: ctx.configStore,
    defaultRuntimeConfig: ctx.defaultRuntimeConfig,
    runtimeConfigPath: ctx.runtime.configPath,
  });

  await ctx.operationalLogger.info(
    "config.init",
    result.runtimeConfigCreated || result.defaultWorkspaceConfigCreated
      ? "Global config initialized"
      : "Global config already present",
    {
      runtimeConfigPath: result.runtimeConfigPath,
      runtimeConfigCreated: result.runtimeConfigCreated,
      defaultWorkspaceConfigPath: result.defaultWorkspaceConfigPath,
      defaultWorkspaceConfigCreated: result.defaultWorkspaceConfigCreated,
    },
  );
  await ctx.auditLogger.command("init", {
    runtimeConfigPath: result.runtimeConfigPath,
    runtimeConfigCreated: result.runtimeConfigCreated,
    defaultWorkspaceConfigPath: result.defaultWorkspaceConfigPath,
    defaultWorkspaceConfigCreated: result.defaultWorkspaceConfigCreated,
  });

  ctx.runtime.writeStdout(
    [
      `${
        result.runtimeConfigCreated
          ? "created runtime config at"
          : "runtime config already exists at"
      } ${result.runtimeConfigPath}`,
      `${
        result.defaultWorkspaceConfigCreated
          ? "created default workspace config at"
          : "default workspace config already exists at"
      } ${result.defaultWorkspaceConfigPath}`,
    ].join("\n") + "\n",
  );
}
