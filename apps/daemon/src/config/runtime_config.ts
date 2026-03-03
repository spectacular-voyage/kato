import type {
  DaemonFeatureFlags,
  ExportFeatureFlags,
  MarkdownFrontmatterConfig,
  ProviderAutoGenerateSnapshots,
  ProviderSessionRoots,
  RuntimeConfig,
  RuntimeLoggingConfig,
  RuntimeLogLevel,
} from "@kato/shared";
import { dirname, isAbsolute, join, relative } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  createDefaultDaemonFeatureFlags,
  mergeDaemonFeatureFlags,
} from "../feature_flags/mod.ts";
import {
  expandHomePath,
  readOptionalEnv,
  resolveHomeDir,
} from "../utils/env.ts";

const DEFAULT_CONFIG_SCHEMA_VERSION = 1;
const CONFIG_FILENAME = "kato-daemon-config.yaml";
const DEFAULT_DAEMON_MAX_MEMORY_MB = 500;
const DEFAULT_EXPORT_TIMEZONE = "local";
const RUNTIME_LOG_LEVELS: RuntimeLogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
];
const RUNTIME_LOGGING_CONFIG_KEYS: Array<keyof RuntimeLoggingConfig> = [
  "operationalLevel",
  "auditLevel",
];
const MARKDOWN_FRONTMATTER_KEYS: Array<keyof MarkdownFrontmatterConfig> = [
  "includeFrontmatterInMarkdownRecordings",
  "includeUpdatedInFrontmatter",
  "addParticipantUsernameToFrontmatter",
  "includeSessionIds",
  "includeWorkspaceIds",
  "includeRecordingIds",
  "includeConversationEventKinds",
];
const RUNTIME_CONFIG_KEYS: Array<keyof RuntimeConfig> = [
  "schemaVersion",
  "runtimeDir",
  "katoDir",
  "statusPath",
  "controlPath",
  "allowedWriteRoots",
  "exportTimezone",
  "providerSessionRoots",
  "globalAutoGenerateSnapshots",
  "providerAutoGenerateSnapshots",
  "cleanSessionStatesOnShutdown",
  "daemonFeatureFlags",
  "exportMarkdownFrontmatter",
  "exportFeatureFlags",
  "logging",
  "daemonMaxMemoryMb",
];

export interface EnsureRuntimeConfigResult {
  created: boolean;
  config: RuntimeConfig;
  path: string;
}

export interface RuntimeConfigStoreLike {
  load(): Promise<RuntimeConfig>;
  ensureInitialized(
    defaultConfig: RuntimeConfig,
  ): Promise<EnsureRuntimeConfigResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DAEMON_FEATURE_FLAG_KEYS: Array<keyof DaemonFeatureFlags> = [
  "daemonExportEnabled",
  "captureIncludeSystemEvents",
];
const EXPORT_FEATURE_FLAG_KEYS: Array<keyof ExportFeatureFlags> = [
  "writerIncludeCommentary",
  "writerIncludeThinking",
  "writerIncludeToolCalls",
  "writerIncludeToolResults",
  "writerIncludeDecisionPrompt",
  "writerIncludeDecisionOptions",
  "writerIncludeDecisionSelection",
  "writerItalicizeUserMessages",
];
const PROVIDER_SESSION_ROOT_KEYS: Array<keyof ProviderSessionRoots> = [
  "claude",
  "codex",
  "gemini",
];
const PROVIDER_AUTO_SNAPSHOT_KEYS: Array<keyof ProviderAutoGenerateSnapshots> =
  [
    "claude",
    "codex",
    "gemini",
  ];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isYamlConfigPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(".yaml");
}

function parseDaemonFeatureFlags(
  value: unknown,
): DaemonFeatureFlags | undefined {
  if (value === undefined) {
    return createDefaultDaemonFeatureFlags();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!DAEMON_FEATURE_FLAG_KEYS.includes(key as keyof DaemonFeatureFlags)) {
      return undefined;
    }
  }

  const merged = mergeDaemonFeatureFlags();
  for (const key of DAEMON_FEATURE_FLAG_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "boolean") {
      return undefined;
    }
    merged[key] = candidate;
  }

  return merged;
}

export function createDefaultExportFeatureFlags(
  overrides?: Partial<ExportFeatureFlags>,
): ExportFeatureFlags {
  const defaults: ExportFeatureFlags = {
    writerIncludeCommentary: true,
    writerIncludeThinking: false,
    writerIncludeToolCalls: false,
    writerIncludeToolResults: false,
    writerIncludeDecisionPrompt: true,
    writerIncludeDecisionOptions: true,
    writerIncludeDecisionSelection: true,
    writerItalicizeUserMessages: false,
  };
  if (!overrides) {
    return defaults;
  }

  return {
    writerIncludeCommentary: overrides.writerIncludeCommentary ??
      defaults.writerIncludeCommentary,
    writerIncludeThinking: overrides.writerIncludeThinking ??
      defaults.writerIncludeThinking,
    writerIncludeToolCalls: overrides.writerIncludeToolCalls ??
      defaults.writerIncludeToolCalls,
    writerIncludeToolResults: overrides.writerIncludeToolResults ??
      defaults.writerIncludeToolResults,
    writerIncludeDecisionPrompt: overrides.writerIncludeDecisionPrompt ??
      defaults.writerIncludeDecisionPrompt,
    writerIncludeDecisionOptions: overrides.writerIncludeDecisionOptions ??
      defaults.writerIncludeDecisionOptions,
    writerIncludeDecisionSelection: overrides.writerIncludeDecisionSelection ??
      defaults.writerIncludeDecisionSelection,
    writerItalicizeUserMessages: overrides.writerItalicizeUserMessages ??
      defaults.writerItalicizeUserMessages,
  };
}

function parseExportFeatureFlags(
  value: unknown,
): ExportFeatureFlags | undefined {
  if (value === undefined) {
    return createDefaultExportFeatureFlags();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!EXPORT_FEATURE_FLAG_KEYS.includes(key as keyof ExportFeatureFlags)) {
      return undefined;
    }
  }

  const merged = createDefaultExportFeatureFlags();
  for (const key of EXPORT_FEATURE_FLAG_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "boolean") {
      return undefined;
    }
    merged[key] = candidate;
  }

  return merged;
}

function isRuntimeLogLevel(value: unknown): value is RuntimeLogLevel {
  return typeof value === "string" &&
    RUNTIME_LOG_LEVELS.includes(value as RuntimeLogLevel);
}

function normalizeRuntimeLogLevel(
  value: string,
): RuntimeLogLevel | undefined {
  const normalized = value.trim().toLowerCase();
  return isRuntimeLogLevel(normalized) ? normalized : undefined;
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

function parseExportTimezone(value: unknown): string | undefined {
  if (value === undefined) {
    return DEFAULT_EXPORT_TIMEZONE;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed === DEFAULT_EXPORT_TIMEZONE || trimmed === "UTC") {
    return trimmed;
  }
  if (!isValidIanaTimezone(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function createDefaultRuntimeLoggingConfig(
  overrides?: Partial<RuntimeLoggingConfig>,
): RuntimeLoggingConfig {
  const defaults: RuntimeLoggingConfig = {
    operationalLevel: "info",
    auditLevel: "info",
  };
  if (!overrides) {
    return defaults;
  }

  return {
    operationalLevel: overrides.operationalLevel ?? defaults.operationalLevel,
    auditLevel: overrides.auditLevel ?? defaults.auditLevel,
  };
}

export function createDefaultRuntimeMarkdownFrontmatterConfig(
  overrides?: Partial<MarkdownFrontmatterConfig>,
): MarkdownFrontmatterConfig {
  const defaults: MarkdownFrontmatterConfig = {
    includeFrontmatterInMarkdownRecordings: true,
    includeUpdatedInFrontmatter: false,
    addParticipantUsernameToFrontmatter: false,
    includeSessionIds: true,
    includeWorkspaceIds: true,
    includeRecordingIds: true,
    includeConversationEventKinds: false,
  };
  if (!overrides) {
    return defaults;
  }

  return {
    includeFrontmatterInMarkdownRecordings:
      overrides.includeFrontmatterInMarkdownRecordings ??
        defaults.includeFrontmatterInMarkdownRecordings,
    includeUpdatedInFrontmatter: overrides.includeUpdatedInFrontmatter ??
      defaults.includeUpdatedInFrontmatter,
    addParticipantUsernameToFrontmatter:
      overrides.addParticipantUsernameToFrontmatter ??
        defaults.addParticipantUsernameToFrontmatter,
    includeSessionIds: overrides.includeSessionIds ??
      defaults.includeSessionIds,
    includeWorkspaceIds: overrides.includeWorkspaceIds ??
      defaults.includeWorkspaceIds,
    includeRecordingIds: overrides.includeRecordingIds ??
      defaults.includeRecordingIds,
    includeConversationEventKinds: overrides.includeConversationEventKinds ??
      defaults.includeConversationEventKinds,
  };
}

function parseRuntimeLoggingConfig(
  value: unknown,
): RuntimeLoggingConfig | undefined {
  if (value === undefined) {
    return createDefaultRuntimeLoggingConfig();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (
      !RUNTIME_LOGGING_CONFIG_KEYS.includes(key as keyof RuntimeLoggingConfig)
    ) {
      return undefined;
    }
  }

  const resolved = createDefaultRuntimeLoggingConfig();
  for (const key of RUNTIME_LOGGING_CONFIG_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "string") {
      return undefined;
    }
    const level = normalizeRuntimeLogLevel(candidate);
    if (!level) {
      return undefined;
    }
    resolved[key] = level;
  }

  return resolved;
}

function parseRuntimeMarkdownFrontmatterConfig(
  value: unknown,
): MarkdownFrontmatterConfig | undefined {
  if (value === undefined) {
    return createDefaultRuntimeMarkdownFrontmatterConfig();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (
      !MARKDOWN_FRONTMATTER_KEYS.includes(
        key as keyof MarkdownFrontmatterConfig,
      )
    ) {
      return undefined;
    }
  }

  const resolved = createDefaultRuntimeMarkdownFrontmatterConfig();
  for (const key of MARKDOWN_FRONTMATTER_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (key === "includeFrontmatterInMarkdownRecordings") {
      if (typeof candidate !== "boolean") {
        return undefined;
      }
      resolved.includeFrontmatterInMarkdownRecordings = candidate;
    } else if (key === "includeUpdatedInFrontmatter") {
      if (typeof candidate !== "boolean") {
        return undefined;
      }
      resolved.includeUpdatedInFrontmatter = candidate;
    } else if (key === "addParticipantUsernameToFrontmatter") {
      if (typeof candidate !== "boolean") {
        return undefined;
      }
      resolved.addParticipantUsernameToFrontmatter = candidate;
    } else if (key === "includeSessionIds") {
      if (typeof candidate !== "boolean") {
        return undefined;
      }
      resolved.includeSessionIds = candidate;
    } else if (key === "includeWorkspaceIds") {
      if (typeof candidate !== "boolean") {
        return undefined;
      }
      resolved.includeWorkspaceIds = candidate;
    } else if (key === "includeRecordingIds") {
      if (typeof candidate !== "boolean") {
        return undefined;
      }
      resolved.includeRecordingIds = candidate;
    } else if (key === "includeConversationEventKinds") {
      if (typeof candidate !== "boolean") {
        return undefined;
      }
      resolved.includeConversationEventKinds = candidate;
    }
  }

  return resolved;
}

function collapseHome(path: string): string {
  const home = resolveHomeDir();
  if (!home) {
    return path;
  }

  const rel = relative(home, path);
  if (rel === "" || rel === ".") {
    return "~";
  }

  if (rel.startsWith("..") || isAbsolute(rel)) {
    return path;
  }

  return `~/${rel.replaceAll("\\", "/")}`;
}

function normalizeRoots(paths: string[]): string[] {
  const deduped = new Set<string>();
  for (const path of paths) {
    if (!isNonEmptyString(path)) {
      continue;
    }
    deduped.add(expandHomePath(path.trim()));
  }
  return Array.from(deduped);
}

function parseRootsFromEnv(name: string): string[] | undefined {
  const raw = readOptionalEnv(name);
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const roots = normalizeRoots(parsed.filter(isNonEmptyString));
  return roots.length > 0 ? roots : undefined;
}

function cloneProviderSessionRoots(
  roots: ProviderSessionRoots,
): ProviderSessionRoots {
  return {
    claude: [...roots.claude],
    codex: [...roots.codex],
    gemini: [...roots.gemini],
  };
}

export function resolveDefaultProviderSessionRoots(): ProviderSessionRoots {
  const home = resolveHomeDir();
  const claude = parseRootsFromEnv("KATO_CLAUDE_SESSION_ROOTS") ??
    (home
      ? normalizeRoots([
        join(home, ".claude", "projects"),
      ])
      : []);
  const codex = parseRootsFromEnv("KATO_CODEX_SESSION_ROOTS") ??
    (home ? normalizeRoots([join(home, ".codex", "sessions")]) : []);
  const gemini = parseRootsFromEnv("KATO_GEMINI_SESSION_ROOTS") ??
    (home ? normalizeRoots([join(home, ".gemini", "tmp")]) : []);

  return { claude, codex, gemini };
}

function mergeProviderSessionRoots(
  roots?: Partial<ProviderSessionRoots>,
): ProviderSessionRoots {
  const resolved = resolveDefaultProviderSessionRoots();
  if (!roots) {
    return resolved;
  }

  for (const key of PROVIDER_SESSION_ROOT_KEYS) {
    const candidate = roots[key];
    if (candidate !== undefined) {
      resolved[key] = normalizeRoots(candidate);
    }
  }

  return resolved;
}

function parseProviderSessionRoots(
  value: unknown,
): ProviderSessionRoots | undefined {
  if (value === undefined) {
    return resolveDefaultProviderSessionRoots();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (
      !PROVIDER_SESSION_ROOT_KEYS.includes(key as keyof ProviderSessionRoots)
    ) {
      return undefined;
    }
  }

  const overrides: Partial<ProviderSessionRoots> = {};
  for (const key of PROVIDER_SESSION_ROOT_KEYS) {
    const roots = value[key];
    if (roots === undefined) {
      continue;
    }
    if (
      !Array.isArray(roots) || roots.some((root) => !isNonEmptyString(root))
    ) {
      return undefined;
    }
    overrides[key] = normalizeRoots(roots);
  }

  return mergeProviderSessionRoots(overrides);
}

function parseProviderAutoGenerateSnapshots(
  value: unknown,
): ProviderAutoGenerateSnapshots | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (
      !PROVIDER_AUTO_SNAPSHOT_KEYS.includes(
        key as keyof ProviderAutoGenerateSnapshots,
      )
    ) {
      return undefined;
    }
  }

  const parsed: ProviderAutoGenerateSnapshots = {};
  for (const key of PROVIDER_AUTO_SNAPSHOT_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "boolean") {
      return undefined;
    }
    parsed[key] = candidate;
  }
  return parsed;
}

function parseRuntimeConfig(value: unknown): RuntimeConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!RUNTIME_CONFIG_KEYS.includes(key as keyof RuntimeConfig)) {
      return undefined;
    }
  }

  if (value["schemaVersion"] !== DEFAULT_CONFIG_SCHEMA_VERSION) {
    return undefined;
  }
  if (
    typeof value["runtimeDir"] !== "string" || value["runtimeDir"].length === 0
  ) {
    return undefined;
  }
  if (
    typeof value["statusPath"] !== "string" || value["statusPath"].length === 0
  ) {
    return undefined;
  }
  if (
    typeof value["controlPath"] !== "string" ||
    value["controlPath"].length === 0
  ) {
    return undefined;
  }
  const runtimeDir = expandHomePath(value["runtimeDir"]);
  let katoDir = dirname(runtimeDir);
  if ("katoDir" in value && value["katoDir"] !== undefined) {
    if (
      typeof value["katoDir"] !== "string" ||
      value["katoDir"].length === 0
    ) {
      return undefined;
    }
    katoDir = expandHomePath(value["katoDir"]);
  }
  const statusPath = expandHomePath(value["statusPath"]);
  const controlPath = expandHomePath(value["controlPath"]);
  const allowedWriteRoots = value["allowedWriteRoots"];
  if (
    !Array.isArray(allowedWriteRoots) ||
    allowedWriteRoots.some((root) =>
      typeof root !== "string" || root.length === 0
    )
  ) {
    return undefined;
  }

  const daemonFeatureFlags = parseDaemonFeatureFlags(
    value["daemonFeatureFlags"],
  );
  if (!daemonFeatureFlags) {
    return undefined;
  }
  const exportFeatureFlags = parseExportFeatureFlags(
    value["exportFeatureFlags"],
  );
  if (!exportFeatureFlags) {
    return undefined;
  }
  const logging = parseRuntimeLoggingConfig(value["logging"]);
  if (!logging) {
    return undefined;
  }
  const exportMarkdownFrontmatter = parseRuntimeMarkdownFrontmatterConfig(
    value["exportMarkdownFrontmatter"],
  );
  if (!exportMarkdownFrontmatter) {
    return undefined;
  }
  const providerSessionRoots = parseProviderSessionRoots(
    value["providerSessionRoots"],
  );
  if (!providerSessionRoots) {
    return undefined;
  }
  const providerAutoGenerateSnapshots = parseProviderAutoGenerateSnapshots(
    value["providerAutoGenerateSnapshots"],
  );
  if (!providerAutoGenerateSnapshots) {
    return undefined;
  }
  const exportTimezone = parseExportTimezone(value["exportTimezone"]);
  if (!exportTimezone) {
    return undefined;
  }
  const globalAutoGenerateSnapshots = value["globalAutoGenerateSnapshots"] ===
      undefined
    ? false
    : value["globalAutoGenerateSnapshots"];
  if (typeof globalAutoGenerateSnapshots !== "boolean") {
    return undefined;
  }
  const cleanSessionStatesOnShutdown = value["cleanSessionStatesOnShutdown"] ===
      undefined
    ? false
    : value["cleanSessionStatesOnShutdown"];
  if (typeof cleanSessionStatesOnShutdown !== "boolean") {
    return undefined;
  }

  let daemonMaxMemoryMb = DEFAULT_DAEMON_MAX_MEMORY_MB;
  if ("daemonMaxMemoryMb" in value) {
    const raw = value["daemonMaxMemoryMb"];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      return undefined;
    }
    daemonMaxMemoryMb = raw;
  }

  return {
    schemaVersion: DEFAULT_CONFIG_SCHEMA_VERSION,
    runtimeDir,
    katoDir,
    statusPath,
    controlPath,
    allowedWriteRoots: allowedWriteRoots.map((root) => expandHomePath(root)),
    exportTimezone,
    providerSessionRoots,
    globalAutoGenerateSnapshots,
    providerAutoGenerateSnapshots,
    cleanSessionStatesOnShutdown,
    daemonFeatureFlags,
    exportMarkdownFrontmatter,
    exportFeatureFlags,
    logging,
    daemonMaxMemoryMb,
  };
}

async function writeTextAtomically(
  path: string,
  value: string,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tempPath, value);
  await Deno.rename(tempPath, path);
}

function cloneConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    schemaVersion: config.schemaVersion,
    runtimeDir: config.runtimeDir,
    ...(config.katoDir ? { katoDir: config.katoDir } : {}),
    statusPath: config.statusPath,
    controlPath: config.controlPath,
    allowedWriteRoots: [...config.allowedWriteRoots],
    exportTimezone: config.exportTimezone ?? DEFAULT_EXPORT_TIMEZONE,
    providerSessionRoots: cloneProviderSessionRoots(
      config.providerSessionRoots,
    ),
    globalAutoGenerateSnapshots: config.globalAutoGenerateSnapshots ?? false,
    providerAutoGenerateSnapshots: {
      ...(config.providerAutoGenerateSnapshots ?? {}),
    },
    cleanSessionStatesOnShutdown: config.cleanSessionStatesOnShutdown ?? false,
    daemonFeatureFlags: mergeDaemonFeatureFlags(config.daemonFeatureFlags),
    exportMarkdownFrontmatter: createDefaultRuntimeMarkdownFrontmatterConfig(
      config.exportMarkdownFrontmatter,
    ),
    exportFeatureFlags: createDefaultExportFeatureFlags(
      config.exportFeatureFlags,
    ),
    logging: { ...config.logging },
    daemonMaxMemoryMb: config.daemonMaxMemoryMb,
  };
}

export function resolveDefaultConfigPath(runtimeDir: string): string {
  return readOptionalEnv("KATO_CONFIG_PATH") ??
    join(dirname(runtimeDir), CONFIG_FILENAME);
}

export function createDefaultRuntimeConfig(options: {
  runtimeDir: string;
  katoDir?: string;
  statusPath: string;
  controlPath: string;
  allowedWriteRoots: string[];
  exportTimezone?: string;
  providerSessionRoots?: Partial<ProviderSessionRoots>;
  globalAutoGenerateSnapshots?: boolean;
  providerAutoGenerateSnapshots?: ProviderAutoGenerateSnapshots;
  cleanSessionStatesOnShutdown?: boolean;
  exportMarkdownFrontmatter?: Partial<MarkdownFrontmatterConfig>;
  daemonFeatureFlags?: Partial<DaemonFeatureFlags>;
  exportFeatureFlags?: Partial<ExportFeatureFlags>;
  logging?: Partial<RuntimeLoggingConfig>;
  daemonMaxMemoryMb?: number;
  useHomeShorthand?: boolean;
}): RuntimeConfig {
  const serializePath = options.useHomeShorthand ? collapseHome : (
    path: string,
  ) => path;
  const providerSessionRoots = mergeProviderSessionRoots(
    options.providerSessionRoots,
  );

  const envOperationalLevelRaw = readOptionalEnv(
    "KATO_LOGGING_OPERATIONAL_LEVEL",
  );
  const envOperationalLevel = envOperationalLevelRaw !== undefined
    ? normalizeRuntimeLogLevel(envOperationalLevelRaw)
    : undefined;
  if (envOperationalLevelRaw !== undefined && !envOperationalLevel) {
    throw new Error(
      "KATO_LOGGING_OPERATIONAL_LEVEL must be one of: debug, info, warn, error",
    );
  }
  const envAuditLevelRaw = readOptionalEnv("KATO_LOGGING_AUDIT_LEVEL");
  const envAuditLevel = envAuditLevelRaw !== undefined
    ? normalizeRuntimeLogLevel(envAuditLevelRaw)
    : undefined;
  if (envAuditLevelRaw !== undefined && !envAuditLevel) {
    throw new Error(
      "KATO_LOGGING_AUDIT_LEVEL must be one of: debug, info, warn, error",
    );
  }
  const resolvedLogging = createDefaultRuntimeLoggingConfig({
    operationalLevel: options.logging?.operationalLevel ??
      envOperationalLevel,
    auditLevel: options.logging?.auditLevel ?? envAuditLevel,
  });
  if (
    !isRuntimeLogLevel(resolvedLogging.operationalLevel) ||
    !isRuntimeLogLevel(resolvedLogging.auditLevel)
  ) {
    throw new Error(
      "logging levels must be one of: debug, info, warn, error",
    );
  }

  const envMemoryMb = readOptionalEnv("KATO_DAEMON_MAX_MEMORY_MB");
  const parsedEnvMemoryMb = envMemoryMb
    ? Number(envMemoryMb.trim())
    : undefined;
  const resolvedDaemonMaxMemoryMb = options.daemonMaxMemoryMb ??
    (parsedEnvMemoryMb !== undefined &&
        Number.isInteger(parsedEnvMemoryMb) &&
        parsedEnvMemoryMb > 0
      ? parsedEnvMemoryMb
      : undefined) ??
    DEFAULT_DAEMON_MAX_MEMORY_MB;
  if (
    !Number.isInteger(resolvedDaemonMaxMemoryMb) ||
    resolvedDaemonMaxMemoryMb <= 0
  ) {
    throw new Error("daemonMaxMemoryMb must be a positive integer");
  }
  const resolvedExportTimezone = parseExportTimezone(options.exportTimezone);
  if (!resolvedExportTimezone) {
    throw new Error(
      'exportTimezone must be "local", "UTC", or a valid IANA timezone',
    );
  }

  return {
    schemaVersion: DEFAULT_CONFIG_SCHEMA_VERSION,
    runtimeDir: serializePath(options.runtimeDir),
    katoDir: serializePath(options.katoDir ?? dirname(options.runtimeDir)),
    statusPath: serializePath(options.statusPath),
    controlPath: serializePath(options.controlPath),
    allowedWriteRoots: options.allowedWriteRoots.map((root) =>
      serializePath(root)
    ),
    exportTimezone: resolvedExportTimezone,
    providerSessionRoots: {
      claude: providerSessionRoots.claude.map((root) => serializePath(root)),
      codex: providerSessionRoots.codex.map((root) => serializePath(root)),
      gemini: providerSessionRoots.gemini.map((root) => serializePath(root)),
    },
    globalAutoGenerateSnapshots: options.globalAutoGenerateSnapshots ?? false,
    providerAutoGenerateSnapshots: {
      ...(options.providerAutoGenerateSnapshots ?? {}),
    },
    cleanSessionStatesOnShutdown: options.cleanSessionStatesOnShutdown ?? false,
    daemonFeatureFlags: mergeDaemonFeatureFlags(options.daemonFeatureFlags),
    exportMarkdownFrontmatter: createDefaultRuntimeMarkdownFrontmatterConfig(
      options.exportMarkdownFrontmatter,
    ),
    exportFeatureFlags: createDefaultExportFeatureFlags(
      options.exportFeatureFlags,
    ),
    logging: resolvedLogging,
    daemonMaxMemoryMb: resolvedDaemonMaxMemoryMb,
  };
}

export class RuntimeConfigFileStore implements RuntimeConfigStoreLike {
  constructor(private readonly configPath: string) {}

  async load(): Promise<RuntimeConfig> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("Runtime config path must end with .yaml");
    }
    const raw = await Deno.readTextFile(this.configPath);

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error("Runtime config file contains invalid YAML");
    }

    const config = parseRuntimeConfig(parsed);
    if (!config) {
      throw new Error("Runtime config file has unsupported schema");
    }

    return cloneConfig(config);
  }

  async ensureInitialized(
    defaultConfig: RuntimeConfig,
  ): Promise<EnsureRuntimeConfigResult> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("Runtime config path must end with .yaml");
    }
    try {
      const loaded = await this.load();
      return {
        created: false,
        config: cloneConfig(loaded),
        path: this.configPath,
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const clonedDefault = cloneConfig(defaultConfig);
    const serialized = stringifyYaml(clonedDefault).trimEnd() + "\n";
    await writeTextAtomically(this.configPath, serialized);
    return {
      created: true,
      config: clonedDefault,
      path: this.configPath,
    };
  }
}
