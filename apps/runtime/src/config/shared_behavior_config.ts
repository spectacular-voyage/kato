import type {
  ExportFeatureFlags,
  MarkdownFrontmatterConfig,
  SharedBehaviorConfig,
} from "@kato/shared";
import { dirname, isAbsolute, join, relative } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";
import { expandHomePath, resolveHomeDir } from "../utils/env.ts";
import {
  createDefaultExportFeatureFlags,
  createDefaultRuntimeMarkdownFrontmatterConfig,
} from "./runtime_config.ts";

const DEFAULT_SCHEMA_VERSION = 1;
const DEFAULT_EXPORT_TIMEZONE = "local";
const SHARED_CONFIG_FILENAME = "kato-shared-config.yaml";

const SHARED_CONFIG_KEYS: Array<keyof SharedBehaviorConfig> = [
  "schemaVersion",
  "allowedWriteRoots",
  "exportTimezone",
  "exportMarkdownFrontmatter",
  "exportFeatureFlags",
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
const MARKDOWN_FRONTMATTER_KEYS: Array<keyof MarkdownFrontmatterConfig> = [
  "includeFrontmatterInMarkdownRecordings",
  "includeUpdatedInFrontmatter",
  "addParticipantUsernameToFrontmatter",
  "includeSessionIds",
  "includeWorkspaceIds",
  "includeRecordingIds",
  "includeConversationEventKinds",
];

export interface EnsureSharedBehaviorConfigResult {
  created: boolean;
  config: SharedBehaviorConfig;
  path: string;
}

export interface SharedBehaviorConfigStoreLike {
  load(): Promise<SharedBehaviorConfig>;
  ensureInitialized(
    defaultConfig: SharedBehaviorConfig,
  ): Promise<EnsureSharedBehaviorConfigResult>;
  save(config: SharedBehaviorConfig): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isYamlConfigPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(".yaml");
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

function normalizeRoots(paths: string[]): string[] {
  const deduped = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.trim().length === 0) {
      continue;
    }
    deduped.add(expandHomePath(path.trim()));
  }
  return Array.from(deduped);
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

  const resolved = createDefaultExportFeatureFlags();
  for (const key of EXPORT_FEATURE_FLAG_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "boolean") {
      return undefined;
    }
    resolved[key] = candidate;
  }
  return resolved;
}

function parseMarkdownFrontmatter(
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
    if (typeof candidate !== "boolean") {
      return undefined;
    }
    resolved[key] = candidate;
  }
  return resolved;
}

function parseSharedBehaviorConfig(
  value: unknown,
): SharedBehaviorConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!SHARED_CONFIG_KEYS.includes(key as keyof SharedBehaviorConfig)) {
      return undefined;
    }
  }
  if (value["schemaVersion"] !== DEFAULT_SCHEMA_VERSION) {
    return undefined;
  }

  if (
    !Array.isArray(value["allowedWriteRoots"]) ||
    value["allowedWriteRoots"].some((root) =>
      typeof root !== "string" || root.length === 0
    )
  ) {
    return undefined;
  }

  const exportTimezone = parseExportTimezone(value["exportTimezone"]);
  if (!exportTimezone) {
    return undefined;
  }
  const exportMarkdownFrontmatter = parseMarkdownFrontmatter(
    value["exportMarkdownFrontmatter"],
  );
  if (!exportMarkdownFrontmatter) {
    return undefined;
  }
  const exportFeatureFlags = parseExportFeatureFlags(
    value["exportFeatureFlags"],
  );
  if (!exportFeatureFlags) {
    return undefined;
  }

  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    allowedWriteRoots: normalizeRoots(
      value["allowedWriteRoots"] as string[],
    ),
    exportTimezone,
    exportMarkdownFrontmatter,
    exportFeatureFlags,
  };
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

async function writeTextAtomically(path: string, value: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tempPath, value);
  await Deno.rename(tempPath, path);
}

function cloneConfig(config: SharedBehaviorConfig): SharedBehaviorConfig {
  return {
    schemaVersion: config.schemaVersion,
    allowedWriteRoots: [...config.allowedWriteRoots],
    exportTimezone: config.exportTimezone ?? DEFAULT_EXPORT_TIMEZONE,
    exportMarkdownFrontmatter: {
      ...config.exportMarkdownFrontmatter,
    },
    exportFeatureFlags: { ...config.exportFeatureFlags },
  };
}

export function resolveDefaultSharedConfigPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, "shared", SHARED_CONFIG_FILENAME);
}

export function createDefaultSharedBehaviorConfig(options: {
  allowedWriteRoots: string[];
  exportTimezone?: string;
  exportMarkdownFrontmatter?: Partial<MarkdownFrontmatterConfig>;
  exportFeatureFlags?: Partial<ExportFeatureFlags>;
  useHomeShorthand?: boolean;
}): SharedBehaviorConfig {
  const serializePath = options.useHomeShorthand ? collapseHome : (
    path: string,
  ) => path;
  const exportTimezone = parseExportTimezone(options.exportTimezone);
  if (!exportTimezone) {
    throw new Error(
      'exportTimezone must be "local", "UTC", or a valid IANA timezone',
    );
  }

  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    allowedWriteRoots: normalizeRoots(options.allowedWriteRoots).map(
      (path) => serializePath(path),
    ),
    exportTimezone,
    exportMarkdownFrontmatter: createDefaultRuntimeMarkdownFrontmatterConfig(
      options.exportMarkdownFrontmatter,
    ),
    exportFeatureFlags: createDefaultExportFeatureFlags(
      options.exportFeatureFlags,
    ),
  };
}

export class SharedBehaviorConfigFileStore
  implements SharedBehaviorConfigStoreLike {
  constructor(private readonly configPath: string) {}

  async load(): Promise<SharedBehaviorConfig> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("Shared behavior config path must end with .yaml");
    }
    const raw = await Deno.readTextFile(this.configPath);
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error("Shared behavior config file contains invalid YAML");
    }

    const config = parseSharedBehaviorConfig(parsed);
    if (!config) {
      throw new Error("Shared behavior config file has unsupported schema");
    }
    return cloneConfig(config);
  }

  async ensureInitialized(
    defaultConfig: SharedBehaviorConfig,
  ): Promise<EnsureSharedBehaviorConfigResult> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("Shared behavior config path must end with .yaml");
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

  async save(config: SharedBehaviorConfig): Promise<void> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("Shared behavior config path must end with .yaml");
    }
    const cloned = cloneConfig(config);
    const serialized = stringifyYaml(cloned).trimEnd() + "\n";
    await writeTextAtomically(this.configPath, serialized);
  }
}
