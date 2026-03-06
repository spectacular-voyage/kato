import type {
  MarkdownFrontmatterConfig,
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
export const DEFAULT_WORKSPACE_CONFIG_FILENAME = ".kato-workspace-config.yaml";
export const DEFAULT_WORKSPACE_TEMPLATE_CONFIG_FILENAME =
  "default-kato-workspace-config.yaml";
const DEFAULT_SHARED_DIRNAME = "shared";
export const DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE = ".";
export const DEFAULT_WORKSPACE_FILENAME_TEMPLATE =
  "{timestampHumane}-{snippetSlug}-{provider}.md";
export const DEFAULT_WORKSPACE_TIMEZONE = "local";

const FILENAME_TEMPLATE_TOKEN_PATTERN = /\{([A-Za-z0-9]+)\}/g;
const ALLOWED_FILENAME_TEMPLATE_TOKENS = new Set([
  "provider",
  "sessionId",
  "sessionShortId",
  "YYYY",
  "YY",
  "MM",
  "DD",
  "HH",
  "mm",
  "timestampHumane",
  "snippetSlug",
  "username",
]);
const REMOVED_FILENAME_TEMPLATE_TOKENS = new Set([
  "timestampUtc",
  "timestampISO8601",
]);

const WORKSPACE_REGISTRY_SCHEMA_VERSION = 1 as const;
const WRITER_FEATURE_FLAG_KEYS = [
  "writerIncludeCommentary",
  "writerIncludeThinking",
  "writerIncludeToolCalls",
  "writerIncludeToolResults",
  "writerIncludeDecisionPrompt",
  "writerIncludeDecisionOptions",
  "writerIncludeDecisionSelection",
  "writerItalicizeUserMessages",
] as const;
const WORKSPACE_MARKDOWN_FRONTMATTER_KEYS = [
  "includeFrontmatterInMarkdownRecordings",
  "includeUpdatedInFrontmatter",
  "addParticipantUsernameToFrontmatter",
  "addParticipantUsernameToHeadings",
  "includeSessionIds",
  "includeWorkspaceIds",
  "includeRecordingIds",
  "includeConversationEventKinds",
] as const;
const WORKSPACE_CONFIG_TOP_LEVEL_KEYS = [
  "workspaceId",
  "defaultOutputDir",
  "filenameTemplate",
  "workspaceTimezone",
  "markdownFrontmatter",
  "workspaceFeatureFlags",
] as const;
const WORKSPACE_TEMPLATE_TOP_LEVEL_KEYS = [
  "defaultOutputDir",
  "filenameTemplate",
  "workspaceTimezone",
  "markdownFrontmatter",
  "workspaceFeatureFlags",
] as const;

type WriterFeatureFlagKey = typeof WRITER_FEATURE_FLAG_KEYS[number];
type WorkspaceConfigTopLevelKey =
  typeof WORKSPACE_CONFIG_TOP_LEVEL_KEYS[number];
type WorkspaceTemplateTopLevelKey =
  typeof WORKSPACE_TEMPLATE_TOP_LEVEL_KEYS[number];
type WorkspaceMarkdownFrontmatterKey =
  typeof WORKSPACE_MARKDOWN_FRONTMATTER_KEYS[number];

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
  workspaceTimezone?: string;
  markdownFrontmatter?: Partial<MarkdownFrontmatterConfig>;
  writerFeatureFlags: Partial<SessionWorkspaceAttachmentWriterFeatureFlagsV1>;
}

export interface ResolvedWorkspaceProfile {
  workspaceId: string;
  alias: string;
  workspaceRoot: string;
  configPath: string;
  resolvedDefaultOutputDir: string;
  defaultOutputDirTemplate: string;
  filenameTemplate: string;
  workspaceTimezone: string;
  markdownFrontmatter: MarkdownFrontmatterConfig;
  writerFeatureFlags: SessionWorkspaceAttachmentWriterFeatureFlagsV1;
}

export interface WorkspaceProfileResolverLike {
  resolveForCommand(
    workspace: RegisteredWorkspace,
  ): Promise<ResolvedWorkspaceProfile>;
}

export interface EnsureDefaultWorkspaceConfigResult {
  created: boolean;
  path: string;
  config: WorkspaceConfigOverrides;
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
  return join(
    katoDir,
    DEFAULT_SHARED_DIRNAME,
    DEFAULT_WORKSPACE_REGISTRY_FILENAME,
  );
}

export function resolveDefaultWorkspaceTemplateConfigPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(
    katoDir,
    DEFAULT_SHARED_DIRNAME,
    DEFAULT_WORKSPACE_TEMPLATE_CONFIG_FILENAME,
  );
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
      const live = unchanged ? prior : fresh;
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

function validateTemplateTokens(
  template: string,
  configPath: string,
  field: "filenameTemplate" | "defaultOutputDir",
): void {
  for (const match of template.matchAll(FILENAME_TEMPLATE_TOKEN_PATTERN)) {
    const token = match[1];
    if (!token) {
      continue;
    }
    if (ALLOWED_FILENAME_TEMPLATE_TOKENS.has(token)) {
      continue;
    }
    if (REMOVED_FILENAME_TEMPLATE_TOKENS.has(token)) {
      throw new Error(
        `${field} token '{${token}}' is no longer supported: ${configPath}`,
      );
    }
    throw new Error(
      `${field} token '{${token}}' is unsupported: ${configPath}`,
    );
  }
}

function isValidIanaTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

function parseWorkspaceTimezone(
  value: unknown,
  configPath: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = trimOptionalString(value);
  if (!trimmed) {
    throw new Error(
      `workspaceTimezone must be a non-empty string: ${configPath}`,
    );
  }
  if (
    trimmed === DEFAULT_WORKSPACE_TIMEZONE ||
    trimmed === "UTC"
  ) {
    return trimmed;
  }
  if (!isValidIanaTimezone(trimmed)) {
    throw new Error(
      `workspaceTimezone must be \"local\", \"UTC\", or a valid IANA timezone: ${configPath}`,
    );
  }
  return trimmed;
}

export function createDefaultWorkspaceWriterFeatureFlags(
  overrides: Partial<SessionWorkspaceAttachmentWriterFeatureFlagsV1> = {},
): SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  return {
    writerIncludeCommentary: overrides.writerIncludeCommentary ?? true,
    writerIncludeThinking: overrides.writerIncludeThinking ?? true,
    writerIncludeToolCalls: overrides.writerIncludeToolCalls ?? false,
    writerIncludeToolResults: overrides.writerIncludeToolResults ?? false,
    writerIncludeDecisionPrompt: overrides.writerIncludeDecisionPrompt ?? true,
    writerIncludeDecisionOptions: overrides.writerIncludeDecisionOptions ??
      true,
    writerIncludeDecisionSelection: overrides.writerIncludeDecisionSelection ??
      true,
    writerItalicizeUserMessages: overrides.writerItalicizeUserMessages ?? false,
  };
}

export function createDefaultWorkspaceMarkdownFrontmatterConfig(
  overrides: Partial<MarkdownFrontmatterConfig> = {},
): MarkdownFrontmatterConfig {
  return {
    includeFrontmatterInMarkdownRecordings:
      overrides.includeFrontmatterInMarkdownRecordings ?? true,
    includeUpdatedInFrontmatter: overrides.includeUpdatedInFrontmatter ?? false,
    addParticipantUsernameToFrontmatter:
      overrides.addParticipantUsernameToFrontmatter ?? false,
    addParticipantUsernameToHeadings:
      overrides.addParticipantUsernameToHeadings ?? false,
    includeSessionIds: overrides.includeSessionIds ?? true,
    includeWorkspaceIds: overrides.includeWorkspaceIds ?? true,
    includeRecordingIds: overrides.includeRecordingIds ?? true,
    includeConversationEventKinds: overrides.includeConversationEventKinds ??
      false,
  };
}

function resolveWriterFeatureFlags(
  overrides: WorkspaceConfigOverrides,
): SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  return createDefaultWorkspaceWriterFeatureFlags(overrides.writerFeatureFlags);
}

function resolveWorkspaceMarkdownFrontmatter(
  overrides: WorkspaceConfigOverrides,
): MarkdownFrontmatterConfig {
  return createDefaultWorkspaceMarkdownFrontmatterConfig(
    overrides.markdownFrontmatter,
  );
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
  return await loadWorkspaceConfigLikeOverrides(configPath, {
    ...options,
    allowWorkspaceId: true,
  });
}

export async function loadDefaultWorkspaceConfigOverrides(
  configPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<WorkspaceConfigOverrides> {
  return await loadWorkspaceConfigLikeOverrides(configPath, {
    ...options,
    allowWorkspaceId: false,
  });
}

async function loadWorkspaceConfigLikeOverrides(
  configPath: string,
  options: { allowMissing?: boolean; allowWorkspaceId: boolean },
): Promise<WorkspaceConfigOverrides> {
  const parsed = await readWorkspaceConfigDocument(configPath, options);
  if (!parsed) {
    return { writerFeatureFlags: {} };
  }

  for (const key of Object.keys(parsed)) {
    const isAllowed = options.allowWorkspaceId
      ? WORKSPACE_CONFIG_TOP_LEVEL_KEYS.includes(
        key as WorkspaceConfigTopLevelKey,
      )
      : WORKSPACE_TEMPLATE_TOP_LEVEL_KEYS.includes(
        key as WorkspaceTemplateTopLevelKey,
      );
    if (!isAllowed) {
      throw new Error(
        `Unsupported workspace config key '${key}': ${configPath}`,
      );
    }
  }

  if (!options.allowWorkspaceId && parsed["workspaceId"] !== undefined) {
    throw new Error(
      `workspaceId is not allowed in default workspace config: ${configPath}`,
    );
  }
  if (
    options.allowWorkspaceId &&
    parsed["workspaceId"] !== undefined &&
    trimOptionalString(parsed["workspaceId"]) === undefined
  ) {
    throw new Error(`workspaceId must be a non-empty string: ${configPath}`);
  }

  const defaultOutputDirRaw = parsed["defaultOutputDir"];
  const defaultOutputDir = trimOptionalString(defaultOutputDirRaw);
  if (
    defaultOutputDirRaw !== undefined &&
    defaultOutputDir === undefined
  ) {
    throw new Error(
      `defaultOutputDir must be a non-empty string: ${configPath}`,
    );
  }
  if (defaultOutputDir) {
    validateTemplateTokens(defaultOutputDir, configPath, "defaultOutputDir");
  }

  const filenameTemplateRaw = parsed["filenameTemplate"];
  const filenameTemplate = trimOptionalString(filenameTemplateRaw);
  if (filenameTemplateRaw !== undefined && filenameTemplate === undefined) {
    throw new Error(
      `filenameTemplate must be a non-empty string: ${configPath}`,
    );
  }
  if (filenameTemplate) {
    validateTemplateTokens(filenameTemplate, configPath, "filenameTemplate");
  }

  const workspaceTimezone = parseWorkspaceTimezone(
    parsed["workspaceTimezone"],
    configPath,
  );

  const markdownFrontmatter = parseWorkspaceMarkdownFrontmatter(
    parsed["markdownFrontmatter"],
    configPath,
  );
  const writerFeatureFlags = parseWorkspaceWriterFeatureFlags(
    parsed["workspaceFeatureFlags"],
    configPath,
  );

  return {
    ...(defaultOutputDir ? { defaultOutputDir } : {}),
    ...(filenameTemplate ? { filenameTemplate } : {}),
    ...(workspaceTimezone ? { workspaceTimezone } : {}),
    ...(markdownFrontmatter ? { markdownFrontmatter } : {}),
    writerFeatureFlags,
  };
}

function parseWorkspaceMarkdownFrontmatter(
  value: unknown,
  configPath: string,
): Partial<MarkdownFrontmatterConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(
      `markdownFrontmatter must be an object when present: ${configPath}`,
    );
  }

  for (const key of Object.keys(value)) {
    if (
      !WORKSPACE_MARKDOWN_FRONTMATTER_KEYS.includes(
        key as WorkspaceMarkdownFrontmatterKey,
      )
    ) {
      throw new Error(
        `Unsupported markdownFrontmatter key '${key}': ${configPath}`,
      );
    }
  }

  const overrides: Partial<MarkdownFrontmatterConfig> = {};
  for (const key of WORKSPACE_MARKDOWN_FRONTMATTER_KEYS) {
    const rawValue = value[key];
    if (rawValue === undefined) {
      continue;
    }
    if (typeof rawValue !== "boolean") {
      throw new Error(
        `markdownFrontmatter.${key} must be a boolean: ${configPath}`,
      );
    }
    overrides[key] = rawValue;
  }
  return overrides;
}

function parseWorkspaceWriterFeatureFlags(
  value: unknown,
  configPath: string,
): Partial<SessionWorkspaceAttachmentWriterFeatureFlagsV1> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(
      `workspaceFeatureFlags must be an object when present: ${configPath}`,
    );
  }

  for (const key of Object.keys(value)) {
    if (!WRITER_FEATURE_FLAG_KEYS.includes(key as WriterFeatureFlagKey)) {
      throw new Error(
        `Unsupported workspaceFeatureFlags key '${key}': ${configPath}`,
      );
    }
  }

  const writerFeatureFlags: Partial<
    SessionWorkspaceAttachmentWriterFeatureFlagsV1
  > = {};
  for (const key of WRITER_FEATURE_FLAG_KEYS) {
    const rawValue = value[key];
    if (rawValue === undefined) {
      continue;
    }
    if (typeof rawValue !== "boolean") {
      throw new Error(
        `workspaceFeatureFlags.${key} must be a boolean: ${configPath}`,
      );
    }
    writerFeatureFlags[key] = rawValue;
  }
  return writerFeatureFlags;
}

export class WorkspaceProfileResolver implements WorkspaceProfileResolverLike {
  private readonly cache = new Map<string, WorkspaceProfileCacheEntry>();

  async resolveForCommand(
    workspace: RegisteredWorkspace,
  ): Promise<ResolvedWorkspaceProfile> {
    const resolvedWorkspaceRoot = resolve(workspace.workspaceRoot);
    const sourceMtimeMs = await this.readMtime(workspace.configPath);
    const cached = this.cache.get(workspace.workspaceId);
    if (
      cached &&
      cached.configPath === workspace.configPath &&
      cached.profile.alias === workspace.alias &&
      cached.profile.workspaceRoot === resolvedWorkspaceRoot &&
      cached.sourceMtimeMs === sourceMtimeMs
    ) {
      return {
        ...cached.profile,
        markdownFrontmatter: { ...cached.profile.markdownFrontmatter },
        writerFeatureFlags: { ...cached.profile.writerFeatureFlags },
      };
    }

    const overrides = await loadWorkspaceConfigOverrides(workspace.configPath);
    const defaultOutputDirTemplate = overrides.defaultOutputDir ??
      DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE;
    const resolvedDefaultOutputDir = isAbsolute(defaultOutputDirTemplate)
      ? resolve(defaultOutputDirTemplate)
      : resolve(resolvedWorkspaceRoot, defaultOutputDirTemplate);
    const profile: ResolvedWorkspaceProfile = {
      workspaceId: workspace.workspaceId,
      alias: workspace.alias,
      workspaceRoot: resolvedWorkspaceRoot,
      configPath: workspace.configPath,
      resolvedDefaultOutputDir,
      defaultOutputDirTemplate,
      filenameTemplate: overrides.filenameTemplate ??
        DEFAULT_WORKSPACE_FILENAME_TEMPLATE,
      workspaceTimezone: overrides.workspaceTimezone ??
        DEFAULT_WORKSPACE_TIMEZONE,
      markdownFrontmatter: resolveWorkspaceMarkdownFrontmatter(overrides),
      writerFeatureFlags: resolveWriterFeatureFlags(overrides),
    };
    this.cache.set(workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      configPath: workspace.configPath,
      sourceMtimeMs,
      loadedAt: new Date().toISOString(),
      profile: {
        ...profile,
        markdownFrontmatter: { ...profile.markdownFrontmatter },
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

export class DefaultWorkspaceConfigFileStore {
  constructor(private readonly configPath: string) {}

  async load(
    options: { allowMissing?: boolean } = {},
  ): Promise<WorkspaceConfigOverrides | undefined> {
    const loaded = await loadDefaultWorkspaceConfigOverrides(
      this.configPath,
      options,
    );
    if (
      options.allowMissing &&
      loaded.defaultOutputDir === undefined &&
      loaded.filenameTemplate === undefined &&
      loaded.workspaceTimezone === undefined &&
      loaded.markdownFrontmatter === undefined &&
      Object.keys(loaded.writerFeatureFlags).length === 0
    ) {
      try {
        await Deno.stat(this.configPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return undefined;
        }
        throw error;
      }
    }
    return loaded;
  }

  async ensureInitialized(): Promise<EnsureDefaultWorkspaceConfigResult> {
    try {
      const loaded = await loadDefaultWorkspaceConfigOverrides(this.configPath);
      return {
        created: false,
        path: this.configPath,
        config: loaded,
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    await writeTextAtomically(this.configPath, createWorkspaceConfigScaffold());
    return {
      created: true,
      path: this.configPath,
      config: await loadDefaultWorkspaceConfigOverrides(this.configPath),
    };
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
    `workspaceTimezone: "${DEFAULT_WORKSPACE_TIMEZONE}"`,
    "markdownFrontmatter:",
    "  includeFrontmatterInMarkdownRecordings: true",
    "  includeUpdatedInFrontmatter: false",
    "  addParticipantUsernameToFrontmatter: false",
    "  addParticipantUsernameToHeadings: false",
    "  includeSessionIds: true",
    "  includeWorkspaceIds: true",
    "  includeRecordingIds: true",
    "  includeConversationEventKinds: false",
    "workspaceFeatureFlags:",
    "  writerIncludeCommentary: true",
    "  writerIncludeThinking: true",
    "  writerIncludeToolCalls: false",
    "  writerIncludeToolResults: false",
    "  writerIncludeDecisionPrompt: true",
    "  writerIncludeDecisionOptions: true",
    "  writerIncludeDecisionSelection: true",
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
