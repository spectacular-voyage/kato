import type { UserConfig } from "@kato/shared";
import type { DaemonCliCommandContext } from "./context.ts";
import {
  createDefaultUserConfig,
  validateAndNormalizeParticipantUsername,
} from "@kato/runtime";
import {
  resolveWorkspaceBySelector,
  resolveWorkspaceRegistryStore,
  resolveWorkspaceSelector,
  WorkspaceNotFoundError,
} from "./workspace_shared.ts";

interface UserMapListEntry {
  workspaceId: string;
  workspaceAlias: string;
  username: string;
}

function compareUserMapEntries(
  a: UserMapListEntry,
  b: UserMapListEntry,
): number {
  const aliasCompare = a.workspaceAlias.localeCompare(b.workspaceAlias);
  if (aliasCompare !== 0) {
    return aliasCompare;
  }
  return a.workspaceId.localeCompare(b.workspaceId);
}

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

function cloneUserConfig(config: UserConfig): UserConfig {
  return {
    schemaVersion: config.schemaVersion,
    participants: {
      defaultUsername: config.participants.defaultUsername,
      workspaceUsernames: { ...config.participants.workspaceUsernames },
      excludeMeFromParticipantList:
        config.participants.excludeMeFromParticipantList,
    },
  };
}

function isWorkspaceSelectorNotFoundError(error: unknown): boolean {
  return error instanceof WorkspaceNotFoundError;
}

function buildUserMapListEntries(
  config: UserConfig,
  workspaceAliasesById: Map<string, string>,
): UserMapListEntry[] {
  const mappings = Object.entries(config.participants.workspaceUsernames)
    .map(([workspaceId, username]) => ({
      workspaceId,
      workspaceAlias: workspaceAliasesById.get(workspaceId) ?? "",
      username,
    }))
    .sort(compareUserMapEntries);

  return mappings;
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
  const workspace = await resolveWorkspaceBySelector(ctx, selector);
  const normalizedUsername = validateAndNormalizeParticipantUsername(
    username,
    "username",
  );
  const { config } = await loadInitializedUserConfig(ctx);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.workspaceUsernames[workspace.workspaceId] =
    normalizedUsername;
  await ctx.resolveUserConfigStore().save(nextConfig);

  await ctx.operationalLogger.info(
    "user.map.set",
    "Updated user workspace username mapping",
    {
      workspaceId: workspace.workspaceId,
      workspaceAlias: workspace.alias,
      username: normalizedUsername,
    },
  );
  await ctx.auditLogger.command("user-map-set", {
    workspaceId: workspace.workspaceId,
    workspaceAlias: workspace.alias,
    username: normalizedUsername,
  });

  ctx.runtime.writeStdout(
    `user mapping set: ${workspace.alias} (${workspace.workspaceId}) -> ${normalizedUsername}\n`,
  );
}

export async function runUserMapListCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
): Promise<void> {
  const { config } = await loadInitializedUserConfig(ctx);
  const workspaces = await resolveWorkspaceRegistryStore(ctx).load();
  const aliasesById = new Map(workspaces.map((workspace) => [
    workspace.workspaceId,
    workspace.alias,
  ]));
  const mappings = buildUserMapListEntries(config, aliasesById);

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
  const trimmedSelector = resolveWorkspaceSelector(selector);
  let workspaceId = trimmedSelector;
  let workspaceAlias = trimmedSelector;
  try {
    const workspace = await resolveWorkspaceBySelector(ctx, trimmedSelector);
    workspaceId = workspace.workspaceId;
    workspaceAlias = workspace.alias;
  } catch (error) {
    if (!isWorkspaceSelectorNotFoundError(error)) {
      throw error;
    }
  }

  const { config } = await loadInitializedUserConfig(ctx);
  const nextConfig = cloneUserConfig(config);
  const deleted = Object.hasOwn(
    nextConfig.participants.workspaceUsernames,
    workspaceId,
  );
  delete nextConfig.participants.workspaceUsernames[workspaceId];
  await ctx.resolveUserConfigStore().save(nextConfig);

  await ctx.operationalLogger.info(
    "user.map.delete",
    deleted
      ? "Deleted user workspace username mapping"
      : "User workspace username mapping already absent",
    {
      workspaceId,
      workspaceAlias,
      deleted,
    },
  );
  await ctx.auditLogger.command("user-map-delete", {
    workspaceId,
    workspaceAlias,
    deleted,
  });

  ctx.runtime.writeStdout(
    `${
      deleted ? "user mapping deleted" : "user mapping already absent"
    }: ${workspaceAlias} (${workspaceId})\n`,
  );
}

export async function runUserDefaultSetCommand(
  ctx: DaemonCliCommandContext,
  username: string,
): Promise<void> {
  const normalizedUsername = validateAndNormalizeParticipantUsername(
    username,
    "username",
  );
  const { config } = await loadInitializedUserConfig(ctx);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.defaultUsername = normalizedUsername;
  await ctx.resolveUserConfigStore().save(nextConfig);

  await ctx.operationalLogger.info(
    "user.default.set",
    "Updated default participant username",
    { username: normalizedUsername },
  );
  await ctx.auditLogger.command("user-default-set", {
    username: normalizedUsername,
  });

  ctx.runtime.writeStdout(`user default username set: ${normalizedUsername}\n`);
}

export async function runUserDefaultClearCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const { config } = await loadInitializedUserConfig(ctx);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.defaultUsername = "";
  await ctx.resolveUserConfigStore().save(nextConfig);

  await ctx.operationalLogger.info(
    "user.default.clear",
    "Cleared default participant username",
  );
  await ctx.auditLogger.command("user-default-clear", {});

  ctx.runtime.writeStdout("user default username cleared\n");
}

export async function runUserExcludeMeCommand(
  ctx: DaemonCliCommandContext,
  value: boolean,
): Promise<void> {
  const { config } = await loadInitializedUserConfig(ctx);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.excludeMeFromParticipantList = value;
  await ctx.resolveUserConfigStore().save(nextConfig);

  await ctx.operationalLogger.info(
    "user.exclude_me.set",
    "Updated excludeMeFromParticipantList setting",
    { value },
  );
  await ctx.auditLogger.command("user-exclude-me", { value });

  ctx.runtime.writeStdout(`excludeMeFromParticipantList set to ${value}\n`);
}
