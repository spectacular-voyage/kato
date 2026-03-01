import type {
  RuntimeConfig,
  SessionMetadataV1,
  SessionWorkspaceAttachmentV1,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
} from "@kato/shared";
import { dirname, isAbsolute, join, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

const WORKSPACE_CONFIG_DIRNAME = ".kato";
const WORKSPACE_CONFIG_FILENAME = "kato-config.yaml";
const DEFAULT_OUTPUT_DIR_RELATIVE = ".kato/recordings";
const DEFAULT_FILENAME_TEMPLATE =
  "{provider}-{sessionShortId}-{timestampUtc}.md";
const WRITER_FEATURE_FLAG_KEYS = [
  "writerIncludeCommentary",
  "writerIncludeThinking",
  "writerIncludeToolCalls",
  "writerItalicizeUserMessages",
] as const;
const KNOWN_PROVIDER_PREFIXES = new Set(["claude", "codex", "gemini"]);

type WriterFeatureFlagKey = typeof WRITER_FEATURE_FLAG_KEYS[number];
type SessionSelectorMatch =
  | "provider_session_id"
  | "session_id"
  | "session_id_prefix";

interface WorkspaceConfigOverrides {
  defaultOutputDir?: string;
  filenameTemplate?: string;
  writerFeatureFlags: Partial<SessionWorkspaceAttachmentWriterFeatureFlagsV1>;
}

export interface ResolvedSessionSelector {
  metadata: SessionMetadataV1;
  matchedBy: SessionSelectorMatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeFilenameSegment(value: string): string {
  const normalized = value.toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "session";
}

function timestampUtcToken(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function sanitizeRenderedFilename(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const sanitized = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized;
}

function renderTemplate(
  template: string,
  metadata: SessionMetadataV1,
  now: Date,
): string {
  const tokens: Record<string, string> = {
    provider: normalizeFilenameSegment(metadata.provider),
    providerSessionId: normalizeFilenameSegment(metadata.providerSessionId),
    sessionId: normalizeFilenameSegment(metadata.sessionId),
    sessionShortId: normalizeFilenameSegment(metadata.sessionId.slice(0, 8)),
    snippetSlug: normalizeFilenameSegment(metadata.providerSessionId),
    timestampUtc: timestampUtcToken(now),
  };

  let rendered = template;
  for (const [token, replacement] of Object.entries(tokens)) {
    rendered = rendered.replaceAll(`{${token}}`, replacement);
  }

  return sanitizeRenderedFilename(rendered);
}

function parseSessionSelector(
  requestedSessionId: string,
): { provider?: string; selector: string } {
  const trimmed = requestedSessionId.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return { selector: trimmed };
  }

  const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
  const selector = trimmed.slice(slashIndex + 1).trim();
  if (
    selector.length === 0 || !KNOWN_PROVIDER_PREFIXES.has(provider)
  ) {
    return { selector: trimmed };
  }

  return { provider, selector };
}

function formatSessionLabel(metadata: SessionMetadataV1): string {
  return `${metadata.provider}/${
    metadata.sessionId.slice(0, 8)
  } (${metadata.providerSessionId})`;
}

export function formatAmbiguousSessionLabels(
  matches: SessionMetadataV1[],
): string {
  return matches.map((entry) => formatSessionLabel(entry)).join(", ");
}

export function resolveSessionSelector(
  selector: string,
  metadataList: SessionMetadataV1[],
): ResolvedSessionSelector {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new Error("Session selector is required");
  }

  const parsed = parseSessionSelector(trimmed);
  const scopedEntries = parsed.provider
    ? metadataList.filter((entry) =>
      entry.provider.toLowerCase() === parsed.provider
    )
    : metadataList;
  if (scopedEntries.length === 0) {
    throw new Error(`No sessions found for selector: ${selector}`);
  }
  if (parsed.selector.length === 0) {
    throw new Error("Session selector is required");
  }

  const matchers: Array<{
    kind: SessionSelectorMatch;
    matches: SessionMetadataV1[];
  }> = [{
    kind: "provider_session_id",
    matches: scopedEntries.filter((entry) =>
      entry.providerSessionId === parsed.selector
    ),
  }, {
    kind: "session_id",
    matches: scopedEntries.filter((entry) =>
      entry.sessionId === parsed.selector
    ),
  }, {
    kind: "session_id_prefix",
    matches: scopedEntries.filter((entry) =>
      entry.sessionId.startsWith(parsed.selector)
    ),
  }];

  for (const matcher of matchers) {
    if (matcher.matches.length === 1) {
      return {
        metadata: matcher.matches[0]!,
        matchedBy: matcher.kind,
      };
    }
    if (matcher.matches.length > 1) {
      throw new Error(
        `Session selector is ambiguous (${matcher.kind}): ${
          formatAmbiguousSessionLabels(matcher.matches)
        }`,
      );
    }
  }

  throw new Error(`No sessions matched selector: ${selector}`);
}

export async function discoverNearestWorkspaceConfigPath(
  startDir: string,
): Promise<string | undefined> {
  let cursor = resolve(startDir);
  while (true) {
    const candidate = join(
      cursor,
      WORKSPACE_CONFIG_DIRNAME,
      WORKSPACE_CONFIG_FILENAME,
    );
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isFile) {
        return candidate;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }
    cursor = parent;
  }
}

async function loadConfigOverrides(
  configPath: string,
  options: { allowMissing: boolean },
): Promise<WorkspaceConfigOverrides> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(configPath);
  } catch (error) {
    if (options.allowMissing && error instanceof Deno.errors.NotFound) {
      return { writerFeatureFlags: {} };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    throw new Error(`Config file contains invalid YAML: ${configPath}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Config file must contain a YAML object: ${configPath}`);
  }

  const defaultOutputDirRaw = parsed["defaultOutputDir"];
  if (
    defaultOutputDirRaw !== undefined &&
    trimOptionalString(defaultOutputDirRaw) === undefined
  ) {
    throw new Error(
      `defaultOutputDir must be a non-empty string: ${configPath}`,
    );
  }
  const filenameTemplateRaw = parsed["filenameTemplate"];
  if (
    filenameTemplateRaw !== undefined &&
    trimOptionalString(filenameTemplateRaw) === undefined
  ) {
    throw new Error(
      `filenameTemplate must be a non-empty string: ${configPath}`,
    );
  }

  const writerFeatureFlags: Partial<
    SessionWorkspaceAttachmentWriterFeatureFlagsV1
  > = {};
  const featureFlagsRaw = parsed["featureFlags"];
  if (featureFlagsRaw !== undefined) {
    if (!isRecord(featureFlagsRaw)) {
      throw new Error(
        `featureFlags must be an object when present: ${configPath}`,
      );
    }
    for (const key of WRITER_FEATURE_FLAG_KEYS) {
      const value = featureFlagsRaw[key];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "boolean") {
        throw new Error(`featureFlags.${key} must be a boolean: ${configPath}`);
      }
      writerFeatureFlags[key] = value;
    }
  }

  return {
    ...(trimOptionalString(defaultOutputDirRaw)
      ? { defaultOutputDir: trimOptionalString(defaultOutputDirRaw) }
      : {}),
    ...(trimOptionalString(filenameTemplateRaw)
      ? { filenameTemplate: trimOptionalString(filenameTemplateRaw) }
      : {}),
    writerFeatureFlags,
  };
}

function resolveWriterFeatureFlags(
  runtimeConfig: RuntimeConfig,
  workspaceOverrides: WorkspaceConfigOverrides,
): SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  return {
    writerIncludeCommentary:
      workspaceOverrides.writerFeatureFlags.writerIncludeCommentary ??
        runtimeConfig.featureFlags.writerIncludeCommentary,
    writerIncludeThinking:
      workspaceOverrides.writerFeatureFlags.writerIncludeThinking ??
        runtimeConfig.featureFlags.writerIncludeThinking,
    writerIncludeToolCalls:
      workspaceOverrides.writerFeatureFlags.writerIncludeToolCalls ??
        runtimeConfig.featureFlags.writerIncludeToolCalls,
    writerItalicizeUserMessages:
      workspaceOverrides.writerFeatureFlags.writerItalicizeUserMessages ??
        runtimeConfig.featureFlags.writerItalicizeUserMessages,
  };
}

export async function synthesizeWorkspaceAttachment(options: {
  globalConfigPath: string;
  workspaceConfigPath: string;
  workspaceRoot: string;
  runtimeConfig: RuntimeConfig;
  now: Date;
}): Promise<SessionWorkspaceAttachmentV1> {
  const globalOverrides = await loadConfigOverrides(options.globalConfigPath, {
    allowMissing: true,
  });
  const workspaceOverrides = await loadConfigOverrides(
    options.workspaceConfigPath,
    {
      allowMissing: false,
    },
  );

  const defaultOutputDir = workspaceOverrides.defaultOutputDir ??
    globalOverrides.defaultOutputDir ??
    DEFAULT_OUTPUT_DIR_RELATIVE;
  const resolvedDefaultOutputDir = isAbsolute(defaultOutputDir)
    ? resolve(defaultOutputDir)
    : resolve(options.workspaceRoot, defaultOutputDir);
  const filenameTemplate = workspaceOverrides.filenameTemplate ??
    globalOverrides.filenameTemplate ??
    DEFAULT_FILENAME_TEMPLATE;

  return {
    attachedAt: options.now.toISOString(),
    sourceConfigPath: options.workspaceConfigPath,
    workspaceRoot: resolve(options.workspaceRoot),
    resolvedDefaultOutputDir,
    filenameTemplate,
    writerFeatureFlags: resolveWriterFeatureFlags(
      options.runtimeConfig,
      workspaceOverrides,
    ),
  };
}

async function isDirectoryTarget(path: string): Promise<boolean> {
  if (path.endsWith("/") || path.endsWith("\\")) {
    return true;
  }

  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

export function buildGeneratedOutputFilename(
  metadata: SessionMetadataV1,
  attachment: SessionWorkspaceAttachmentV1,
  now: Date,
): string {
  const rendered = renderTemplate(attachment.filenameTemplate, metadata, now);
  if (rendered.length > 0) {
    return rendered;
  }
  return renderTemplate(DEFAULT_FILENAME_TEMPLATE, metadata, now);
}

export async function resolveAttachmentOutputPath(options: {
  outputPath: string;
  metadata: SessionMetadataV1;
  attachment: SessionWorkspaceAttachmentV1;
  now: Date;
}): Promise<string> {
  const trimmed = options.outputPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Output path is empty");
  }

  const resolvedPath = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(options.attachment.workspaceRoot, trimmed);

  if (await isDirectoryTarget(resolvedPath)) {
    return join(
      resolvedPath,
      buildGeneratedOutputFilename(
        options.metadata,
        options.attachment,
        options.now,
      ),
    );
  }

  return resolvedPath;
}

export function defaultWorkspaceRoot(runtimeConfig: RuntimeConfig): string {
  return resolve(runtimeConfig.katoDir ?? dirname(runtimeConfig.runtimeDir));
}
