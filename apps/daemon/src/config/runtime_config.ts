import type {
  ProviderSessionRoots,
  RuntimeConfig,
  RuntimeFeatureFlags,
  RuntimeLoggingConfig,
  RuntimeLogLevel,
} from "@kato/shared";
import { dirname, isAbsolute, join, relative } from "@std/path";
import {
  createDefaultRuntimeFeatureFlags,
  mergeRuntimeFeatureFlags,
} from "../feature_flags/mod.ts";

const DEFAULT_CONFIG_SCHEMA_VERSION = 1;
const CONFIG_FILENAME = "config.json";
const DEFAULT_DAEMON_MAX_MEMORY_MB = 200;
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

const RUNTIME_FEATURE_FLAG_KEYS: Array<keyof RuntimeFeatureFlags> = [
  "writerIncludeCommentary",
  "writerIncludeThinking",
  "writerIncludeToolCalls",
  "writerItalicizeUserMessages",
  "daemonExportEnabled",
  "captureIncludeSystemEvents",
];
const PROVIDER_SESSION_ROOT_KEYS: Array<keyof ProviderSessionRoots> = [
  "claude",
  "codex",
  "gemini",
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRuntimeFeatureFlags(
  value: unknown,
): RuntimeFeatureFlags | undefined {
  if (value === undefined) {
    return createDefaultRuntimeFeatureFlags();
  }
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!RUNTIME_FEATURE_FLAG_KEYS.includes(key as keyof RuntimeFeatureFlags)) {
      return undefined;
    }
  }

  const merged = mergeRuntimeFeatureFlags();
  for (const key of RUNTIME_FEATURE_FLAG_KEYS) {
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

function resolveHomeDir(): string | undefined {
  return readOptionalEnv("HOME") ?? readOptionalEnv("USERPROFILE");
}

function expandHome(path: string): string {
  if (!path.startsWith("~")) {
    return path;
  }

  const home = resolveHomeDir();
  if (!home) {
    return path;
  }

  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(home, path.slice(2));
  }

  return path;
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
    deduped.add(expandHome(path.trim()));
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

function parseRuntimeConfig(value: unknown): RuntimeConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
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
  const runtimeDir = expandHome(value["runtimeDir"]);
  const statusPath = expandHome(value["statusPath"]);
  const controlPath = expandHome(value["controlPath"]);
  const allowedWriteRoots = value["allowedWriteRoots"];
  if (
    !Array.isArray(allowedWriteRoots) ||
    allowedWriteRoots.some((root) =>
      typeof root !== "string" || root.length === 0
    )
  ) {
    return undefined;
  }

  const featureFlags = parseRuntimeFeatureFlags(value["featureFlags"]);
  if (!featureFlags) {
    return undefined;
  }
  const logging = parseRuntimeLoggingConfig(value["logging"]);
  if (!logging) {
    return undefined;
  }
  const providerSessionRoots = parseProviderSessionRoots(
    value["providerSessionRoots"],
  );
  if (!providerSessionRoots) {
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
    statusPath,
    controlPath,
    allowedWriteRoots: allowedWriteRoots.map((root) => expandHome(root)),
    providerSessionRoots,
    featureFlags,
    logging,
    daemonMaxMemoryMb,
  };
}

function readOptionalEnv(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    if (value === undefined || value.length === 0) {
      return undefined;
    }
    return value;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tempPath, JSON.stringify(value, null, 2));
  await Deno.rename(tempPath, path);
}

function cloneConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    schemaVersion: config.schemaVersion,
    runtimeDir: config.runtimeDir,
    statusPath: config.statusPath,
    controlPath: config.controlPath,
    allowedWriteRoots: [...config.allowedWriteRoots],
    providerSessionRoots: cloneProviderSessionRoots(
      config.providerSessionRoots,
    ),
    featureFlags: { ...config.featureFlags },
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
  statusPath: string;
  controlPath: string;
  allowedWriteRoots: string[];
  providerSessionRoots?: Partial<ProviderSessionRoots>;
  featureFlags?: Partial<RuntimeFeatureFlags>;
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

  return {
    schemaVersion: DEFAULT_CONFIG_SCHEMA_VERSION,
    runtimeDir: serializePath(options.runtimeDir),
    statusPath: serializePath(options.statusPath),
    controlPath: serializePath(options.controlPath),
    allowedWriteRoots: options.allowedWriteRoots.map((root) =>
      serializePath(root)
    ),
    providerSessionRoots: {
      claude: providerSessionRoots.claude.map((root) => serializePath(root)),
      codex: providerSessionRoots.codex.map((root) => serializePath(root)),
      gemini: providerSessionRoots.gemini.map((root) => serializePath(root)),
    },
    featureFlags: mergeRuntimeFeatureFlags(options.featureFlags),
    logging: resolvedLogging,
    daemonMaxMemoryMb: resolvedDaemonMaxMemoryMb,
  };
}

export class RuntimeConfigFileStore implements RuntimeConfigStoreLike {
  constructor(private readonly configPath: string) {}

  async load(): Promise<RuntimeConfig> {
    const raw = await Deno.readTextFile(this.configPath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Runtime config file contains invalid JSON");
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
    await writeJsonAtomically(this.configPath, clonedDefault);
    return {
      created: true,
      config: clonedDefault,
      path: this.configPath,
    };
  }
}
