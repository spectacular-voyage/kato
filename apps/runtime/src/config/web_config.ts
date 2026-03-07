import {
  DEFAULT_KATO_WEB_HOSTNAME,
  DEFAULT_KATO_WEB_PORT,
  type WebAuthConfig,
  type WebConfig,
} from "@kato/shared";
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
const DEFAULT_COOKIE_NAME = "kato_web_session";
const PBKDF2_ITERATIONS = 310_000;

export interface EnsureWebConfigResult {
  created: boolean;
  config: WebConfig;
  path: string;
}

export interface WebConfigStoreLike {
  load(): Promise<WebConfig>;
  ensureInitialized(defaultConfig: WebConfig): Promise<EnsureWebConfigResult>;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isHexString(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value) && value.length > 0;
}

function parseWebAuthConfig(value: unknown): WebAuthConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (
    keys.some((key) =>
      key !== "username" &&
      key !== "passwordSalt" &&
      key !== "passwordHash" &&
      key !== "sessionSecret" &&
      key !== "cookieName"
    )
  ) {
    return undefined;
  }
  if (
    typeof value["username"] !== "string" || value["username"].trim() === ""
  ) {
    return undefined;
  }
  if (
    typeof value["passwordSalt"] !== "string" ||
    value["passwordSalt"].trim() === ""
  ) {
    return undefined;
  }
  if (
    typeof value["passwordHash"] !== "string" ||
    !isHexString(value["passwordHash"])
  ) {
    return undefined;
  }
  if (
    typeof value["sessionSecret"] !== "string" ||
    value["sessionSecret"].trim() === ""
  ) {
    return undefined;
  }
  if (
    typeof value["cookieName"] !== "string" ||
    value["cookieName"].trim() === ""
  ) {
    return undefined;
  }
  return {
    username: value["username"].trim(),
    passwordSalt: value["passwordSalt"].trim(),
    passwordHash: value["passwordHash"].trim().toLowerCase(),
    sessionSecret: value["sessionSecret"].trim(),
    cookieName: value["cookieName"].trim(),
  };
}

function parseWebConfig(value: unknown): WebConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const keys = Object.keys(value);
  if (
    keys.some((key) =>
      key !== "schemaVersion" &&
      key !== "hostname" &&
      key !== "port" &&
      key !== "auth"
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
  const auth = parseWebAuthConfig(value["auth"]);
  if (!auth) {
    return undefined;
  }

  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    hostname: value["hostname"].trim(),
    port: value["port"],
    auth,
  };
}

function cloneConfig(config: WebConfig): WebConfig {
  return {
    schemaVersion: config.schemaVersion,
    hostname: config.hostname,
    port: config.port,
    auth: { ...config.auth },
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
    auth?: Partial<WebAuthConfig>;
  } = {},
): WebConfig {
  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    hostname: options.hostname?.trim() || DEFAULT_KATO_WEB_HOSTNAME,
    port: options.port ?? DEFAULT_KATO_WEB_PORT,
    auth: {
      username: options.auth?.username?.trim() || "kato",
      passwordSalt: options.auth?.passwordSalt || "placeholder-salt",
      passwordHash: options.auth?.passwordHash || "placeholderhash",
      sessionSecret: options.auth?.sessionSecret || "placeholder-secret",
      cookieName: options.auth?.cookieName || DEFAULT_COOKIE_NAME,
    },
  };
}

export async function hashWebPassword(
  password: string,
  passwordSalt: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: decodeBase64(passwordSalt) as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function createInitializedWebConfig(
  options: {
    hostname?: string;
    port?: number;
    username: string;
    password: string;
  },
): Promise<WebConfig> {
  const passwordSalt = encodeBase64(crypto.getRandomValues(new Uint8Array(16)));
  const sessionSecret = encodeBase64(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const passwordHash = await hashWebPassword(options.password, passwordSalt);

  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    hostname: options.hostname?.trim() || DEFAULT_KATO_WEB_HOSTNAME,
    port: options.port ?? DEFAULT_KATO_WEB_PORT,
    auth: {
      username: options.username.trim(),
      passwordSalt,
      passwordHash,
      sessionSecret,
      cookieName: DEFAULT_COOKIE_NAME,
    },
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
