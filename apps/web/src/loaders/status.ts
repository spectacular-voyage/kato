import type {
  DaemonSessionStatus,
  MemoryStatus,
  ProviderStatus,
} from "@kato/shared";
import { summarizeRecordingActivity } from "@kato/shared";
import {
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  isStatusSnapshotStale,
  resolveDefaultStatusPath,
} from "../../../runtime/src/orchestrator/control_plane.ts";
import {
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
  resolveDefaultWorkspaceRegistryPath,
  WorkspaceRegistryFileStore,
} from "../../../runtime/src/workspace/registry.ts";
import { loadLogEntries } from "./logs.ts";
import { toStatusViewModel } from "../main.ts";

const RECENT_ERRORS_LIMIT = 12;

export interface WorkspaceSummaryRow {
  workspaceId: string;
  alias: string;
  workspaceRoot: string;
  configPath: string;
  valid: boolean;
  invalidReason?: string;
}

export interface WorkspaceSummary {
  activeCount: number;
  invalidCount: number;
  rows: WorkspaceSummaryRow[];
  unavailableReason?: string;
}

export interface SummaryRecentError {
  timestamp: string;
  level: "warn" | "error";
  channel: "operational" | "security-audit";
  scope: "daemon" | "web";
  event: string;
  message: string;
}

export interface AppChromeStatus {
  daemon: "running" | "stopped";
  snapshot: "current" | "stale";
}

export interface SummaryPageData {
  generatedAt: string;
  heartbeatAt: string;
  daemon: "running" | "stopped";
  daemonPid?: number;
  daemonVersion?: string;
  sessionCount: number;
  activeSessionCount: number;
  staleSessionCount: number;
  recordingCount: number;
  inactiveRecordingCount: number;
  sessions: DaemonSessionStatus[];
  providers: ProviderStatus[];
  memory?: MemoryStatus;
  stale: boolean;
  statusPath: string;
  workspaceSummary: WorkspaceSummary;
  recentErrors: SummaryRecentError[];
}

export interface LoadSummaryPageDataOptions {
  includeStale?: boolean;
  now?: () => Date;
  statusPath?: string;
  statusStore?: DaemonStatusSnapshotStoreLike;
}

export interface LoadAppChromeStatusOptions {
  now?: () => Date;
  statusPath?: string;
  statusStore?: DaemonStatusSnapshotStoreLike;
}

export async function loadAppChromeStatus(
  options: LoadAppChromeStatusOptions = {},
): Promise<AppChromeStatus> {
  const now = options.now ?? (() => new Date());
  const statusPath = options.statusPath ?? resolveDefaultStatusPath();
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(statusPath, now);
  const snapshot = await statusStore.load();

  return {
    daemon: snapshot.daemonRunning ? "running" : "stopped",
    snapshot: isStatusSnapshotStale(snapshot, now()) ? "stale" : "current",
  };
}

export async function loadSummaryPageData(
  options: LoadSummaryPageDataOptions = {},
): Promise<SummaryPageData> {
  const now = options.now ?? (() => new Date());
  const statusPath = options.statusPath ?? resolveDefaultStatusPath();
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(statusPath, now);
  const snapshot = await statusStore.load();
  const viewModel = toStatusViewModel(snapshot, {
    includeStale: options.includeStale,
  });
  const allSessions = snapshot.sessions ?? [];
  const activeSessionCount = allSessions.filter((session) => !session.stale)
    .length;
  const recordingActivity = summarizeRecordingActivity(
    allSessions,
    snapshot.recordings,
  );
  const workspaceSummary = await loadWorkspaceSummary();
  const recentErrors = await loadRecentErrors(statusPath);

  return {
    generatedAt: viewModel.generatedAt,
    heartbeatAt: snapshot.heartbeatAt,
    daemon: viewModel.daemon,
    daemonPid: snapshot.daemonPid,
    daemonVersion: snapshot.daemonVersion,
    sessionCount: allSessions.length,
    activeSessionCount,
    staleSessionCount: allSessions.length - activeSessionCount,
    recordingCount: recordingActivity.activeRecordings,
    inactiveRecordingCount: recordingActivity.inactiveRecordings,
    sessions: viewModel.sessions,
    providers: snapshot.providers,
    memory: viewModel.memory,
    stale: isStatusSnapshotStale(snapshot, now()),
    statusPath,
    workspaceSummary,
    recentErrors,
  };
}

export async function loadWorkspaceSummary(): Promise<WorkspaceSummary> {
  const store = new WorkspaceRegistryFileStore(
    resolveDefaultWorkspaceRegistryPath(),
  );

  let entries;
  try {
    entries = await store.load();
  } catch (error) {
    return {
      activeCount: 0,
      invalidCount: 0,
      rows: [],
      unavailableReason: formatWorkspaceRegistryError(error),
    };
  }

  const rows = await Promise.all(
    entries.map(async (entry): Promise<WorkspaceSummaryRow> => {
      try {
        await loadWorkspaceConfigOverrides(entry.configPath);
        const configuredWorkspaceId = await readWorkspaceConfigWorkspaceId(
          entry.configPath,
          { allowMissing: true },
        );
        if (
          configuredWorkspaceId &&
          configuredWorkspaceId !== entry.workspaceId
        ) {
          return {
            workspaceId: entry.workspaceId,
            alias: entry.alias,
            workspaceRoot: entry.workspaceRoot,
            configPath: entry.configPath,
            valid: false,
            invalidReason:
              `workspaceId mismatch (registry=${entry.workspaceId}, config=${configuredWorkspaceId})`,
          };
        }
        return {
          workspaceId: entry.workspaceId,
          alias: entry.alias,
          workspaceRoot: entry.workspaceRoot,
          configPath: entry.configPath,
          valid: true,
        };
      } catch (error) {
        return {
          workspaceId: entry.workspaceId,
          alias: entry.alias,
          workspaceRoot: entry.workspaceRoot,
          configPath: entry.configPath,
          valid: false,
          invalidReason: formatWorkspaceConfigError(error),
        };
      }
    }),
  );

  rows.sort((a, b) =>
    a.alias.localeCompare(b.alias) || a.workspaceId.localeCompare(b.workspaceId)
  );
  const activeCount = rows.filter((row) => row.valid).length;
  return {
    activeCount,
    invalidCount: rows.length - activeCount,
    rows,
  };
}

export function formatWorkspaceRegistryError(error: unknown): string {
  if (error instanceof Deno.errors.NotFound) {
    return "workspace registry file not found";
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return "permission denied while reading workspace registry";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}

function formatWorkspaceConfigError(error: unknown): string {
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

async function loadRecentErrors(
  statusPath: string,
): Promise<SummaryRecentError[]> {
  const rows = await loadLogEntries({
    channel: "all",
    levels: ["warn", "error"],
    limit: RECENT_ERRORS_LIMIT,
    tailBytes: 2 * 1024 * 1024,
    statusPath,
  });

  return rows.map((row) => ({
    timestamp: row.timestamp,
    level: row.level === "warn" || row.level === "error" ? row.level : "warn",
    channel: row.channel,
    scope: row.scope,
    event: row.event,
    message: row.message,
  }));
}
