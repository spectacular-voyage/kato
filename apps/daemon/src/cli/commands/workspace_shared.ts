import { dirname, join, resolve } from "@std/path";
import type { DaemonCliCommandContext } from "./context.ts";
import {
  createWorkspaceConfigScaffold,
  DefaultWorkspaceConfigFileStore,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  findNearestWorkspaceConfig,
  isPathWithinRoots,
  type RegisteredWorkspace,
  resolveDefaultWorkspaceTemplateConfigPath,
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
  dirPath?: string,
): Promise<{ workspaceRoot: string; configPath: string }> {
  if (dirPath) {
    const workspaceRoot = resolve(requireCliCwd(ctx), dirPath);
    const configPath = await resolveWorkspaceConfigPath(workspaceRoot);
    if (!configPath) {
      throw new Error(
        `No workspace config found at ${join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME)}. Run \`kato workspace init ${dirPath}\` first.`,
      );
    }
    return { workspaceRoot, configPath };
  }

  const located = await findNearestWorkspaceConfig(requireCliCwd(ctx));
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
  content: string = createWorkspaceConfigScaffold(),
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
  await Deno.writeTextFile(configPath, content);
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

export async function loadWorkspaceTemplateScaffold(
  ctx: DaemonCliCommandContext,
): Promise<string> {
  const templatePath = resolveDefaultWorkspaceTemplateConfigPath(
    ctx.runtime.configPath,
  );
  const store = new DefaultWorkspaceConfigFileStore(templatePath);
  const loaded = await store.load({ allowMissing: true });
  if (!loaded) {
    return createWorkspaceConfigScaffold();
  }
  const raw = await Deno.readTextFile(templatePath);
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}
