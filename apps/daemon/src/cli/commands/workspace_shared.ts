import { dirname, join, resolve } from "@std/path";
import type { DaemonCliCommandContext } from "./context.ts";
import {
  createWorkspaceConfigScaffold,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  defaultAliasForWorkspaceRoot,
  findNearestWorkspaceConfig,
  isPathWithinRoots,
  type RegisteredWorkspace,
  resolveDefaultWorkspaceRegistryPath,
  resolveWorkspaceConfigPath,
  WorkspaceRegistryFileStore,
} from "../../workspace/mod.ts";

export function requireCliCwd(ctx: DaemonCliCommandContext): string {
  const cwd = ctx.runtime.cwdPath;
  if (!cwd) {
    throw new Error("Current working directory is unavailable");
  }
  return resolve(cwd);
}

export function resolveWorkspaceRegistryStore(
  ctx: DaemonCliCommandContext,
): WorkspaceRegistryFileStore {
  const katoDir = ctx.runtimeConfig.katoDir ??
    dirname(ctx.runtimeConfig.runtimeDir);
  return new WorkspaceRegistryFileStore(
    resolveDefaultWorkspaceRegistryPath(katoDir),
  );
}

export function validateWorkspaceAlias(alias: string): string {
  const trimmed = alias.trim();
  if (trimmed.length === 0) {
    throw new Error("Workspace alias must be a non-empty string");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("Workspace alias must not contain spaces");
  }
  return trimmed;
}

export async function resolveRegisterTarget(
  ctx: DaemonCliCommandContext,
): Promise<{ workspaceRoot: string; configPath: string }> {
  const cwd = requireCliCwd(ctx);
  const located = await findNearestWorkspaceConfig(cwd);
  if (!located) {
    throw new Error(
      `No workspace config found. Run \`kato workspace init\` to create ./${DEFAULT_WORKSPACE_CONFIG_FILENAME} from the default template first.`,
    );
  }
  return located;
}

export async function resolveWorkspaceInitPath(
  ctx: DaemonCliCommandContext,
  dirPath: string | undefined,
): Promise<{ workspaceRoot: string; configPath: string }> {
  const baseDir = dirPath
    ? resolve(requireCliCwd(ctx), dirPath)
    : requireCliCwd(ctx);
  const workspaceRoot = baseDir;
  const existingPath = await resolveWorkspaceConfigPath(workspaceRoot);
  if (existingPath) {
    return { workspaceRoot, configPath: existingPath };
  }
  return {
    workspaceRoot,
    configPath: join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME),
  };
}

export async function ensureWorkspaceConfigInitialized(
  configPath: string,
): Promise<boolean> {
  try {
    const stat = await Deno.stat(configPath);
    if (stat.isFile) {
      return false;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  await Deno.mkdir(dirname(configPath), { recursive: true });
  await Deno.writeTextFile(configPath, createWorkspaceConfigScaffold());
  return true;
}

export function findWorkspaceByRoot(
  entries: RegisteredWorkspace[],
  workspaceRoot: string,
  configPath: string,
): RegisteredWorkspace | undefined {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedConfigPath = resolve(configPath);
  return entries.find((entry) =>
    resolve(entry.workspaceRoot) === resolvedRoot ||
    resolve(entry.configPath) === resolvedConfigPath
  );
}

export function formatWorkspaceEntry(entry: RegisteredWorkspace): string {
  return `${entry.alias} (${entry.workspaceId}) root=${entry.workspaceRoot} config=${entry.configPath}`;
}

export function shouldWarnWriteRootCoverage(
  ctx: DaemonCliCommandContext,
  workspaceRoot: string,
): boolean {
  const roots = ctx.runtime.allowedWriteRoots ?? [];
  if (roots.length === 0) {
    return true;
  }
  return !isPathWithinRoots(workspaceRoot, roots);
}

export function deriveDefaultAlias(workspaceRoot: string): string {
  return validateWorkspaceAlias(defaultAliasForWorkspaceRoot(workspaceRoot));
}
