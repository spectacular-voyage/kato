import type {
  MarkdownFrontmatterConfig,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
} from "@kato/shared";
import { join } from "@std/path";
import {
  DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE,
  DEFAULT_WORKSPACE_TIMEZONE,
  type DendronWikilinkContextMode,
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
  type RegisteredWorkspace,
  resolveDefaultKatoDir,
  resolveDefaultWorkspaceRegistryPath,
  resolveDendronWikilinkContext,
  type ResolvedWorkspaceConfigValues,
  resolveWorkspaceConfigValues,
  WorkspaceRegistryFileStore,
} from "@kato/runtime";
import { resolveWorkspaceDefaultOutputDir } from "../../../daemon/src/orchestrator/runtime_workspace_paths.ts";
import { formatWorkspaceRegistryError } from "./status.ts";

export interface WorkspaceConfigEditRawValues {
  autoRecordConversations?: boolean;
  defaultOutputDir?: string;
  filenameTemplate?: string;
  workspaceTimezone?: string;
  defaultTags?: string[];
  tagSuggestions?: string[];
  markdownFrontmatter?: Partial<MarkdownFrontmatterConfig>;
  writerFeatureFlags: Partial<SessionWorkspaceAttachmentWriterFeatureFlagsV1>;
}

export interface WorkspaceConfigEditDiagnostics {
  wikilinkContextMode?: DendronWikilinkContextMode;
  dendronConfigPath?: string;
  wikilinkifiableRoots?: string[];
}

export interface WorkspaceConfigEditPageData {
  workspace: RegisteredWorkspace;
  raw?: WorkspaceConfigEditRawValues;
  effective?: ResolvedWorkspaceConfigValues;
  configError?: string;
  diagnostics: WorkspaceConfigEditDiagnostics;
}

export interface LoadWorkspaceConfigEditPageDataOptions {
  katoDir?: string;
}

const WORKSPACE_DIAGNOSTIC_PROVIDER = "workspace";
const WORKSPACE_DIAGNOSTIC_SESSION_ID = "workspace-diagnostic";
const WORKSPACE_DIAGNOSTIC_OUTPUT_USERNAME = "workspace";
const WORKSPACE_DIAGNOSTIC_SNIPPET = "workspace";
const WORKSPACE_DIAGNOSTIC_NOW = new Date("2000-01-01T00:00:00.000Z");

function cloneRegisteredWorkspace(
  entry: RegisteredWorkspace,
): RegisteredWorkspace {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    registeredAt: entry.registeredAt,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

function findWorkspaceBySelector(
  entries: RegisteredWorkspace[],
  selector: string,
): RegisteredWorkspace | undefined {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const match = entries.find((entry) =>
    entry.workspaceId === trimmed || entry.alias === trimmed
  );
  return match ? cloneRegisteredWorkspace(match) : undefined;
}

function formatConfigError(error: unknown): string {
  if (error instanceof Deno.errors.NotFound) {
    return "config file not found";
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return "permission denied while reading config";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}

function resolveDiagnosticDefaultOutputDir(options: {
  workspaceRoot: string;
  defaultOutputDirTemplate: string;
  workspaceTimezone: string;
}): string | undefined {
  try {
    return resolveWorkspaceDefaultOutputDir({
      profile: {
        workspaceRoot: options.workspaceRoot,
        defaultOutputDirTemplate: options.defaultOutputDirTemplate,
        filenameTemplate: "{timestampHumane}-{provider}.md",
        workspaceTimezone: options.workspaceTimezone,
      },
      provider: WORKSPACE_DIAGNOSTIC_PROVIDER,
      sessionId: WORKSPACE_DIAGNOSTIC_SESSION_ID,
      now: WORKSPACE_DIAGNOSTIC_NOW,
      outputUsername: WORKSPACE_DIAGNOSTIC_OUTPUT_USERNAME,
      snapshotSnippet: WORKSPACE_DIAGNOSTIC_SNIPPET,
    });
  } catch {
    return undefined;
  }
}

async function loadWikilinkDiagnostics(
  workspace: RegisteredWorkspace,
  effective: ResolvedWorkspaceConfigValues,
): Promise<WorkspaceConfigEditDiagnostics> {
  const resolvedDefaultOutputDir = resolveDiagnosticDefaultOutputDir({
    workspaceRoot: workspace.workspaceRoot,
    defaultOutputDirTemplate: effective.defaultOutputDir,
    workspaceTimezone: effective.workspaceTimezone,
  }) ??
    resolveDiagnosticDefaultOutputDir({
      workspaceRoot: workspace.workspaceRoot,
      defaultOutputDirTemplate: DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE,
      workspaceTimezone: effective.workspaceTimezone ??
        DEFAULT_WORKSPACE_TIMEZONE,
    });
  if (!resolvedDefaultOutputDir) {
    return {};
  }

  try {
    const context = await resolveDendronWikilinkContext(
      join(resolvedDefaultOutputDir, "__kato-wikilink-probe__.md"),
    );
    return {
      wikilinkContextMode: context.mode,
      dendronConfigPath: context.dendronConfigPath,
      wikilinkifiableRoots: [...context.wikilinkifiableRoots],
    };
  } catch {
    return {};
  }
}

export async function loadWorkspaceConfigEditPageData(
  selector: string,
  options: LoadWorkspaceConfigEditPageDataOptions = {},
): Promise<WorkspaceConfigEditPageData | undefined> {
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const registryStore = new WorkspaceRegistryFileStore(
    resolveDefaultWorkspaceRegistryPath(katoDir),
  );

  let entries: RegisteredWorkspace[];
  try {
    entries = await registryStore.load();
  } catch (error) {
    throw new Error(formatWorkspaceRegistryError(error));
  }

  const workspace = findWorkspaceBySelector(entries, selector);
  if (!workspace) {
    return undefined;
  }

  try {
    const overrides = await loadWorkspaceConfigOverrides(workspace.configPath);
    const configuredWorkspaceId = await readWorkspaceConfigWorkspaceId(
      workspace.configPath,
      { allowMissing: true },
    );
    if (
      configuredWorkspaceId && configuredWorkspaceId !== workspace.workspaceId
    ) {
      throw new Error(
        `workspaceId mismatch (registry=${workspace.workspaceId}, config=${configuredWorkspaceId})`,
      );
    }
    const effective = resolveWorkspaceConfigValues(overrides);
    const diagnostics = await loadWikilinkDiagnostics(workspace, effective);
    return {
      workspace,
      raw: {
        ...(overrides.autoRecordConversations !== undefined
          ? { autoRecordConversations: overrides.autoRecordConversations }
          : {}),
        ...(overrides.defaultOutputDir !== undefined
          ? { defaultOutputDir: overrides.defaultOutputDir }
          : {}),
        ...(overrides.filenameTemplate !== undefined
          ? { filenameTemplate: overrides.filenameTemplate }
          : {}),
        ...(overrides.workspaceTimezone !== undefined
          ? { workspaceTimezone: overrides.workspaceTimezone }
          : {}),
        ...(overrides.defaultTags !== undefined
          ? { defaultTags: [...overrides.defaultTags] }
          : {}),
        ...(overrides.tagSuggestions !== undefined
          ? { tagSuggestions: [...overrides.tagSuggestions] }
          : {}),
        ...(overrides.markdownFrontmatter
          ? { markdownFrontmatter: { ...overrides.markdownFrontmatter } }
          : {}),
        writerFeatureFlags: { ...overrides.writerFeatureFlags },
      },
      effective,
      diagnostics,
    };
  } catch (error) {
    return {
      workspace,
      configError: formatConfigError(error),
      diagnostics: {},
    };
  }
}
