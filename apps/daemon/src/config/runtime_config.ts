import type { RuntimeConfig, RuntimeFeatureFlags } from "@kato/shared";
import { dirname, join } from "@std/path";
import {
  createDefaultRuntimeFeatureFlags,
  mergeRuntimeFeatureFlags,
} from "../feature_flags/mod.ts";

const DEFAULT_CONFIG_SCHEMA_VERSION = 1;
const CONFIG_FILENAME = "config.json";

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
  "writerIncludeThinking",
  "writerIncludeToolCalls",
  "writerItalicizeUserMessages",
  "daemonExportEnabled",
];

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

  return {
    schemaVersion: DEFAULT_CONFIG_SCHEMA_VERSION,
    runtimeDir: value["runtimeDir"],
    statusPath: value["statusPath"],
    controlPath: value["controlPath"],
    allowedWriteRoots: [...allowedWriteRoots],
    featureFlags,
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
    featureFlags: { ...config.featureFlags },
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
  featureFlags?: Partial<RuntimeFeatureFlags>;
}): RuntimeConfig {
  return {
    schemaVersion: DEFAULT_CONFIG_SCHEMA_VERSION,
    runtimeDir: options.runtimeDir,
    statusPath: options.statusPath,
    controlPath: options.controlPath,
    allowedWriteRoots: [...options.allowedWriteRoots],
    featureFlags: mergeRuntimeFeatureFlags(options.featureFlags),
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
