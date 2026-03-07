import type {
  DaemonSessionStatus,
  MemoryStatus,
  ProviderStatus,
} from "@kato/shared";
import { summarizeRecordingActivity } from "@kato/shared";
import { join } from "@std/path";
import {
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  isStatusSnapshotStale,
  resolveDefaultStatusPath,
} from "../../../runtime/src/orchestrator/control_plane.ts";
import { resolveDefaultKatoDir } from "../../../runtime/src/orchestrator/session_state_store.ts";
import {
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
  resolveDefaultWorkspaceRegistryPath,
  WorkspaceRegistryFileStore,
} from "../../../runtime/src/workspace/registry.ts";
import { toStatusViewModel } from "../main.ts";

const RECENT_ERRORS_LIMIT = 12;
const RECENT_ERRORS_TAIL_BYTES = 2 * 1024 * 1024;

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
  const runtimeDir = resolveRuntimeDirFromStatusPath(statusPath);
  const katoDir = resolveDefaultKatoDir();
  const [operational, securityAudit, webOperational, webSecurityAudit] =
    await Promise.all([
      loadRecentErrorsFromLog(
        join(runtimeDir, "logs", "operational.jsonl"),
        "daemon",
      ),
      loadRecentErrorsFromLog(
        join(runtimeDir, "logs", "security-audit.jsonl"),
        "daemon",
      ),
      loadRecentErrorsFromLog(
        join(katoDir, "web", "logs", "operational.jsonl"),
        "web",
      ),
      loadRecentErrorsFromLog(
        join(katoDir, "web", "logs", "security-audit.jsonl"),
        "web",
      ),
    ]);

  return [
    ...operational,
    ...securityAudit,
    ...webOperational,
    ...webSecurityAudit,
  ]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, RECENT_ERRORS_LIMIT);
}

function resolveRuntimeDirFromStatusPath(statusPath: string): string {
  const normalized = statusPath.replaceAll("\\", "/");
  if (normalized.endsWith("/shared/status.json")) {
    return `${normalized.slice(0, -"/shared/status.json".length)}/daemon`;
  }
  return normalized;
}

async function loadRecentErrorsFromLog(
  filePath: string,
  scope: SummaryRecentError["scope"],
): Promise<SummaryRecentError[]> {
  const tail = await readTailText(filePath, RECENT_ERRORS_TAIL_BYTES);
  if (!tail) {
    return [];
  }

  const rows: SummaryRecentError[] = [];
  const lines = tail.split(/\r\n?|\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const level = parsed["level"];
      const channel = parsed["channel"];
      const timestamp = parsed["timestamp"];
      if (
        (level !== "warn" && level !== "error") ||
        (channel !== "operational" && channel !== "security-audit") ||
        typeof timestamp !== "string"
      ) {
        continue;
      }
      rows.push({
        timestamp,
        level,
        channel,
        scope,
        event: typeof parsed["event"] === "string"
          ? parsed["event"]
          : "unknown",
        message: typeof parsed["message"] === "string"
          ? parsed["message"].replace(/\s+/g, " ").trim()
          : "no message",
      });
    } catch {
      continue;
    }
  }
  return rows;
}

async function readTailText(
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(filePath, { read: true });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }
    throw error;
  }

  try {
    const stat = await file.stat();
    if (stat.size <= 0) {
      return "";
    }
    const start = Math.max(0, stat.size - maxBytes);
    await file.seek(start, Deno.SeekMode.Start);

    const bytes = new Uint8Array(Number(stat.size - start));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset));
      if (read === null) {
        break;
      }
      offset += read;
    }
    let text = new TextDecoder().decode(bytes.subarray(0, offset));
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    return text;
  } finally {
    file.close();
  }
}
