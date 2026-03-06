import type { MarkdownFrontmatterConfig, UserConfig } from "@kato/shared";
import { validateAndNormalizeParticipantUsername } from "./user_config.ts";

interface ResolveParticipantUsernameOptions {
  markdownFrontmatter: MarkdownFrontmatterConfig;
  userConfig: UserConfig;
  workspaceId?: string;
}

interface ResolvePreferredParticipantUsernameOptions {
  userConfig: UserConfig;
  workspaceId?: string;
}

function readDefaultUsername(userConfig: UserConfig): string | undefined {
  const normalized = validateAndNormalizeParticipantUsername(
    userConfig.participants.defaultUsername,
    "participants.defaultUsername",
    { allowEmpty: true },
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readWorkspaceUsername(
  userConfig: UserConfig,
  workspaceId: string,
): string | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(
      userConfig.participants.workspaceUsernames,
      workspaceId,
    )
  ) {
    return undefined;
  }

  const mapped = userConfig.participants.workspaceUsernames[workspaceId];
  if (mapped === undefined) {
    return undefined;
  }
  return validateAndNormalizeParticipantUsername(
    mapped,
    `participants.workspaceUsernames[${workspaceId}]`,
  );
}

export function resolvePreferredParticipantUsername(
  options: ResolvePreferredParticipantUsernameOptions,
): string | undefined {
  if (options.workspaceId) {
    const workspaceUsername = readWorkspaceUsername(
      options.userConfig,
      options.workspaceId,
    );
    if (workspaceUsername) {
      return workspaceUsername;
    }
  }
  return readDefaultUsername(options.userConfig);
}

export function resolveFrontmatterParticipantUsername(
  options: ResolveParticipantUsernameOptions,
): string | undefined {
  const {
    markdownFrontmatter,
    userConfig,
    workspaceId,
  } = options;

  if (!markdownFrontmatter.addParticipantUsernameToFrontmatter) {
    return undefined;
  }

  if (userConfig.participants.excludeMeFromParticipantList) {
    return undefined;
  }

  return resolvePreferredParticipantUsername({
    userConfig,
    workspaceId,
  });
}
