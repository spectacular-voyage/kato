import type { DaemonCliCommandContext } from "./context.ts";
import type {
  CliConfig,
  RuntimeConfig,
  SharedBehaviorConfig,
} from "@kato/shared";
import { dirname } from "@std/path";
import {
  type CliConfigStoreLike,
  createDefaultUserConfig,
  expandHomePath,
  type RuntimeConfigStoreLike,
  type SharedBehaviorConfigStoreLike,
  type UserConfigStoreLike,
} from "@kato/runtime";
import {
  DefaultWorkspaceConfigFileStore,
  resolveDefaultWorkspaceTemplateConfigPath,
} from "@kato/runtime";

export interface EnsureGlobalConfigInitializationResult {
  runtimeConfigCreated: boolean;
  runtimeConfigPath: string;
  sharedConfigCreated: boolean;
  sharedConfigPath: string;
  cliConfigCreated: boolean;
  cliConfigPath: string;
  defaultWorkspaceConfigCreated: boolean;
  defaultWorkspaceConfigPath: string;
  userConfigCreated: boolean;
  userConfigPath: string;
}

export async function ensureGlobalConfigInitialized(
  options: {
    configStore: RuntimeConfigStoreLike;
    sharedConfigStore: SharedBehaviorConfigStoreLike;
    cliConfigStore: CliConfigStoreLike;
    userConfigStore: UserConfigStoreLike;
    defaultRuntimeConfig: RuntimeConfig;
    defaultSharedConfig: SharedBehaviorConfig;
    defaultCliConfig: CliConfig;
    katoDir: string;
  },
): Promise<EnsureGlobalConfigInitializationResult> {
  const runtimeResult = await options.configStore.ensureInitialized(
    options.defaultRuntimeConfig,
  );
  const sharedResult = await options.sharedConfigStore.ensureInitialized(
    options.defaultSharedConfig,
  );
  const cliResult = await options.cliConfigStore.ensureInitialized(
    options.defaultCliConfig,
  );
  const defaultWorkspaceConfigStore = new DefaultWorkspaceConfigFileStore(
    resolveDefaultWorkspaceTemplateConfigPath(options.katoDir),
  );
  const defaultWorkspaceResult = await defaultWorkspaceConfigStore
    .ensureInitialized();
  const userConfigResult = await options.userConfigStore.ensureInitialized(
    createDefaultUserConfig(),
  );

  return {
    runtimeConfigCreated: runtimeResult.created,
    runtimeConfigPath: runtimeResult.path,
    sharedConfigCreated: sharedResult.created,
    sharedConfigPath: sharedResult.path,
    cliConfigCreated: cliResult.created,
    cliConfigPath: cliResult.path,
    defaultWorkspaceConfigCreated: defaultWorkspaceResult.created,
    defaultWorkspaceConfigPath: defaultWorkspaceResult.path,
    userConfigCreated: userConfigResult.created,
    userConfigPath: userConfigResult.path,
  };
}

export async function runInitCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const resolvedKatoDir = expandHomePath(
    ctx.runtimeConfig.katoDir ?? dirname(ctx.runtimeConfig.runtimeDir),
  );
  const result = await ensureGlobalConfigInitialized({
    configStore: ctx.configStore,
    sharedConfigStore: ctx.sharedConfigStore,
    cliConfigStore: ctx.cliConfigStore,
    userConfigStore: ctx.resolveUserConfigStore(),
    defaultRuntimeConfig: ctx.defaultRuntimeConfig,
    defaultSharedConfig: ctx.defaultSharedConfig,
    defaultCliConfig: ctx.defaultCliConfig,
    katoDir: resolvedKatoDir,
  });

  await ctx.operationalLogger.info(
    "config.init",
    result.runtimeConfigCreated || result.defaultWorkspaceConfigCreated
      ? "Global config initialized"
      : "Global config already present",
    {
      runtimeConfigPath: result.runtimeConfigPath,
      runtimeConfigCreated: result.runtimeConfigCreated,
      sharedConfigPath: result.sharedConfigPath,
      sharedConfigCreated: result.sharedConfigCreated,
      cliConfigPath: result.cliConfigPath,
      cliConfigCreated: result.cliConfigCreated,
      defaultWorkspaceConfigPath: result.defaultWorkspaceConfigPath,
      defaultWorkspaceConfigCreated: result.defaultWorkspaceConfigCreated,
      userConfigPath: result.userConfigPath,
      userConfigCreated: result.userConfigCreated,
    },
  );
  await ctx.auditLogger.command("init", {
    runtimeConfigPath: result.runtimeConfigPath,
    runtimeConfigCreated: result.runtimeConfigCreated,
    sharedConfigPath: result.sharedConfigPath,
    sharedConfigCreated: result.sharedConfigCreated,
    cliConfigPath: result.cliConfigPath,
    cliConfigCreated: result.cliConfigCreated,
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
        result.sharedConfigCreated
          ? "created shared config at"
          : "shared config already exists at"
      } ${result.sharedConfigPath}`,
      `${
        result.cliConfigCreated
          ? "created CLI config at"
          : "CLI config already exists at"
      } ${result.cliConfigPath}`,
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
