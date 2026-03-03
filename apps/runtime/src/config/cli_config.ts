import type { CliConfig, RuntimeLoggingConfig } from "@kato/shared";
import { dirname, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";
import { createDefaultRuntimeLoggingConfig } from "./runtime_config.ts";

const DEFAULT_SCHEMA_VERSION = 1;
const CLI_CONFIG_FILENAME = "kato-cli-config.yaml";
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const LOGGING_KEYS: Array<keyof RuntimeLoggingConfig> = [
  "operationalLevel",
  "auditLevel",
];

export interface EnsureCliConfigResult {
  created: boolean;
  config: CliConfig;
  path: string;
}

export interface CliConfigStoreLike {
  load(): Promise<CliConfig>;
  ensureInitialized(defaultConfig: CliConfig): Promise<EnsureCliConfigResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isYamlConfigPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(".yaml");
}

function parseLoggingConfig(value: unknown): RuntimeLoggingConfig | undefined {
  if (value === undefined) {
    return createDefaultRuntimeLoggingConfig();
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!LOGGING_KEYS.includes(key as keyof RuntimeLoggingConfig)) {
      return undefined;
    }
  }

  const resolved = createDefaultRuntimeLoggingConfig();
  for (const key of LOGGING_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "string") {
      return undefined;
    }
    const normalized = candidate.trim().toLowerCase();
    if (!LOG_LEVELS.has(normalized)) {
      return undefined;
    }
    resolved[key] = normalized as RuntimeLoggingConfig[typeof key];
  }
  return resolved;
}

function parseCliConfig(value: unknown): CliConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "schemaVersion" && key !== "logging")) {
    return undefined;
  }
  if (value["schemaVersion"] !== DEFAULT_SCHEMA_VERSION) {
    return undefined;
  }
  const logging = parseLoggingConfig(value["logging"]);
  if (!logging) {
    return undefined;
  }
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    logging,
  };
}

async function writeTextAtomically(path: string, value: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tempPath, value);
  await Deno.rename(tempPath, path);
}

function cloneConfig(config: CliConfig): CliConfig {
  return {
    schemaVersion: config.schemaVersion,
    logging: { ...config.logging },
  };
}

export function resolveDefaultCliConfigPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, "cli", CLI_CONFIG_FILENAME);
}

export function createDefaultCliConfig(
  options: {
    logging?: Partial<RuntimeLoggingConfig>;
  } = {},
): CliConfig {
  const logging = createDefaultRuntimeLoggingConfig(options.logging);
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    logging,
  };
}

export class CliConfigFileStore implements CliConfigStoreLike {
  constructor(private readonly configPath: string) {}

  async load(): Promise<CliConfig> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("CLI config path must end with .yaml");
    }
    const raw = await Deno.readTextFile(this.configPath);
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error("CLI config file contains invalid YAML");
    }

    const config = parseCliConfig(parsed);
    if (!config) {
      throw new Error("CLI config file has unsupported schema");
    }
    return cloneConfig(config);
  }

  async ensureInitialized(
    defaultConfig: CliConfig,
  ): Promise<EnsureCliConfigResult> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("CLI config path must end with .yaml");
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
