import type { UserConfig, UserParticipantsConfig } from "@kato/shared";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { resolveHomeDir } from "../utils/env.ts";
import {
  isRecord,
  isYamlConfigPath,
  writeTextAtomically,
} from "./file_store_utils.ts";

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

function createUserConfigSchemaError(
  subject: "User config file" | "User config",
  detail: string,
): Error {
  return new Error(
    `${subject} has unsupported schema. ${detail} ` +
      "Expected UserConfig with schemaVersion: 1 and participants: UserParticipantsConfig. " +
      "UserParticipantsConfig requires defaultUsername (string), workspaceUsernames (Record<string, string>), " +
      "and excludeMeFromParticipantList (boolean). " +
      "Migration guidance: unknown keys or a missing schemaVersion require migrating to this shape " +
      "(or reinitialize with `kato user init`).",
  );
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

function parseParticipants(value: unknown): UserParticipantsConfig {
  if (!isRecord(value)) {
    throw new Error(
      "UserConfig.participants must be an object matching UserParticipantsConfig",
    );
  }

  const unknownParticipantKeys = Object.keys(value).filter((key) =>
    !USER_PARTICIPANTS_KEYS.includes(key as UserParticipantsKey)
  );
  if (unknownParticipantKeys.length > 0) {
    throw new Error(
      `Unknown UserParticipantsConfig keys: ${
        unknownParticipantKeys.join(", ")
      }`,
    );
  }

  const defaultUsernameRaw = value["defaultUsername"];
  const workspaceUsernamesRaw = value["workspaceUsernames"];
  const excludeMeRaw = value["excludeMeFromParticipantList"];

  if (typeof defaultUsernameRaw !== "string") {
    throw new Error("UserParticipantsConfig.defaultUsername must be a string");
  }
  if (!isRecord(workspaceUsernamesRaw)) {
    throw new Error(
      "UserParticipantsConfig.workspaceUsernames must be an object map",
    );
  }
  if (typeof excludeMeRaw !== "boolean") {
    throw new Error(
      "UserParticipantsConfig.excludeMeFromParticipantList must be a boolean",
    );
  }

  const workspaceUsernames: Record<string, string> = {};
  for (
    const [workspaceIdRaw, usernameRaw] of Object.entries(workspaceUsernamesRaw)
  ) {
    if (typeof usernameRaw !== "string") {
      throw new Error(
        `UserParticipantsConfig.workspaceUsernames[${workspaceIdRaw}] must be a string`,
      );
    }
    const workspaceId = workspaceIdRaw.trim();
    if (workspaceId.length === 0) {
      throw new Error(
        "UserParticipantsConfig.workspaceUsernames keys must be non-empty strings",
      );
    }
    workspaceUsernames[workspaceId] = validateAndNormalizeParticipantUsername(
      usernameRaw,
      `participants.workspaceUsernames[${workspaceId}]`,
    );
  }

  const defaultUsername = validateAndNormalizeParticipantUsername(
    defaultUsernameRaw,
    "participants.defaultUsername",
    { allowEmpty: true },
  );

  return {
    defaultUsername,
    workspaceUsernames,
    excludeMeFromParticipantList: excludeMeRaw,
  };
}

function parseUserConfig(
  value: unknown,
  subject: "User config file" | "User config" = "User config file",
): UserConfig {
  try {
    if (!isRecord(value)) {
      throw new Error("Expected a top-level object for UserConfig");
    }

    const unknownConfigKeys = Object.keys(value).filter((key) =>
      !USER_CONFIG_KEYS.includes(key as UserConfigKey)
    );
    if (unknownConfigKeys.length > 0) {
      throw new Error(
        `Unknown UserConfig keys: ${unknownConfigKeys.join(", ")}`,
      );
    }

    const schemaVersion = value["schemaVersion"];
    if (schemaVersion !== USER_CONFIG_SCHEMA_VERSION) {
      if (schemaVersion === undefined) {
        throw new Error("Missing required UserConfig.schemaVersion");
      }
      throw new Error(
        `Unsupported UserConfig.schemaVersion: ${String(schemaVersion)}`,
      );
    }

    const participants = parseParticipants(value["participants"]);
    return {
      schemaVersion: USER_CONFIG_SCHEMA_VERSION,
      participants,
    };
  } catch (error) {
    const detail = error instanceof Error
      ? error.message
      : "Unable to parse UserConfig";
    throw createUserConfigSchemaError(subject, detail);
  }
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

    const config = parseUserConfig(parsed, "User config file");
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

    const parsed = parseUserConfig(config as unknown, "User config");

    await writeTextAtomically(
      this.configPath,
      `${stringifyYaml(cloneUserConfig(parsed)).trimEnd()}\n`,
    );
  }
}
