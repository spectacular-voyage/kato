import type { ConversationEvent } from "@kato/shared";
import { extractSnippet } from "@kato/shared";
import { isAbsolute, relative, resolve } from "@std/path";

export interface WorkspacePathTemplateProfile {
  workspaceRoot: string;
  defaultOutputDirTemplate: string;
  filenameTemplate: string;
  workspaceTimezone: string;
}

export interface WorkspacePathTemplateOptions {
  profile: WorkspacePathTemplateProfile;
  provider: string;
  sessionId: string;
  now: Date;
  outputUsername: string;
  filenameSlug?: string;
  snapshotSnippet?: string;
  boundarySnapshot?: ConversationEvent[];
}

function sanitizeFilenamePart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "recording";
}

function slugifySnippetForFilename(value: string): string | undefined {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(/\r\n?|\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function resolveFilenameSnippet(options: {
  filenameSlug?: string;
  snapshotSnippet?: string;
  boundarySnapshot?: ConversationEvent[];
}): string {
  const fromFilenameSlug = firstNonEmptyLine(options.filenameSlug);
  if (fromFilenameSlug) {
    const normalized = slugifySnippetForFilename(fromFilenameSlug);
    if (normalized) {
      return normalized;
    }
  }
  const fromSnapshot = firstNonEmptyLine(options.snapshotSnippet);
  if (fromSnapshot) {
    return fromSnapshot;
  }
  const fromBoundary = firstNonEmptyLine(
    extractSnippet(options.boundarySnapshot ?? []),
  );
  if (fromBoundary) {
    return fromBoundary;
  }
  return "conversation";
}

function readDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function readTimestampTemplateParts(
  now: Date,
  timeZone: string,
): {
  YYYY: string;
  YY: string;
  MM: string;
  DD: string;
  HH: string;
  mm: string;
  timestampHumane: string;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === "local" ? {} : { timeZone }),
  });
  const parts = formatter.formatToParts(now);
  const year = readDatePart(parts, "year");
  const month = readDatePart(parts, "month");
  const day = readDatePart(parts, "day");
  const hour = readDatePart(parts, "hour");
  const minute = readDatePart(parts, "minute");
  return {
    YYYY: year,
    YY: year.slice(-2),
    MM: month,
    DD: day,
    HH: hour,
    mm: minute,
    timestampHumane: `${year}-${month}-${day}_${hour}${minute}`,
  };
}

function buildWorkspaceTemplateTokens(
  options: WorkspacePathTemplateOptions,
): Record<string, string> {
  const timestampTokens = readTimestampTemplateParts(
    options.now,
    options.profile.workspaceTimezone,
  );
  return {
    provider: sanitizeFilenamePart(options.provider),
    sessionId: sanitizeFilenamePart(options.sessionId),
    sessionShortId: sanitizeFilenamePart(options.sessionId.slice(0, 8)),
    YYYY: timestampTokens.YYYY,
    YY: timestampTokens.YY,
    MM: timestampTokens.MM,
    DD: timestampTokens.DD,
    HH: timestampTokens.HH,
    mm: timestampTokens.mm,
    timestampHumane: timestampTokens.timestampHumane,
    snippetSlug: slugifySnippetForFilename(resolveFilenameSnippet(options)) ??
      "conversation",
    username: sanitizeFilenamePart(options.outputUsername),
  };
}

function renderWorkspaceTemplate(
  template: string,
  tokens: Record<string, string>,
): string {
  let rendered = template;
  for (const [token, replacement] of Object.entries(tokens)) {
    rendered = rendered.replaceAll(`{${token}}`, replacement);
  }
  return rendered;
}

export function renderWorkspaceFilename(
  options: WorkspacePathTemplateOptions,
): string {
  const tokens = buildWorkspaceTemplateTokens(options);
  const rendered = renderWorkspaceTemplate(
    options.profile.filenameTemplate,
    tokens,
  );
  const normalized = rendered
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 && normalized !== "." && normalized !== ".."
    ? normalized
    : `${tokens.timestampHumane}-${tokens.snippetSlug}-${tokens.provider}.md`;
}

function isWithinWorkspaceRoot(
  workspaceRoot: string,
  candidatePath: string,
): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveWorkspaceDefaultOutputDir(
  options: WorkspacePathTemplateOptions,
): string {
  const tokens = buildWorkspaceTemplateTokens(options);
  const rendered = renderWorkspaceTemplate(
    options.profile.defaultOutputDirTemplate,
    tokens,
  );
  const resolvedPath = isAbsolute(rendered)
    ? resolve(rendered)
    : resolve(options.profile.workspaceRoot, rendered);
  if (!isWithinWorkspaceRoot(options.profile.workspaceRoot, resolvedPath)) {
    throw new Error(
      "defaultOutputDir must resolve within the workspace root",
    );
  }
  return resolvedPath;
}
