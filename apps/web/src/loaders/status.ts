import type {
  DaemonSessionStatus,
  MemoryStatus,
  ProviderStatus,
} from "@kato/shared";
import {
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  isStatusSnapshotStale,
  resolveDefaultStatusPath,
} from "../../../runtime/src/orchestrator/control_plane.ts";
import {
  deriveSessionGenerationState,
  loadRuntimeConfigOrDefault,
  providerAutoGeneratesSnapshots,
} from "./activity_state.ts";
import {
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
  resolveDefaultWorkspaceRegistryPath,
  WorkspaceRegistryFileStore,
} from "../../../runtime/src/workspace/registry.ts";
import { loadLogEntries } from "./logs.ts";
import { loadSessionActivityRows } from "./sessions.ts";
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
  staleCount: number;
  inactiveCount: number;
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

export interface ConfiguredProvider {
  provider: string;
  autoGenerateSnapshots: boolean;
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
  generatingSessionCount: number;
  staleGeneratingSessionCount: number;
  inactiveSessionCount: number;
  recordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  sessions: DaemonSessionStatus[];
  providers: ProviderStatus[];
  configuredProviders: ConfiguredProvider[];
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
  const sessionActivityRows = await loadSessionActivityRows({
    includeStale: true,
    now,
    statusPath,
    statusStore,
  });
  const runtimeConfig = await loadRuntimeConfigOrDefault();
  const fallbackActiveRecordingCount = allSessions.reduce(
    (sum, session) =>
      sum + (session.stale ? 0 : (session.recordings ?? []).length),
    0,
  );
  const fallbackStaleRecordingCount = allSessions.reduce(
    (sum, session) =>
      sum + (session.stale ? (session.recordings ?? []).length : 0),
    0,
  );
  const recordingCount = sessionActivityRows.length > 0
    ? sessionActivityRows.reduce(
      (sum, row) => sum + row.activeRecordingCount,
      0,
    )
    : fallbackActiveRecordingCount;
  const staleRecordingCount = sessionActivityRows.length > 0
    ? sessionActivityRows.reduce((sum, row) => sum + row.staleRecordingCount, 0)
    : fallbackStaleRecordingCount;
  const stoppedRecordingCount = sessionActivityRows.reduce(
    (sum, row) => sum + row.stoppedRecordingCount,
    0,
  );
  const sessionActivityKeys = new Set(
    sessionActivityRows.map((row) =>
      makeProviderSessionKey(row.provider, row.sessionId)
    ),
  );
  const liveOnlySessions = allSessions.filter((session) =>
    !sessionActivityKeys.has(
      makeProviderSessionKey(session.provider, session.sessionId),
    )
  );
  const configuredProviders: ConfiguredProvider[] = (
    ["claude", "codex", "gemini"] as const
  )
    .filter((p) => (runtimeConfig.providerSessionRoots[p] ?? []).length > 0)
    .map((p) => ({
      provider: p,
      autoGenerateSnapshots: providerAutoGeneratesSnapshots(p, runtimeConfig),
    }));
  const sessionGenerationCounts = summarizeSessionGenerationState(
    sessionActivityRows,
    liveOnlySessions,
    runtimeConfig,
  );
  const workspaceSummary = summarizeWorkspaceActivity(
    await loadWorkspaceSummary(),
    sessionActivityRows,
  );
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
    generatingSessionCount: sessionGenerationCounts.active,
    staleGeneratingSessionCount: sessionGenerationCounts.stale,
    inactiveSessionCount: sessionGenerationCounts.inactive,
    recordingCount,
    staleRecordingCount,
    stoppedRecordingCount,
    sessions: viewModel.sessions,
    providers: snapshot.providers,
    configuredProviders,
    memory: viewModel.memory,
    stale: isStatusSnapshotStale(snapshot, now()),
    statusPath,
    workspaceSummary,
    recentErrors,
  };
}

function makeProviderSessionKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

function summarizeSessionGenerationState(
  sessionActivityRows: Awaited<ReturnType<typeof loadSessionActivityRows>>,
  liveOnlySessions: Array<
    Pick<DaemonSessionStatus, "provider" | "sessionId" | "stale" | "recordings">
  >,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfigOrDefault>>,
): { active: number; stale: number; inactive: number } {
  let active = 0;
  let stale = 0;
  let inactive = 0;

  for (const row of sessionActivityRows) {
    switch (deriveSessionGenerationState(row, runtimeConfig)) {
      case "active":
        active += 1;
        break;
      case "stale":
        stale += 1;
        break;
      case "inactive":
        inactive += 1;
        break;
    }
  }

  for (const session of liveOnlySessions) {
    switch (
      deriveSessionGenerationState(
        {
          provider: session.provider,
          stale: session.stale,
          recordingCount: session.recordings?.length ?? 0,
        },
        runtimeConfig,
      )
    ) {
      case "active":
        active += 1;
        break;
      case "stale":
        stale += 1;
        break;
      case "inactive":
        inactive += 1;
        break;
    }
  }

  return { active, stale, inactive };
}

function summarizeWorkspaceActivity(
  workspaceSummary: WorkspaceSummary,
  sessionActivityRows: Awaited<ReturnType<typeof loadSessionActivityRows>>,
): WorkspaceSummary {
  if (workspaceSummary.unavailableReason) {
    return workspaceSummary;
  }

  const activityByWorkspace = new Map<
    string,
    { active: boolean; stale: boolean }
  >();
  for (const session of sessionActivityRows) {
    for (const recording of session.recordings) {
      if (!recording.workspaceId) {
        continue;
      }
      const state = activityByWorkspace.get(recording.workspaceId) ?? {
        active: false,
        stale: false,
      };
      if (recording.state === "engaged-active") {
        state.active = true;
      } else if (recording.state === "engaged-stale") {
        state.stale = true;
      }
      activityByWorkspace.set(recording.workspaceId, state);
    }
  }

  let activeCount = 0;
  let staleCount = 0;
  let inactiveCount = 0;
  let invalidCount = 0;
  for (const row of workspaceSummary.rows) {
    if (!row.valid) {
      invalidCount += 1;
      continue;
    }
    const state = activityByWorkspace.get(row.workspaceId);
    if (state?.active) {
      activeCount += 1;
    } else if (state?.stale) {
      staleCount += 1;
    } else {
      inactiveCount += 1;
    }
  }

  return {
    ...workspaceSummary,
    activeCount,
    staleCount,
    inactiveCount,
    invalidCount,
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
      staleCount: 0,
      inactiveCount: 0,
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
    staleCount: 0,
    inactiveCount: 0,
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
