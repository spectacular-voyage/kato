import type { RegisteredWorkspace } from "@kato/runtime";

export interface WorkspaceStatusRow {
  workspaceId: string;
  alias: string;
  workspaceRoot: string;
  configPath: string;
  valid: boolean;
  invalidReason?: string;
}

export interface WorkspaceStatusSummary {
  activeCount: number;
  invalidCount: number;
  rows: WorkspaceStatusRow[];
  unavailableReason?: string;
}

function sanitizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatWorkspaceValidationError(error: unknown): string {
  if (error instanceof Deno.errors.NotFound) {
    return "config file not found";
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return "permission denied while reading config";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return sanitizeInlineText(error.message);
  }
  return sanitizeInlineText(String(error));
}

function formatWorkspaceRegistryValidationError(error: unknown): string {
  if (error instanceof Deno.errors.NotFound) {
    return "workspace registry file not found";
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return "permission denied while reading workspace registry";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return `workspace registry load failed: ${
      sanitizeInlineText(error.message)
    }`;
  }
  return `workspace registry load failed: ${sanitizeInlineText(String(error))}`;
}

function toWorkspaceStatusRow(
  entry: RegisteredWorkspace,
  opts: { valid: boolean; invalidReason?: string },
): WorkspaceStatusRow {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    valid: opts.valid,
    ...(opts.invalidReason ? { invalidReason: opts.invalidReason } : {}),
  };
}

async function validateWorkspaceEntry(
  entry: RegisteredWorkspace,
  deps: {
    loadWorkspaceConfigOverrides: (configPath: string) => Promise<unknown>;
    readWorkspaceConfigWorkspaceId: (
      configPath: string,
      options: { allowMissing: boolean },
    ) => Promise<string | undefined>;
  },
): Promise<WorkspaceStatusRow> {
  try {
    await deps.loadWorkspaceConfigOverrides(entry.configPath);
    const configuredWorkspaceId = await deps.readWorkspaceConfigWorkspaceId(
      entry.configPath,
      { allowMissing: true },
    );
    if (
      configuredWorkspaceId &&
      configuredWorkspaceId !== entry.workspaceId
    ) {
      return toWorkspaceStatusRow(entry, {
        valid: false,
        invalidReason:
          `workspaceId mismatch (registry=${entry.workspaceId}, config=${configuredWorkspaceId})`,
      });
    }
    return toWorkspaceStatusRow(entry, { valid: true });
  } catch (error) {
    return toWorkspaceStatusRow(entry, {
      valid: false,
      invalidReason: formatWorkspaceValidationError(error),
    });
  }
}

export async function buildWorkspaceStatusSummary(
  entries: RegisteredWorkspace[],
  deps: {
    loadWorkspaceConfigOverrides: (configPath: string) => Promise<unknown>;
    readWorkspaceConfigWorkspaceId: (
      configPath: string,
      options: { allowMissing: boolean },
    ) => Promise<string | undefined>;
  },
): Promise<WorkspaceStatusSummary> {
  const rows = await Promise.all(
    entries.map((entry) => validateWorkspaceEntry(entry, deps)),
  );
  rows.sort((a, b) =>
    a.alias.localeCompare(b.alias) ||
    a.workspaceId.localeCompare(b.workspaceId)
  );

  const activeCount = rows.filter((row) => row.valid).length;
  return {
    activeCount,
    invalidCount: rows.length - activeCount,
    rows,
  };
}

export async function loadWorkspaceStatusSummary(
  loadEntries: () => Promise<RegisteredWorkspace[]>,
  deps: {
    loadWorkspaceConfigOverrides: (configPath: string) => Promise<unknown>;
    readWorkspaceConfigWorkspaceId: (
      configPath: string,
      options: { allowMissing: boolean },
    ) => Promise<string | undefined>;
  },
): Promise<WorkspaceStatusSummary> {
  let entries: RegisteredWorkspace[];
  try {
    entries = await loadEntries();
  } catch (error) {
    return {
      activeCount: 0,
      invalidCount: 0,
      rows: [],
      unavailableReason: formatWorkspaceRegistryValidationError(error),
    };
  }

  return await buildWorkspaceStatusSummary(entries, deps);
}
