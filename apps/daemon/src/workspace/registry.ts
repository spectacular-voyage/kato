import type {
  RuntimeFeatureFlags,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
} from "@kato/shared";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";

export const DEFAULT_WORKSPACE_REGISTRY_FILENAME = "workspace-registry.json";
export const DEFAULT_WORKSPACE_CONFIG_FILENAME = "kato-workspace-config.yaml";
export const DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE = ".";
export const DEFAULT_WORKSPACE_FILENAME_TEMPLATE =
  "{provider}-{sessionShortId}-{timestampUtc}.md";

const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1 as const;
const WRITER_FEATURE_FLAG_KEYS = [
  "writerIncludeCommentary",
  "writerIncludeThinking",
  "writerIncludeToolCalls",
  "writerItalicizeUserMessages",
] as const;

type WriterFeatureFlagKey = typeof WRITER_FEATURE_FLAG_KEYS[number];

export interface RegisteredWorkspace {
  workspaceId: string;
  alias: string;
  workspaceRoot: string;
  configPath: string;
  registeredAt: string;
  updatedAt?: string;
}

interface WorkspaceRegistryFileV1 {
  schemaVersion: typeof WORKSPACE_REGISTRY_SCHEMA_VERSION;
  updatedAt: string;
  workspaces: RegisteredWorkspace[];
}

export interface WorkspaceRegistryStoreLike {
  load(): Promise<RegisteredWorkspace[]>;
  save(entries: RegisteredWorkspace[]): Promise<void>;
  statMtimeMs(): Promise<number | undefined>;
}

export interface WorkspaceCatalogLike {
  getByAlias(alias: string): Promise<RegisteredWorkspace | undefined>;
  getByWorkspaceId(
    workspaceId: string,
  ): Promise<RegisteredWorkspace | undefined>;
  list(): Promise<RegisteredWorkspace[]>;
  refreshIfChanged(): Promise<void>;
}

export interface WorkspaceConfigOverrides {
  defaultOutputDir?: string;
  filenameTemplate?: string;
  writerFeatureFlags: Partial<SessionWorkspaceAttachmentWriterFeatureFlagsV1>;
}

export interface ResolvedWorkspaceProfile {
  workspaceId: string;
  alias: string;
  workspaceRoot: string;
  configPath: string;
  resolvedDefaultOutputDir: string;
  filenameTemplate: string;
  writerFeatureFlags: SessionWorkspaceAttachmentWriterFeatureFlagsV1;
}

export interface WorkspaceProfileResolverLike {
  resolveForCommand(
    workspace: RegisteredWorkspace,
    runtimeFeatureFlags: RuntimeFeatureFlags,
  ): Promise<ResolvedWorkspaceProfile>;
}

interface WorkspaceCatalogSnapshot {
  loadedAt: string;
  sourceMtimeMs?: number;
  byAlias: Map<string, RegisteredWorkspace>;
  byWorkspaceId: Map<string, RegisteredWorkspace>;
}

interface WorkspaceProfileCacheEntry {
  workspaceId: string;
  configPath: string;
  sourceMtimeMs?: number;
  loadedAt: string;
  profile: ResolvedWorkspaceProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneWorkspace(entry: RegisteredWorkspace): RegisteredWorkspace {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    registeredAt: entry.registeredAt,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

function isRegisteredWorkspace(value: unknown): value is RegisteredWorkspace {
  return isRecord(value) &&
    isNonEmptyString(value["workspaceId"]) &&
    isNonEmptyString(value["alias"]) &&
    isNonEmptyString(value["workspaceRoot"]) &&
    isNonEmptyString(value["configPath"]) &&
    isNonEmptyString(value["registeredAt"]) &&
    (value["updatedAt"] === undefined || isNonEmptyString(value["updatedAt"]));
}

function isWorkspaceRegistryFile(
  value: unknown,
): value is WorkspaceRegistryFileV1 {
  return isRecord(value) &&
    value["schemaVersion"] === WORKSPACE_REGISTRY_SCHEMA_VERSION &&
    isNonEmptyString(value["updatedAt"]) &&
    Array.isArray(value["workspaces"]) &&
    value["workspaces"].every((entry) => isRegisteredWorkspace(entry));
}

async function writeTextAtomically(
  path: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tempPath, content);
  await Deno.rename(tempPath, path);
}

export function resolveDefaultWorkspaceRegistryPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, DEFAULT_WORKSPACE_REGISTRY_FILENAME);
}

export class WorkspaceRegistryFileStore implements WorkspaceRegistryStoreLike {
  constructor(private readonly path: string) {}

  async load(): Promise<RegisteredWorkspace[]> {
    try {
      const raw = await Deno.readTextFile(this.path);
      const parsed = JSON.parse(raw) as unknown;
      if (!isWorkspaceRegistryFile(parsed)) {
        throw new Error("Workspace registry has unsupported schema");
      }
      return parsed.workspaces.map(cloneWorkspace);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
  }

  async save(entries: RegisteredWorkspace[]): Promise<void> {
    const nowIso = new Date().toISOString();
    const payload: WorkspaceRegistryFileV1 = {
      schemaVersion: WORKSPACE_REGISTRY_SCHEMA_VERSION,
      updatedAt: nowIso,
      workspaces: entries.map(cloneWorkspace),
    };
    await writeTextAtomically(
      this.path,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }

  async statMtimeMs(): Promise<number | undefined> {
    try {
      const stat = await Deno.stat(this.path);
      return stat.mtime?.getTime();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined;
      }
      throw error;
    }
  }
}

export class WorkspaceCatalog implements WorkspaceCatalogLike {
  private snapshot: WorkspaceCatalogSnapshot | undefined;

  constructor(private readonly store: WorkspaceRegistryStoreLike) {}

  async refreshIfChanged(): Promise<void> {
    const nextMtime = await this.store.statMtimeMs();
    if (
      this.snapshot &&
      this.snapshot.sourceMtimeMs === nextMtime
    ) {
      return;
    }

    const loaded = await this.store.load();
    if (!this.snapshot) {
      this.snapshot = {
        loadedAt: new Date().toISOString(),
        sourceMtimeMs: nextMtime,
        byAlias: new Map(
          loaded.map((entry) => [entry.alias, cloneWorkspace(entry)]),
        ),
        byWorkspaceId: new Map(
          loaded.map((entry) => [entry.workspaceId, cloneWorkspace(entry)]),
        ),
      };
      return;
    }

    const priorByWorkspaceId = this.snapshot.byWorkspaceId;
    const nextByWorkspaceId = new Map<string, RegisteredWorkspace>();
    const nextByAlias = new Map<string, RegisteredWorkspace>();
    const loadedByWorkspaceId = new Map(
      loaded.map((entry) => [entry.workspaceId, cloneWorkspace(entry)]),
    );

    for (const [workspaceId, prior] of priorByWorkspaceId.entries()) {
      const fresh = loadedByWorkspaceId.get(workspaceId);
      if (!fresh) {
        continue;
      }
      const unchanged = fresh.alias === prior.alias &&
        fresh.workspaceRoot === prior.workspaceRoot &&
        fresh.configPath === prior.configPath;
      const live = unchanged ? fresh : prior;
      nextByWorkspaceId.set(workspaceId, cloneWorkspace(live));
      nextByAlias.set(live.alias, cloneWorkspace(live));
    }

    for (const fresh of loaded) {
      if (nextByWorkspaceId.has(fresh.workspaceId)) {
        continue;
      }
      nextByWorkspaceId.set(fresh.workspaceId, cloneWorkspace(fresh));
      nextByAlias.set(fresh.alias, cloneWorkspace(fresh));
    }

    this.snapshot = {
      loadedAt: new Date().toISOString(),
      sourceMtimeMs: nextMtime,
      byAlias: nextByAlias,
      byWorkspaceId: nextByWorkspaceId,
    };
  }

  async getByAlias(alias: string): Promise<RegisteredWorkspace | undefined> {
    await this.refreshIfChanged();
    const entry = this.snapshot?.byAlias.get(alias);
    return entry ? cloneWorkspace(entry) : undefined;
  }

  async getByWorkspaceId(
    workspaceId: string,
  ): Promise<RegisteredWorkspace | undefined> {
    await this.refreshIfChanged();
    const entry = this.snapshot?.byWorkspaceId.get(workspaceId);
    return entry ? cloneWorkspace(entry) : undefined;
  }

  async list(): Promise<RegisteredWorkspace[]> {
    await this.refreshIfChanged();
    if (!this.snapshot) {
      return [];
    }
    return Array.from(this.snapshot.byWorkspaceId.values()).map(cloneWorkspace);
  }
}

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveWriterFeatureFlags(
  runtimeFeatureFlags: RuntimeFeatureFlags,
  overrides: WorkspaceConfigOverrides,
): SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  return {
    writerIncludeCommentary:
      overrides.writerFeatureFlags.writerIncludeCommentary ??
        runtimeFeatureFlags.writerIncludeCommentary,
    writerIncludeThinking: overrides.writerFeatureFlags.writerIncludeThinking ??
      runtimeFeatureFlags.writerIncludeThinking,
    writerIncludeToolCalls:
      overrides.writerFeatureFlags.writerIncludeToolCalls ??
        runtimeFeatureFlags.writerIncludeToolCalls,
    writerItalicizeUserMessages:
      overrides.writerFeatureFlags.writerItalicizeUserMessages ??
        runtimeFeatureFlags.writerItalicizeUserMessages,
  };
}

async function readWorkspaceConfigDocument(
  configPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(configPath);
  } catch (error) {
    if (options.allowMissing && error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new Error(`Config file contains invalid YAML: ${configPath}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Config file must contain a YAML object: ${configPath}`);
  }

  return parsed;
}

export async function readWorkspaceConfigWorkspaceId(
  configPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<string | undefined> {
  const parsed = await readWorkspaceConfigDocument(configPath, options);
  if (!parsed) {
    return undefined;
  }
  return trimOptionalString(parsed["workspaceId"]);
}

export async function ensureWorkspaceConfigWorkspaceId(
  configPath: string,
  workspaceId: string,
): Promise<void> {
  const existingWorkspaceId = await readWorkspaceConfigWorkspaceId(configPath, {
    allowMissing: true,
  });
  if (existingWorkspaceId === workspaceId) {
    return;
  }
  if (existingWorkspaceId && existingWorkspaceId !== workspaceId) {
    throw new Error(
      `Workspace config already declares a different workspaceId: ${configPath}`,
    );
  }

  const raw = await Deno.readTextFile(configPath);
  await writeTextAtomically(configPath, `workspaceId: ${workspaceId}\n${raw}`);
}

export async function loadWorkspaceConfigOverrides(
  configPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<WorkspaceConfigOverrides> {
  const parsed = await readWorkspaceConfigDocument(configPath, options);
  if (!parsed) {
    return { writerFeatureFlags: {} };
  }

  const defaultOutputDirRaw = parsed["defaultOutputDir"];
  if (
    defaultOutputDirRaw !== undefined &&
    trimOptionalString(defaultOutputDirRaw) === undefined
  ) {
    throw new Error(
      `defaultOutputDir must be a non-empty string: ${configPath}`,
    );
  }

  const filenameTemplateRaw = parsed["filenameTemplate"];
  if (
    filenameTemplateRaw !== undefined &&
    trimOptionalString(filenameTemplateRaw) === undefined
  ) {
    throw new Error(
      `filenameTemplate must be a non-empty string: ${configPath}`,
    );
  }

  const writerFeatureFlags: Partial<
    SessionWorkspaceAttachmentWriterFeatureFlagsV1
  > = {};
  const rawFeatureFlags = parsed["featureFlags"];
  if (rawFeatureFlags !== undefined) {
    if (!isRecord(rawFeatureFlags)) {
      throw new Error(
        `featureFlags must be an object when present: ${configPath}`,
      );
    }
    for (const key of WRITER_FEATURE_FLAG_KEYS) {
      const rawValue = rawFeatureFlags[key];
      if (rawValue === undefined) {
        continue;
      }
      if (typeof rawValue !== "boolean") {
        throw new Error(`featureFlags.${key} must be a boolean: ${configPath}`);
      }
      writerFeatureFlags[key] = rawValue;
    }
  }

  return {
    ...(trimOptionalString(defaultOutputDirRaw)
      ? { defaultOutputDir: trimOptionalString(defaultOutputDirRaw) }
      : {}),
    ...(trimOptionalString(filenameTemplateRaw)
      ? { filenameTemplate: trimOptionalString(filenameTemplateRaw) }
      : {}),
    writerFeatureFlags,
  };
}

export class WorkspaceProfileResolver implements WorkspaceProfileResolverLike {
  private readonly cache = new Map<string, WorkspaceProfileCacheEntry>();

  async resolveForCommand(
    workspace: RegisteredWorkspace,
    runtimeFeatureFlags: RuntimeFeatureFlags,
  ): Promise<ResolvedWorkspaceProfile> {
    const sourceMtimeMs = await this.readMtime(workspace.configPath);
    const cached = this.cache.get(workspace.workspaceId);
    if (
      cached &&
      cached.configPath === workspace.configPath &&
      cached.sourceMtimeMs === sourceMtimeMs
    ) {
      return {
        ...cached.profile,
        writerFeatureFlags: { ...cached.profile.writerFeatureFlags },
      };
    }

    const overrides = await loadWorkspaceConfigOverrides(workspace.configPath);
    const defaultOutputDir = overrides.defaultOutputDir ??
      DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE;
    const resolvedDefaultOutputDir = isAbsolute(defaultOutputDir)
      ? resolve(defaultOutputDir)
      : resolve(workspace.workspaceRoot, defaultOutputDir);
    const profile: ResolvedWorkspaceProfile = {
      workspaceId: workspace.workspaceId,
      alias: workspace.alias,
      workspaceRoot: resolve(workspace.workspaceRoot),
      configPath: workspace.configPath,
      resolvedDefaultOutputDir,
      filenameTemplate: overrides.filenameTemplate ??
        DEFAULT_WORKSPACE_FILENAME_TEMPLATE,
      writerFeatureFlags: resolveWriterFeatureFlags(
        runtimeFeatureFlags,
        overrides,
      ),
    };
    this.cache.set(workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      configPath: workspace.configPath,
      sourceMtimeMs,
      loadedAt: new Date().toISOString(),
      profile: {
        ...profile,
        writerFeatureFlags: { ...profile.writerFeatureFlags },
      },
    });
    return profile;
  }

  private async readMtime(path: string): Promise<number | undefined> {
    try {
      const stat = await Deno.stat(path);
      return stat.mtime?.getTime();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined;
      }
      throw error;
    }
  }
}

export async function resolveWorkspaceConfigPath(
  workspaceRoot: string,
): Promise<string | undefined> {
  const path = join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME);
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) {
      return path;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return undefined;
}

export async function findNearestWorkspaceConfig(
  startDir: string,
): Promise<{ workspaceRoot: string; configPath: string } | undefined> {
  let cursor = resolve(startDir);
  while (true) {
    const configPath = await resolveWorkspaceConfigPath(cursor);
    if (configPath) {
      return { workspaceRoot: cursor, configPath };
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

export function createWorkspaceConfigScaffold(): string {
  return [
    `defaultOutputDir: "${DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE}"`,
    `filenameTemplate: "${DEFAULT_WORKSPACE_FILENAME_TEMPLATE}"`,
    "featureFlags:",
    "  writerIncludeCommentary: true",
    "  writerIncludeThinking: true",
    "  writerIncludeToolCalls: true",
    "  writerItalicizeUserMessages: false",
    "",
  ].join("\n");
}

export function isPathWithinRoots(
  candidatePath: string,
  roots: string[],
): boolean {
  const resolvedCandidate = resolve(candidatePath);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolvedCandidate);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

export function defaultAliasForWorkspaceRoot(workspaceRoot: string): string {
  return basename(resolve(workspaceRoot));
}
