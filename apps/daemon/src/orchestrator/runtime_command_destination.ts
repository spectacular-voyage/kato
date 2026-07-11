import type { ConversationEvent, SessionMetadataV1 } from "@kato/shared";
import { extname, isAbsolute, join, resolve } from "@std/path";
import type { RecordingPipelineLike } from "../writer/mod.ts";
import type { ResolvedWorkspaceProfile } from "../workspace/mod.ts";
import {
  renderWorkspaceFilename,
  resolveWorkspaceDefaultOutputDir,
} from "./runtime_workspace_paths.ts";
import { toWorkspaceDestinationBinding } from "./runtime_workspace_output_state.ts";

const MARKDOWN_LINK_PATH_PATTERN = /^\[[^\]]+\]\((.+)\)$/;

type WorkspaceOutputBinding = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number]["currentDestination"];

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function isDirectoryTargetPath(path: string): Promise<boolean> {
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

function unwrapMatchingDelimiters(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "`" && last === "`")
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

export function normalizeRawCommandTargetPath(
  rawArgument: string | undefined,
): string | undefined {
  if (!rawArgument) return undefined;

  let normalized = rawArgument.trim();
  if (normalized.length === 0) return undefined;

  const markdownMatch = normalized.match(MARKDOWN_LINK_PATH_PATTERN);
  if (markdownMatch?.[1]) {
    normalized = markdownMatch[1].trim();
  }

  normalized = unwrapMatchingDelimiters(normalized);
  return normalized.length > 0 ? normalized : undefined;
}

export async function resolveUniqueNonExistingPath(
  path: string,
): Promise<string> {
  if (!(await pathExists(path))) {
    return path;
  }
  const suffix = extname(path);
  const prefix = suffix.length > 0 ? path.slice(0, -suffix.length) : path;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${prefix}-${index}${suffix}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve unique destination path for: ${path}`);
}

export async function resolveWorkspaceCommandDestination(options: {
  profile: ResolvedWorkspaceProfile;
  provider: string;
  sessionId: string;
  outputUsername: string;
  filenameSlug?: string;
  snapshotSnippet?: string;
  boundarySnapshot?: ConversationEvent[];
  rawArgument?: string;
  ensureGeneratedPathUnique?: boolean;
  now: Date;
}): Promise<{
  resolvedPath: string;
  resolvedDefaultOutputDir: string;
  usesGeneratedFilename: boolean;
  binding: WorkspaceOutputBinding;
}> {
  const resolvedDefaultOutputDir = resolveWorkspaceDefaultOutputDir({
    profile: options.profile,
    provider: options.provider,
    sessionId: options.sessionId,
    now: options.now,
    outputUsername: options.outputUsername,
    filenameSlug: options.filenameSlug,
    snapshotSnippet: options.snapshotSnippet,
    boundarySnapshot: options.boundarySnapshot,
  });
  const normalized = normalizeRawCommandTargetPath(options.rawArgument);
  if (!normalized) {
    const generatedPath = join(
      resolvedDefaultOutputDir,
      renderWorkspaceFilename({
        profile: options.profile,
        provider: options.provider,
        sessionId: options.sessionId,
        now: options.now,
        outputUsername: options.outputUsername,
        filenameSlug: options.filenameSlug,
        snapshotSnippet: options.snapshotSnippet,
        boundarySnapshot: options.boundarySnapshot,
      }),
    );
    const generated = options.ensureGeneratedPathUnique
      ? await resolveUniqueNonExistingPath(generatedPath)
      : generatedPath;
    return {
      resolvedPath: generated,
      resolvedDefaultOutputDir,
      usesGeneratedFilename: true,
      binding: toWorkspaceDestinationBinding(options.profile, generated),
    };
  }
  if (normalized.startsWith("@")) {
    throw new Error(
      "Path argument must be a filesystem path (mentions are not allowed)",
    );
  }
  const hasTrailingSeparator = /[\\/]$/.test(normalized);
  const resolvedBase = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(options.profile.workspaceRoot, normalized);
  const generatedFromDirectory = hasTrailingSeparator ||
    await isDirectoryTargetPath(resolvedBase);
  const resolvedPathBase = generatedFromDirectory
    ? join(
      resolvedBase,
      renderWorkspaceFilename({
        profile: options.profile,
        provider: options.provider,
        sessionId: options.sessionId,
        now: options.now,
        outputUsername: options.outputUsername,
        filenameSlug: options.filenameSlug,
        snapshotSnippet: options.snapshotSnippet,
        boundarySnapshot: options.boundarySnapshot,
      }),
    )
    : resolvedBase;
  const resolvedPath =
    options.ensureGeneratedPathUnique && generatedFromDirectory
      ? await resolveUniqueNonExistingPath(resolvedPathBase)
      : resolvedPathBase;
  return {
    resolvedPath,
    resolvedDefaultOutputDir,
    usesGeneratedFilename: generatedFromDirectory,
    binding: isAbsolute(normalized)
      ? {
        kind: "absolute-explicit",
        absolutePath: resolvedPath,
      }
      : toWorkspaceDestinationBinding(options.profile, resolvedPath),
  };
}

export async function validateDestinationPathForCommand(
  recordingPipeline: RecordingPipelineLike,
  provider: string,
  sessionId: string,
  destination: string,
  commandName: "record" | "capture" | "export",
): Promise<string> {
  if (!recordingPipeline.validateDestinationPath) {
    return destination;
  }
  return await recordingPipeline.validateDestinationPath({
    provider,
    sessionId,
    targetPath: destination,
    commandName,
  });
}
