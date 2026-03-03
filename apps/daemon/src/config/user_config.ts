import type { UserConfig, UserParticipantsConfig } from "@kato/shared";
import { dirname, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { resolveHomeDir } from "../utils/env.ts";

const USER_CONFIG_SCHEMA_VERSION = 1;
const USER_CONFIG_FILENAME = "kato-user-config.yaml";
const USER_CONFIG_KEYS = ["schemaVersion", "participants"] as const;
const USER_PARTICIPANTS_KEYS = [
  "defaultUsername",
  "workspaceUsernames",
  "excludeMeFromParticipantList",
] as const;
const MAX_USERNAME_CODE_POINTS = 128;

type UserConfigKey = typeof USER_CONFIG_KEYS[number];
type UserParticipantsKey = typeof USER_PARTICIPANTS_KEYS[number];

export interface EnsureUserConfigResult {
  created: boolean;
  path: string;
  config: UserConfig;
}

export interface UserConfigStoreLike {
  load(): Promise<UserConfig>;
  ensureInitialized(
    defaultConfig?: UserConfig,
  ): Promise<EnsureUserConfigResult>;
  save(config: UserConfig): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isYamlConfigPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(".yaml");
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function containsAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1F || code === 0x7F) {
      return true;
    }
  }
  return false;
}

export function validateAndNormalizeParticipantUsername(
  value: string,
  context = "username",
  options: { allowEmpty?: boolean } = {},
): string {
  const trimmed = value.trim();
  const allowEmpty = options.allowEmpty ?? false;

  if (trimmed.length === 0) {
    if (allowEmpty) {
      return "";
    }
    throw new Error(`${context} must be a non-empty string`);
  }

  if (containsAsciiControlCharacters(trimmed)) {
    throw new Error(
      `${context} must not contain ASCII control characters (U+0000..U+001F, U+007F)`,
    );
  }

  if (countCodePoints(trimmed) > MAX_USERNAME_CODE_POINTS) {
    throw new Error(
      `${context} must be at most ${MAX_USERNAME_CODE_POINTS} Unicode code points`,
    );
  }

  return trimmed;
}

function parseParticipants(value: unknown): UserParticipantsConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!USER_PARTICIPANTS_KEYS.includes(key as UserParticipantsKey)) {
      return undefined;
    }
  }

  const defaultUsernameRaw = value["defaultUsername"];
  const workspaceUsernamesRaw = value["workspaceUsernames"];
  const excludeMeRaw = value["excludeMeFromParticipantList"];

  if (
    typeof defaultUsernameRaw !== "string" ||
    !isRecord(workspaceUsernamesRaw) ||
    typeof excludeMeRaw !== "boolean"
  ) {
    return undefined;
  }

  const workspaceUsernames: Record<string, string> = {};
  for (
    const [workspaceIdRaw, usernameRaw] of Object.entries(workspaceUsernamesRaw)
  ) {
    if (typeof usernameRaw !== "string") {
      return undefined;
    }
    const workspaceId = workspaceIdRaw.trim();
    if (workspaceId.length === 0) {
      return undefined;
    }
    try {
      workspaceUsernames[workspaceId] = validateAndNormalizeParticipantUsername(
        usernameRaw,
        `participants.workspaceUsernames[${workspaceId}]`,
      );
    } catch {
      return undefined;
    }
  }

  let defaultUsername = "";
  try {
    defaultUsername = validateAndNormalizeParticipantUsername(
      defaultUsernameRaw,
      "participants.defaultUsername",
      { allowEmpty: true },
    );
  } catch {
    return undefined;
  }

  return {
    defaultUsername,
    workspaceUsernames,
    excludeMeFromParticipantList: excludeMeRaw,
  };
}

function parseUserConfig(value: unknown): UserConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!USER_CONFIG_KEYS.includes(key as UserConfigKey)) {
      return undefined;
    }
  }

  if (value["schemaVersion"] !== USER_CONFIG_SCHEMA_VERSION) {
    return undefined;
  }

  const participants = parseParticipants(value["participants"]);
  if (!participants) {
    return undefined;
  }

  return {
    schemaVersion: USER_CONFIG_SCHEMA_VERSION,
    participants,
  };
}

function cloneUserConfig(config: UserConfig): UserConfig {
  return {
    schemaVersion: config.schemaVersion,
    participants: {
      defaultUsername: config.participants.defaultUsername,
      workspaceUsernames: { ...config.participants.workspaceUsernames },
      excludeMeFromParticipantList:
        config.participants.excludeMeFromParticipantList,
    },
  };
}

async function writeTextAtomically(path: string, value: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tempPath, value);
  await Deno.rename(tempPath, path);
}

export function createDefaultUserConfig(
  participants?: Partial<UserParticipantsConfig>,
): UserConfig {
  return {
    schemaVersion: USER_CONFIG_SCHEMA_VERSION,
    participants: {
      defaultUsername: participants?.defaultUsername ?? "",
      workspaceUsernames: { ...(participants?.workspaceUsernames ?? {}) },
      excludeMeFromParticipantList:
        participants?.excludeMeFromParticipantList ?? true,
    },
  };
}

export function resolveDefaultUserConfigPath(): string {
  const home = resolveHomeDir();
  if (!home) {
    throw new Error(
      "Unable to resolve home directory for user config path (~/.kato/kato-user-config.yaml)",
    );
  }
  return join(home, ".kato", USER_CONFIG_FILENAME);
}

export class UserConfigFileStore implements UserConfigStoreLike {
  constructor(private readonly configPath: string) {}

  async load(): Promise<UserConfig> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("User config path must end with .yaml");
    }

    const raw = await Deno.readTextFile(this.configPath);
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new Error("User config file contains invalid YAML");
    }

    const config = parseUserConfig(parsed);
    if (!config) {
      throw new Error("User config file has unsupported schema");
    }

    return cloneUserConfig(config);
  }

  async ensureInitialized(
    defaultConfig: UserConfig = createDefaultUserConfig(),
  ): Promise<EnsureUserConfigResult> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("User config path must end with .yaml");
    }

    try {
      const loaded = await this.load();
      return {
        created: false,
        path: this.configPath,
        config: cloneUserConfig(loaded),
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const clonedDefault = cloneUserConfig(defaultConfig);
    await writeTextAtomically(
      this.configPath,
      `${stringifyYaml(clonedDefault).trimEnd()}\n`,
    );

    return {
      created: true,
      path: this.configPath,
      config: clonedDefault,
    };
  }

  async save(config: UserConfig): Promise<void> {
    if (!isYamlConfigPath(this.configPath)) {
      throw new Error("User config path must end with .yaml");
    }

    const parsed = parseUserConfig(config as unknown);
    if (!parsed) {
      throw new Error("User config has unsupported schema");
    }

    await writeTextAtomically(
      this.configPath,
      `${stringifyYaml(cloneUserConfig(parsed)).trimEnd()}\n`,
    );
  }
}
