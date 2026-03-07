import type { WebConfig } from "@kato/shared";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";
import {
  isRecord,
  isYamlConfigPath,
  writeTextAtomically,
} from "./file_store_utils.ts";

const DEFAULT_SCHEMA_VERSION = 1;
const WEB_CONFIG_FILENAME = "kato-web-config.yaml";

export interface EnsureWebConfigResult {
  created: boolean;
  config: WebConfig;
  path: string;
}

export interface WebConfigStoreLike {
  load(): Promise<WebConfig>;
  ensureInitialized(defaultConfig: WebConfig): Promise<EnsureWebConfigResult>;
}

function parseWebConfig(value: unknown): WebConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const keys = Object.keys(value);
  if (
    keys.some((key) =>
      key !== "schemaVersion" && key !== "hostname" && key !== "port"
    )
  ) {
    return undefined;
  }
  if (value["schemaVersion"] !== DEFAULT_SCHEMA_VERSION) {
    return undefined;
  }
  if (
    typeof value["hostname"] !== "string" || value["hostname"].trim() === ""
  ) {
    return undefined;
  }
  if (
    typeof value["port"] !== "number" ||
    !Number.isInteger(value["port"]) ||
    value["port"] <= 0 ||
    value["port"] > 65535
  ) {
    return undefined;
  }

  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    hostname: value["hostname"].trim(),
    port: value["port"],
  };
}

function cloneConfig(config: WebConfig): WebConfig {
  return {
    schemaVersion: config.schemaVersion,
    hostname: config.hostname,
    port: config.port,
  };
}

export function resolveDefaultWebConfigPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, "web", WEB_CONFIG_FILENAME);
}

export function createDefaultWebConfig(
  options: {
    hostname?: string;
    port?: number;
  } = {},
): WebConfig {
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    hostname: options.hostname?.trim() || "127.0.0.1",
    port: options.port ?? 3173,
  };
}

export class WebConfigFileStore implements WebConfigStoreLike {
  constructor(private readonly configPath: string) {}

  async load(): Promise<WebConfig> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("Web config path must end with .yaml");
    }
    const raw = await Deno.readTextFile(this.configPath);
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error("Web config file contains invalid YAML");
    }

    const config = parseWebConfig(parsed);
    if (!config) {
      throw new Error("Web config file has unsupported schema");
    }
    return cloneConfig(config);
  }

  async ensureInitialized(
    defaultConfig: WebConfig,
  ): Promise<EnsureWebConfigResult> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("Web config path must end with .yaml");
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
