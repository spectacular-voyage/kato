import type { DaemonCliCommandContext } from "./context.ts";
import type { RuntimeConfig } from "@kato/shared";
import {
  createDefaultUserConfig,
  type RuntimeConfigStoreLike,
  type UserConfigStoreLike,
} from "../../config/mod.ts";
import {
  DefaultWorkspaceConfigFileStore,
  resolveDefaultWorkspaceTemplateConfigPath,
} from "../../workspace/mod.ts";

export interface EnsureGlobalConfigInitializationResult {
  runtimeConfigCreated: boolean;
  runtimeConfigPath: string;
  defaultWorkspaceConfigCreated: boolean;
  defaultWorkspaceConfigPath: string;
  userConfigCreated: boolean;
  userConfigPath: string;
}

export async function ensureGlobalConfigInitialized(
  options: {
    configStore: RuntimeConfigStoreLike;
    userConfigStore: UserConfigStoreLike;
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
  const userConfigResult = await options.userConfigStore.ensureInitialized(
    createDefaultUserConfig(),
  );

  return {
    runtimeConfigCreated: runtimeResult.created,
    runtimeConfigPath: runtimeResult.path,
    defaultWorkspaceConfigCreated: defaultWorkspaceResult.created,
    defaultWorkspaceConfigPath: defaultWorkspaceResult.path,
    userConfigCreated: userConfigResult.created,
    userConfigPath: userConfigResult.path,
  };
}

export async function runInitCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const result = await ensureGlobalConfigInitialized({
    configStore: ctx.configStore,
    userConfigStore: ctx.resolveUserConfigStore(),
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
      userConfigPath: result.userConfigPath,
      userConfigCreated: result.userConfigCreated,
    },
  );
  await ctx.auditLogger.command("init", {
    runtimeConfigPath: result.runtimeConfigPath,
    runtimeConfigCreated: result.runtimeConfigCreated,
    defaultWorkspaceConfigPath: result.defaultWorkspaceConfigPath,
    defaultWorkspaceConfigCreated: result.defaultWorkspaceConfigCreated,
    userConfigPath: result.userConfigPath,
    userConfigCreated: result.userConfigCreated,
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
      `${
        result.userConfigCreated
          ? "created user config at"
          : "user config already exists at"
      } ${result.userConfigPath}`,
    ].join("\n") + "\n",
  );
}
