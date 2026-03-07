import type { UserConfig } from "@kato/shared";
import type { DaemonCliCommandContext } from "./context.ts";
import {
  clearDefaultUsername,
  createDefaultUserConfig,
  deleteWorkspaceUsernameMapping,
  loadUserSettings,
  setDefaultUsername,
  setExcludeMeFromParticipantList,
  setWorkspaceUsernameMapping,
  validateAndNormalizeParticipantUsername,
} from "@kato/runtime";
import { resolveWorkspaceRegistryStore } from "./workspace_shared.ts";

async function loadInitializedUserConfig(
  ctx: DaemonCliCommandContext,
): Promise<{ config: UserConfig; path: string }> {
  const store = ctx.resolveUserConfigStore();
  const initialized = await store.ensureInitialized(createDefaultUserConfig());
  return {
    config: initialized.config,
    path: initialized.path,
  };
}

export async function runUserInitCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const initialized = await ctx.resolveUserConfigStore().ensureInitialized(
    createDefaultUserConfig(),
  );

  await ctx.operationalLogger.info(
    "user.init",
    initialized.created
      ? "User config initialized"
      : "User config already present",
    {
      userConfigPath: initialized.path,
      userConfigCreated: initialized.created,
    },
  );
  await ctx.auditLogger.command("user-init", {
    userConfigPath: initialized.path,
    userConfigCreated: initialized.created,
  });

  ctx.runtime.writeStdout(
    `${
      initialized.created
        ? "created user config at"
        : "user config already exists at"
    } ${initialized.path}\n`,
  );
}

export async function runUserMapSetCommand(
  ctx: DaemonCliCommandContext,
  selector: string,
  username: string,
): Promise<void> {
  const normalizedUsername = validateAndNormalizeParticipantUsername(
    username,
    "username",
  );
  const result = await setWorkspaceUsernameMapping({
    selector,
    username: normalizedUsername,
    userConfigStore: ctx.resolveUserConfigStore(),
    workspaceRegistryStore: resolveWorkspaceRegistryStore(ctx),
    katoDir: ctx.runtimeConfig.katoDir,
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
  });

  ctx.runtime.writeStdout(
    `user mapping set: ${result.workspaceAlias} (${result.workspaceId}) -> ${result.username}\n`,
  );
}

export async function runUserMapListCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
): Promise<void> {
  const { mappings } = await loadUserSettings({
    userConfigStore: ctx.resolveUserConfigStore(),
    workspaceRegistryStore: resolveWorkspaceRegistryStore(ctx),
    katoDir: ctx.runtimeConfig.katoDir,
  });

  if (asJson) {
    ctx.runtime.writeStdout(
      `${JSON.stringify({ schemaVersion: 1, mappings }, null, 2)}\n`,
    );
    return;
  }

  if (mappings.length === 0) {
    ctx.runtime.writeStdout("no user workspace mappings\n");
    return;
  }

  const lines = mappings.map((entry) => {
    const aliasLabel = entry.workspaceAlias.length > 0
      ? entry.workspaceAlias
      : "<unregistered>";
    return `${aliasLabel} (${entry.workspaceId}) -> ${entry.username}`;
  });
  ctx.runtime.writeStdout(`${lines.join("\n")}\n`);
}

export async function runUserMapDeleteCommand(
  ctx: DaemonCliCommandContext,
  selector: string,
): Promise<void> {
  const result = await deleteWorkspaceUsernameMapping({
    selector,
    userConfigStore: ctx.resolveUserConfigStore(),
    workspaceRegistryStore: resolveWorkspaceRegistryStore(ctx),
    katoDir: ctx.runtimeConfig.katoDir,
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
  });

  ctx.runtime.writeStdout(
    `${
      result.deleted ? "user mapping deleted" : "user mapping already absent"
    }: ${result.workspaceAlias} (${result.workspaceId})\n`,
  );
}

export async function runUserDefaultSetCommand(
  ctx: DaemonCliCommandContext,
  username: string,
): Promise<void> {
  const result = await setDefaultUsername({
    username,
    userConfigStore: ctx.resolveUserConfigStore(),
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
  });

  ctx.runtime.writeStdout(`user default username set: ${result.username}\n`);
}

export async function runUserDefaultClearCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  await clearDefaultUsername({
    userConfigStore: ctx.resolveUserConfigStore(),
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
  });
  ctx.runtime.writeStdout("user default username cleared\n");
}

export async function runUserExcludeMeCommand(
  ctx: DaemonCliCommandContext,
  value: boolean,
): Promise<void> {
  const result = await setExcludeMeFromParticipantList({
    value,
    userConfigStore: ctx.resolveUserConfigStore(),
    operationalLogger: ctx.operationalLogger,
    auditLogger: ctx.auditLogger,
  });
  ctx.runtime.writeStdout(
    `excludeMeFromParticipantList set to ${result.value}\n`,
  );
}
