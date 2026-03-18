import {
  normalizeWorkspaceDisplayName,
  type SharedBehaviorConfig,
} from "@kato/shared";
import { basename, join, resolve } from "@std/path";
import type { SharedBehaviorConfigStoreLike } from "../config/shared_behavior_config.ts";
import {
  resolveDefaultSharedConfigPath,
  SharedBehaviorConfigFileStore,
} from "../config/shared_behavior_config.ts";
import type { AuditLogger } from "../observability/audit_logger.ts";
import type { StructuredLogger } from "../observability/logger.ts";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";
import {
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  ensureWorkspaceConfigWorkspaceId,
  findNearestWorkspaceConfig,
  isPathWithinRoots,
  readWorkspaceConfigWorkspaceId,
  type RegisteredWorkspace,
  resolveDefaultWorkspaceRegistryPath,
  resolveWorkspaceConfigPath,
  WorkspaceRegistryFileStore,
  type WorkspaceRegistryStoreLike,
} from "./registry.ts";

function cloneEntry(entry: RegisteredWorkspace): RegisteredWorkspace {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    registeredAt: entry.registeredAt,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

function cloneSharedConfig(config: SharedBehaviorConfig): SharedBehaviorConfig {
  return {
    schemaVersion: config.schemaVersion,
    allowedWriteRoots: [...config.allowedWriteRoots],
    exportTimezone: config.exportTimezone,
    exportMarkdownFrontmatter: { ...config.exportMarkdownFrontmatter },
    exportFeatureFlags: { ...config.exportFeatureFlags },
  };
}

function validateWorkspaceAlias(alias: string): string {
  const trimmed = alias.trim();
  if (trimmed.length === 0) {
    throw new Error("Workspace alias must be a non-empty string");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("Workspace alias must not contain spaces");
  }
  return trimmed;
}

function resolveWorkspaceSelector(selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new Error("Workspace selector must be a non-empty string");
  }
  return trimmed;
}

function findWorkspaceBySelector(
  entries: RegisteredWorkspace[],
  selector: string,
): RegisteredWorkspace | undefined {
  const trimmed = resolveWorkspaceSelector(selector);
  return entries.find((entry) =>
    entry.alias === trimmed || entry.workspaceId === trimmed
  );
}

function resolveRequestedWorkspaceAlias(
  alias: string | undefined,
  workspaceRoot: string,
): string {
  const trimmed = alias?.trim() ?? "";
  if (trimmed.length > 0) {
    return validateWorkspaceAlias(trimmed);
  }
  return validateWorkspaceAlias(basename(workspaceRoot));
}

function findWorkspaceByRoot(
  entries: RegisteredWorkspace[],
  workspaceRoot: string,
  configPath: string,
): RegisteredWorkspace | undefined {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedConfigPath = resolve(configPath);
  return entries.find((entry) =>
    resolve(entry.workspaceRoot) === resolvedRoot ||
    resolve(entry.configPath) === resolvedConfigPath
  );
}

async function resolveRegisterTarget(
  options: {
    cwdPath?: string;
    workspacePath?: string;
  },
): Promise<{ workspaceRoot: string; configPath: string }> {
  const { cwdPath, workspacePath } = options;

  if (workspacePath && workspacePath.trim().length > 0) {
    if (
      !cwdPath &&
      !workspacePath.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(workspacePath)
    ) {
      throw new Error(
        "Relative workspace paths require a current working directory",
      );
    }
    const workspaceRoot = cwdPath
      ? resolve(cwdPath, workspacePath)
      : resolve(workspacePath);
    const configPath = await resolveWorkspaceConfigPath(workspaceRoot);
    if (!configPath) {
      throw new Error(
        `No workspace config found at ${
          join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME)
        }. Run \`kato workspace init ${workspacePath}\` first.`,
      );
    }
    return { workspaceRoot, configPath };
  }

  if (!cwdPath) {
    throw new Error("Workspace path is required");
  }
  const located = await findNearestWorkspaceConfig(cwdPath);
  if (!located) {
    throw new Error(
      `No workspace config found. Run \`kato workspace init\` to create ./${DEFAULT_WORKSPACE_CONFIG_FILENAME} from the default template first.`,
    );
  }
  return located;
}

async function ensureWorkspaceRootWriteCoverage(
  sharedConfig: SharedBehaviorConfig,
  sharedConfigStore: SharedBehaviorConfigStoreLike,
  workspaceRoot: string,
): Promise<SharedBehaviorConfig | undefined> {
  if (isPathWithinRoots(workspaceRoot, sharedConfig.allowedWriteRoots)) {
    return undefined;
  }

  const nextSharedConfig = cloneSharedConfig(sharedConfig);
  nextSharedConfig.allowedWriteRoots.push(workspaceRoot);
  await sharedConfigStore.save(nextSharedConfig);
  return nextSharedConfig;
}

export interface RegisterWorkspaceMutationOptions {
  alias?: string;
  workspacePath?: string;
  cwdPath?: string;
  katoDir?: string;
  now?: () => Date;
  sharedConfigStore?: SharedBehaviorConfigStoreLike;
  registryStore?: WorkspaceRegistryStoreLike;
  runtimeAllowedWriteRoots?: string[];
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface RegisterWorkspaceMutationResult {
  entry: RegisteredWorkspace;
  created: boolean;
  changed: boolean;
  restartRequired: boolean;
  sharedWriteRootsUpdated: boolean;
  runningDaemonMayDenyWrites: boolean;
  sharedConfig: SharedBehaviorConfig;
}

export async function registerWorkspace(
  options: RegisterWorkspaceMutationOptions,
): Promise<RegisterWorkspaceMutationResult> {
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const now = options.now ?? (() => new Date());
  const registryStore = options.registryStore ??
    new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
  const sharedConfigStore = options.sharedConfigStore ??
    new SharedBehaviorConfigFileStore(resolveDefaultSharedConfigPath(katoDir));

  const target = await resolveRegisterTarget({
    cwdPath: options.cwdPath,
    workspacePath: options.workspacePath,
  });
  const entries = await registryStore.load();
  const sharedConfig = await sharedConfigStore.load();
  const configuredWorkspaceId = await readWorkspaceConfigWorkspaceId(
    target.configPath,
    { allowMissing: true },
  );
  const requestedAlias = resolveRequestedWorkspaceAlias(
    options.alias,
    target.workspaceRoot,
  );

  const existingByAlias = entries.find((entry) =>
    entry.alias === requestedAlias
  );
  const existingByWorkspaceIdAlias = entries.find((entry) =>
    entry.workspaceId === requestedAlias
  );
  const existingByWorkspaceId = configuredWorkspaceId
    ? entries.find((entry) => entry.workspaceId === configuredWorkspaceId)
    : undefined;
  const existingByRoot = findWorkspaceByRoot(
    entries,
    target.workspaceRoot,
    target.configPath,
  );
  if (
    existingByWorkspaceId &&
    existingByRoot &&
    existingByWorkspaceId.workspaceId !== existingByRoot.workspaceId
  ) {
    throw new Error(
      "Workspace config conflicts with an existing registry entry at this path",
    );
  }
  const existingWorkspace = existingByWorkspaceId ?? existingByRoot;

  if (existingByWorkspaceIdAlias) {
    throw new Error(`Workspace alias already registered: ${requestedAlias}`);
  }

  if (
    existingByAlias &&
    (!existingWorkspace ||
      existingByAlias.workspaceId !== existingWorkspace.workspaceId)
  ) {
    throw new Error(`Workspace alias already registered: ${requestedAlias}`);
  }

  const nowIso = now().toISOString();
  let changed = false;
  let created = false;
  let restartRequired = false;
  let nextEntries: RegisteredWorkspace[];
  let finalEntry: RegisteredWorkspace;

  if (!existingWorkspace) {
    created = true;
    finalEntry = {
      workspaceId: configuredWorkspaceId ?? crypto.randomUUID(),
      alias: requestedAlias,
      workspaceRoot: target.workspaceRoot,
      configPath: target.configPath,
      registeredAt: nowIso,
    };
    nextEntries = [...entries, cloneEntry(finalEntry)];
    changed = true;
  } else {
    changed = requestedAlias !== existingWorkspace.alias ||
      target.workspaceRoot !== existingWorkspace.workspaceRoot ||
      target.configPath !== existingWorkspace.configPath;
    restartRequired = changed;
    finalEntry = changed
      ? {
        ...existingWorkspace,
        alias: requestedAlias,
        workspaceRoot: target.workspaceRoot,
        configPath: target.configPath,
        updatedAt: nowIso,
      }
      : cloneEntry(existingWorkspace);
    nextEntries = entries.map((entry) =>
      entry.workspaceId === existingWorkspace.workspaceId
        ? cloneEntry(finalEntry)
        : cloneEntry(entry)
    );
  }

  if (changed) {
    await registryStore.save(nextEntries);
  }
  await ensureWorkspaceConfigWorkspaceId(
    target.configPath,
    finalEntry.workspaceId,
  );

  const runningDaemonRoots = options.runtimeAllowedWriteRoots ??
    sharedConfig.allowedWriteRoots;
  const runningDaemonMayDenyWrites = !isPathWithinRoots(
    finalEntry.workspaceRoot,
    runningDaemonRoots,
  );
  const nextSharedConfig = await ensureWorkspaceRootWriteCoverage(
    sharedConfig,
    sharedConfigStore,
    finalEntry.workspaceRoot,
  );
  const resolvedSharedConfig = nextSharedConfig ?? sharedConfig;
  const sharedWriteRootsUpdated = nextSharedConfig !== undefined;

  await options.operationalLogger?.info(
    created
      ? "workspace.register.created"
      : changed
      ? "workspace.register.updated"
      : "workspace.register.unchanged",
    created
      ? "Registered workspace alias"
      : changed
      ? "Updated registered workspace alias"
      : "Workspace alias already registered",
    {
      workspaceId: finalEntry.workspaceId,
      alias: finalEntry.alias,
      workspaceRoot: finalEntry.workspaceRoot,
      configPath: finalEntry.configPath,
      created,
      changed,
      restartRequired,
      sharedWriteRootsUpdated,
      runningDaemonMayDenyWrites,
    },
  );
  await options.auditLogger?.record(
    "workspace.register",
    "Workspace registration mutation invoked",
    {
      workspaceId: finalEntry.workspaceId,
      alias: finalEntry.alias,
      workspaceRoot: finalEntry.workspaceRoot,
      configPath: finalEntry.configPath,
      created,
      changed,
      restartRequired,
      sharedWriteRootsUpdated,
      runningDaemonMayDenyWrites,
    },
  );

  return {
    entry: finalEntry,
    created,
    changed,
    restartRequired,
    sharedWriteRootsUpdated,
    runningDaemonMayDenyWrites,
    sharedConfig: resolvedSharedConfig,
  };
}

export interface UnregisterWorkspaceMutationOptions {
  selector: string;
  katoDir?: string;
  registryStore?: WorkspaceRegistryStoreLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface UnregisterWorkspaceMutationResult {
  entry: RegisteredWorkspace;
}

export async function unregisterWorkspace(
  options: UnregisterWorkspaceMutationOptions,
): Promise<UnregisterWorkspaceMutationResult> {
  const trimmed = resolveWorkspaceSelector(options.selector);

  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const registryStore = options.registryStore ??
    new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
  const entries = await registryStore.load();
  const match = findWorkspaceBySelector(entries, trimmed);
  if (!match) {
    throw new Error(`Workspace not found: ${trimmed}`);
  }

  const nextEntries = entries.filter((entry) =>
    entry.workspaceId !== match.workspaceId
  );
  await registryStore.save(nextEntries);

  await options.operationalLogger?.info(
    "workspace.unregister",
    "Removed workspace alias from registry",
    {
      workspaceId: match.workspaceId,
      alias: match.alias,
      workspaceRoot: match.workspaceRoot,
    },
  );
  await options.auditLogger?.record(
    "workspace.unregister",
    "Workspace unregister mutation invoked",
    {
      workspaceId: match.workspaceId,
      alias: match.alias,
      workspaceRoot: match.workspaceRoot,
    },
  );

  return { entry: cloneEntry(match) };
}

export interface SetWorkspaceDisplayNameOptions {
  selector: string;
  displayName?: string;
  katoDir?: string;
  now?: () => Date;
  registryStore?: WorkspaceRegistryStoreLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface SetWorkspaceDisplayNameResult {
  entry: RegisteredWorkspace;
  changed: boolean;
}

export async function setWorkspaceDisplayName(
  options: SetWorkspaceDisplayNameOptions,
): Promise<SetWorkspaceDisplayNameResult> {
  const trimmedSelector = resolveWorkspaceSelector(options.selector);
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const now = options.now ?? (() => new Date());
  const registryStore = options.registryStore ??
    new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
  const entries = await registryStore.load();
  const existing = findWorkspaceBySelector(entries, trimmedSelector);
  if (!existing) {
    throw new Error(`Workspace not found: ${trimmedSelector}`);
  }

  const normalizedDisplayName = normalizeWorkspaceDisplayName(
    existing.alias,
    options.displayName,
  );
  const changed = normalizedDisplayName !== existing.displayName;
  const nextEntry = changed
    ? {
      ...existing,
      ...(normalizedDisplayName
        ? { displayName: normalizedDisplayName }
        : { displayName: undefined }),
      updatedAt: now().toISOString(),
    }
    : cloneEntry(existing);

  if (changed) {
    const nextEntries = entries.map((entry) =>
      entry.workspaceId === existing.workspaceId
        ? cloneEntry(nextEntry)
        : cloneEntry(entry)
    );
    await registryStore.save(nextEntries);
  }

  await options.operationalLogger?.info(
    changed
      ? "workspace.display-name.updated"
      : "workspace.display-name.unchanged",
    changed
      ? normalizedDisplayName
        ? "Updated workspace display name"
        : "Cleared workspace display name"
      : "Workspace display name already matches requested value",
    {
      workspaceId: nextEntry.workspaceId,
      alias: nextEntry.alias,
      displayNamePresent: normalizedDisplayName !== undefined,
      changed,
    },
  );
  await options.auditLogger?.record(
    "workspace.display-name.set",
    "Workspace display name mutation invoked",
    {
      workspaceId: nextEntry.workspaceId,
      alias: nextEntry.alias,
      displayNamePresent: normalizedDisplayName !== undefined,
      changed,
    },
  );

  return {
    entry: cloneEntry(nextEntry),
    changed,
  };
}
