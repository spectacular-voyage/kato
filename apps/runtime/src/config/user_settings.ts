import { normalizeOutputTags, type UserConfig } from "@kato/shared";
import type { AuditLogger } from "../observability/audit_logger.ts";
import type { StructuredLogger } from "../observability/logger.ts";
import {
  type RegisteredWorkspace,
  resolveDefaultWorkspaceRegistryPath,
  WorkspaceRegistryFileStore,
  type WorkspaceRegistryStoreLike,
} from "../workspace/registry.ts";
import {
  cloneUserConfig,
  createDefaultUserConfig,
  resolveDefaultUserConfigPath,
  UserConfigFileStore,
  type UserConfigStoreLike,
  validateAndNormalizeParticipantUsername,
} from "./user_config.ts";

function resolveWorkspaceSelector(selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new Error("Workspace selector must be a non-empty string");
  }
  return trimmed;
}

function compareWorkspaces(
  a: RegisteredWorkspace,
  b: RegisteredWorkspace,
): number {
  return a.alias.localeCompare(b.alias) ||
    a.workspaceId.localeCompare(b.workspaceId);
}

export interface UserWorkspaceMappingListEntry {
  workspaceId: string;
  workspaceAlias: string;
  workspaceDisplayName?: string;
  username: string;
}

export interface UserWorkspaceTagLibraryListEntry {
  workspaceId: string;
  workspaceAlias: string;
  workspaceDisplayName?: string;
  tags: string[];
}

function compareUserMapEntries(
  a: UserWorkspaceMappingListEntry,
  b: UserWorkspaceMappingListEntry,
): number {
  const aliasCompare = a.workspaceAlias.localeCompare(b.workspaceAlias);
  if (aliasCompare !== 0) {
    return aliasCompare;
  }
  return a.workspaceId.localeCompare(b.workspaceId);
}

function compareUserTagLibraryEntries(
  a: UserWorkspaceTagLibraryListEntry,
  b: UserWorkspaceTagLibraryListEntry,
): number {
  const aliasCompare = a.workspaceAlias.localeCompare(b.workspaceAlias);
  if (aliasCompare !== 0) {
    return aliasCompare;
  }
  return a.workspaceId.localeCompare(b.workspaceId);
}

function buildUserMapListEntries(
  config: UserConfig,
  workspacesById: Map<string, RegisteredWorkspace>,
): UserWorkspaceMappingListEntry[] {
  return Object.entries(config.participants.workspaceUsernames)
    .map(([workspaceId, username]) => ({
      workspaceId,
      workspaceAlias: workspacesById.get(workspaceId)?.alias ?? "",
      workspaceDisplayName: workspacesById.get(workspaceId)?.displayName,
      username,
    }))
    .sort(compareUserMapEntries);
}

function buildUserTagLibraryListEntries(
  config: UserConfig,
  workspacesById: Map<string, RegisteredWorkspace>,
): UserWorkspaceTagLibraryListEntry[] {
  return Object.entries(config.tagLibraries?.workspaceSuggestions ?? {})
    .map(([workspaceId, tags]) => ({
      workspaceId,
      workspaceAlias: workspacesById.get(workspaceId)?.alias ?? "",
      workspaceDisplayName: workspacesById.get(workspaceId)?.displayName,
      tags: [...tags],
    }))
    .sort(compareUserTagLibraryEntries);
}

async function loadInitializedUserConfig(
  userConfigStore: UserConfigStoreLike,
): Promise<{ config: UserConfig; path: string; created: boolean }> {
  const initialized = await userConfigStore.ensureInitialized(
    createDefaultUserConfig(),
  );
  return {
    config: initialized.config,
    path: initialized.path,
    created: initialized.created,
  };
}

async function resolveWorkspaceBySelector(
  workspaceRegistryStore: WorkspaceRegistryStoreLike,
  selector: string,
): Promise<RegisteredWorkspace> {
  const workspace = await findWorkspaceBySelector(
    workspaceRegistryStore,
    selector,
  );
  const trimmedSelector = resolveWorkspaceSelector(selector);
  if (!workspace) {
    throw new Error(
      `Workspace not found: ${trimmedSelector}. Register it first with \`kato workspace register [<dir>] [--alias <alias>]\`.`,
    );
  }
  return workspace;
}

async function findWorkspaceBySelector(
  workspaceRegistryStore: WorkspaceRegistryStoreLike,
  selector: string,
): Promise<RegisteredWorkspace | undefined> {
  const trimmedSelector = resolveWorkspaceSelector(selector);
  const entries = await workspaceRegistryStore.load();
  return entries.find((entry) =>
    entry.alias === trimmedSelector || entry.workspaceId === trimmedSelector
  );
}

function resolveUserConfigStore(
  userConfigStore: UserConfigStoreLike | undefined,
  katoDir: string | undefined,
): UserConfigStoreLike {
  return userConfigStore ??
    new UserConfigFileStore(resolveDefaultUserConfigPath(katoDir));
}

function resolveWorkspaceRegistryStore(
  workspaceRegistryStore: WorkspaceRegistryStoreLike | undefined,
  katoDir: string | undefined,
): WorkspaceRegistryStoreLike {
  return workspaceRegistryStore ??
    new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
}

export interface LoadUserSettingsOptions {
  userConfigStore?: UserConfigStoreLike;
  workspaceRegistryStore?: WorkspaceRegistryStoreLike;
  katoDir?: string;
}

export interface LoadUserSettingsResult {
  config: UserConfig;
  path: string;
  mappings: UserWorkspaceMappingListEntry[];
  tagLibraryMappings: UserWorkspaceTagLibraryListEntry[];
  workspaces: RegisteredWorkspace[];
}

export async function loadUserSettings(
  options: LoadUserSettingsOptions = {},
): Promise<LoadUserSettingsResult> {
  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    options.katoDir,
  );
  const workspaceRegistryStore = resolveWorkspaceRegistryStore(
    options.workspaceRegistryStore,
    options.katoDir,
  );
  const initialized = await loadInitializedUserConfig(userConfigStore);
  const workspaces = (await workspaceRegistryStore.load()).sort(
    compareWorkspaces,
  );
  const workspacesById = new Map(workspaces.map((workspace) => [
    workspace.workspaceId,
    workspace,
  ]));

  return {
    config: initialized.config,
    path: initialized.path,
    mappings: buildUserMapListEntries(initialized.config, workspacesById),
    tagLibraryMappings: buildUserTagLibraryListEntries(
      initialized.config,
      workspacesById,
    ),
    workspaces,
  };
}

export interface SetWorkspaceUsernameMappingOptions {
  selector: string;
  username: string;
  userConfigStore?: UserConfigStoreLike;
  workspaceRegistryStore?: WorkspaceRegistryStoreLike;
  katoDir?: string;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface SetWorkspaceUsernameMappingResult {
  workspaceId: string;
  workspaceAlias: string;
  username: string;
  config: UserConfig;
}

export async function setWorkspaceUsernameMapping(
  options: SetWorkspaceUsernameMappingOptions,
): Promise<SetWorkspaceUsernameMappingResult> {
  const workspaceRegistryStore = resolveWorkspaceRegistryStore(
    options.workspaceRegistryStore,
    options.katoDir,
  );
  const workspace = await resolveWorkspaceBySelector(
    workspaceRegistryStore,
    options.selector,
  );
  const normalizedUsername = validateAndNormalizeParticipantUsername(
    options.username,
    "username",
  );
  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    options.katoDir,
  );
  const { config } = await loadInitializedUserConfig(userConfigStore);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.workspaceUsernames[workspace.workspaceId] =
    normalizedUsername;
  await userConfigStore.save(nextConfig);

  await options.operationalLogger?.info(
    "user.map.set",
    "Updated user workspace username mapping",
    {
      workspaceId: workspace.workspaceId,
      workspaceAlias: workspace.alias,
      usernamePresent: true,
    },
  );
  await options.auditLogger?.record(
    "user.map.set",
    "Updated user workspace username mapping",
    {
      workspaceId: workspace.workspaceId,
      workspaceAlias: workspace.alias,
      usernamePresent: true,
    },
  );

  return {
    workspaceId: workspace.workspaceId,
    workspaceAlias: workspace.alias,
    username: normalizedUsername,
    config: nextConfig,
  };
}

export interface DeleteWorkspaceUsernameMappingOptions {
  selector: string;
  userConfigStore?: UserConfigStoreLike;
  workspaceRegistryStore?: WorkspaceRegistryStoreLike;
  katoDir?: string;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface DeleteWorkspaceUsernameMappingResult {
  workspaceId: string;
  workspaceAlias: string;
  deleted: boolean;
  config: UserConfig;
}

export async function deleteWorkspaceUsernameMapping(
  options: DeleteWorkspaceUsernameMappingOptions,
): Promise<DeleteWorkspaceUsernameMappingResult> {
  const trimmedSelector = resolveWorkspaceSelector(options.selector);
  const workspaceRegistryStore = resolveWorkspaceRegistryStore(
    options.workspaceRegistryStore,
    options.katoDir,
  );

  let workspaceId = trimmedSelector;
  let workspaceAlias = trimmedSelector;
  const workspace = await findWorkspaceBySelector(
    workspaceRegistryStore,
    trimmedSelector,
  );
  if (workspace) {
    workspaceId = workspace.workspaceId;
    workspaceAlias = workspace.alias;
  }

  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    options.katoDir,
  );
  const { config } = await loadInitializedUserConfig(userConfigStore);
  const nextConfig = cloneUserConfig(config);
  const deleted = Object.hasOwn(
    nextConfig.participants.workspaceUsernames,
    workspaceId,
  );
  delete nextConfig.participants.workspaceUsernames[workspaceId];
  await userConfigStore.save(nextConfig);

  await options.operationalLogger?.info(
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
  await options.auditLogger?.record(
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

  return {
    workspaceId,
    workspaceAlias,
    deleted,
    config: nextConfig,
  };
}

export interface SetDefaultUsernameOptions {
  username: string;
  userConfigStore?: UserConfigStoreLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface SetDefaultUsernameResult {
  username: string;
  config: UserConfig;
}

export async function setDefaultUsername(
  options: SetDefaultUsernameOptions,
): Promise<SetDefaultUsernameResult> {
  const normalizedUsername = validateAndNormalizeParticipantUsername(
    options.username,
    "username",
  );
  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    undefined,
  );
  const { config } = await loadInitializedUserConfig(userConfigStore);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.defaultUsername = normalizedUsername;
  await userConfigStore.save(nextConfig);

  await options.operationalLogger?.info(
    "user.default.set",
    "Updated default participant username",
    { usernamePresent: true },
  );
  await options.auditLogger?.record(
    "user.default.set",
    "Updated default participant username",
    { usernamePresent: true },
  );

  return { username: normalizedUsername, config: nextConfig };
}

export interface ClearDefaultUsernameOptions {
  userConfigStore?: UserConfigStoreLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface ClearDefaultUsernameResult {
  config: UserConfig;
}

export async function clearDefaultUsername(
  options: ClearDefaultUsernameOptions = {},
): Promise<ClearDefaultUsernameResult> {
  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    undefined,
  );
  const { config } = await loadInitializedUserConfig(userConfigStore);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.defaultUsername = "";
  await userConfigStore.save(nextConfig);

  await options.operationalLogger?.info(
    "user.default.clear",
    "Cleared default participant username",
  );
  await options.auditLogger?.record(
    "user.default.clear",
    "Cleared default participant username",
  );

  return { config: nextConfig };
}

export interface SetExcludeMeOptions {
  value: boolean;
  userConfigStore?: UserConfigStoreLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface SetExcludeMeResult {
  value: boolean;
  config: UserConfig;
}

export async function setExcludeMeFromParticipantList(
  options: SetExcludeMeOptions,
): Promise<SetExcludeMeResult> {
  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    undefined,
  );
  const { config } = await loadInitializedUserConfig(userConfigStore);
  const nextConfig = cloneUserConfig(config);
  nextConfig.participants.excludeMeFromParticipantList = options.value;
  await userConfigStore.save(nextConfig);

  await options.operationalLogger?.info(
    "user.exclude_me.set",
    "Updated excludeMeFromParticipantList setting",
    { value: options.value },
  );
  await options.auditLogger?.record(
    "user.exclude_me.set",
    "Updated excludeMeFromParticipantList setting",
    { value: options.value },
  );

  return { value: options.value, config: nextConfig };
}

export interface SetGlobalTagSuggestionsOptions {
  tags: string[];
  userConfigStore?: UserConfigStoreLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface SetGlobalTagSuggestionsResult {
  tags: string[];
  config: UserConfig;
}

export async function setGlobalTagSuggestions(
  options: SetGlobalTagSuggestionsOptions,
): Promise<SetGlobalTagSuggestionsResult> {
  const tags = normalizeOutputTags(
    options.tags,
    "tagLibraries.globalSuggestions",
  );
  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    undefined,
  );
  const { config } = await loadInitializedUserConfig(userConfigStore);
  const nextConfig = cloneUserConfig(config);
  nextConfig.tagLibraries = nextConfig.tagLibraries ?? {
    globalSuggestions: [],
    workspaceSuggestions: {},
  };
  nextConfig.tagLibraries.globalSuggestions = tags;
  await userConfigStore.save(nextConfig);

  await options.operationalLogger?.info(
    "user.tags.global.set",
    "Updated global user tag suggestions",
    { tagCount: tags.length },
  );
  await options.auditLogger?.record(
    "user.tags.global.set",
    "Updated global user tag suggestions",
    { tagCount: tags.length },
  );

  return { tags, config: nextConfig };
}

export interface SetWorkspaceTagSuggestionsOptions {
  selector: string;
  tags: string[];
  userConfigStore?: UserConfigStoreLike;
  workspaceRegistryStore?: WorkspaceRegistryStoreLike;
  katoDir?: string;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface SetWorkspaceTagSuggestionsResult {
  workspaceId: string;
  workspaceAlias: string;
  tags: string[];
  config: UserConfig;
}

export async function setWorkspaceTagSuggestions(
  options: SetWorkspaceTagSuggestionsOptions,
): Promise<SetWorkspaceTagSuggestionsResult> {
  const workspaceRegistryStore = resolveWorkspaceRegistryStore(
    options.workspaceRegistryStore,
    options.katoDir,
  );
  const workspace = await resolveWorkspaceBySelector(
    workspaceRegistryStore,
    options.selector,
  );
  const tags = normalizeOutputTags(
    options.tags,
    `tagLibraries.workspaceSuggestions[${workspace.workspaceId}]`,
  );
  const userConfigStore = resolveUserConfigStore(
    options.userConfigStore,
    options.katoDir,
  );
  const { config } = await loadInitializedUserConfig(userConfigStore);
  const nextConfig = cloneUserConfig(config);
  nextConfig.tagLibraries = nextConfig.tagLibraries ?? {
    globalSuggestions: [],
    workspaceSuggestions: {},
  };
  if (tags.length > 0) {
    nextConfig.tagLibraries.workspaceSuggestions[workspace.workspaceId] = tags;
  } else {
    delete nextConfig.tagLibraries.workspaceSuggestions[workspace.workspaceId];
  }
  await userConfigStore.save(nextConfig);

  await options.operationalLogger?.info(
    "user.tags.workspace.set",
    "Updated workspace user tag suggestions",
    {
      workspaceId: workspace.workspaceId,
      workspaceAlias: workspace.alias,
      tagCount: tags.length,
    },
  );
  await options.auditLogger?.record(
    "user.tags.workspace.set",
    "Updated workspace user tag suggestions",
    {
      workspaceId: workspace.workspaceId,
      workspaceAlias: workspace.alias,
      tagCount: tags.length,
    },
  );

  return {
    workspaceId: workspace.workspaceId,
    workspaceAlias: workspace.alias,
    tags,
    config: nextConfig,
  };
}
