import {
  isPathWithinRoots,
  resolveDefaultKatoDir,
  resolveDefaultSharedConfigPath,
  SharedBehaviorConfigFileStore,
} from "@kato/runtime";
import {
  formatWorkspaceRegistryError,
  loadWorkspaceSummary,
  type WorkspaceSummary,
  type WorkspaceSummaryRow,
} from "./status.ts";
import { loadSessionActivityRows } from "./sessions.ts";

export interface WorkspaceRecordingEntry {
  key: string;
  status: "active" | "stopped";
  provider: string;
  sessionId: string;
  sessionShortId: string;
  snippet?: string;
  outputPath: string;
  startedAt?: string;
  stoppedAt?: string;
  lastWriteAt?: string;
  sessionLink: string;
}

export interface WorkspaceManagementRow extends WorkspaceSummaryRow {
  writePathCovered?: boolean;
  activeRecordingCount: number;
  stoppedRecordingCount: number;
  latestRecordingAt?: string;
  recordings: WorkspaceRecordingEntry[];
}

export interface WorkspacesPageData {
  workspaceSummary: WorkspaceSummary;
  rows: WorkspaceManagementRow[];
  allowedWriteRoots: string[];
  sharedConfigError?: string;
}

function toSessionAnchor(sessionId: string): string {
  return `session-${sessionId}`;
}

function resolveRecordingActivityTimestamp(
  row: Pick<WorkspaceRecordingEntry, "lastWriteAt" | "stoppedAt" | "startedAt">,
): number {
  for (const value of [row.lastWriteAt, row.stoppedAt, row.startedAt]) {
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

export async function loadWorkspacesPageData(): Promise<WorkspacesPageData> {
  const katoDir = resolveDefaultKatoDir();
  const sharedConfigStore = new SharedBehaviorConfigFileStore(
    resolveDefaultSharedConfigPath(katoDir),
  );
  const [workspaceSummary, sessionRows] = await Promise.all([
    loadWorkspaceSummary(),
    loadSessionActivityRows({ katoDir, includeStale: true }),
  ]);
  const recordingsByWorkspace = new Map<string, WorkspaceRecordingEntry[]>();

  for (const session of sessionRows) {
    for (const recording of session.recordings) {
      if (!recording.workspaceId) {
        continue;
      }
      const row: WorkspaceRecordingEntry = {
        key: `${recording.key}:${session.sessionId}`,
        status: recording.status,
        provider: session.provider,
        sessionId: session.sessionId,
        sessionShortId: session.sessionShortId,
        snippet: session.snippet,
        outputPath: recording.outputPath,
        startedAt: recording.startedAt,
        stoppedAt: recording.stoppedAt,
        lastWriteAt: recording.lastWriteAt,
        sessionLink: `/sessions?workspace=${
          encodeURIComponent(recording.workspaceId)
        }#${toSessionAnchor(session.sessionId)}`,
      };
      const existing = recordingsByWorkspace.get(recording.workspaceId) ?? [];
      existing.push(row);
      recordingsByWorkspace.set(recording.workspaceId, existing);
    }
  }

  function augmentRows(
    rows: WorkspaceSummaryRow[],
    allowedWriteRoots: string[] | undefined,
  ): WorkspaceManagementRow[] {
    return rows.map((row) => {
      const recordings = [...(recordingsByWorkspace.get(row.workspaceId) ?? [])]
        .sort((a, b) => {
          const statusDiff = Number(b.status === "active") -
            Number(a.status === "active");
          if (statusDiff !== 0) {
            return statusDiff;
          }
          return resolveRecordingActivityTimestamp(b) -
            resolveRecordingActivityTimestamp(a);
        });
      const latestRecordingAt = recordings[0]?.lastWriteAt ??
        recordings[0]?.stoppedAt ??
        recordings[0]?.startedAt;
      return {
        ...row,
        writePathCovered: allowedWriteRoots
          ? isPathWithinRoots(row.workspaceRoot, allowedWriteRoots)
          : undefined,
        activeRecordingCount: recordings.filter((recording) =>
          recording.status === "active"
        ).length,
        stoppedRecordingCount: recordings.filter((recording) =>
          recording.status === "stopped"
        ).length,
        latestRecordingAt,
        recordings,
      };
    });
  }

  try {
    const sharedConfig = await sharedConfigStore.load();
    return {
      workspaceSummary,
      rows: augmentRows(workspaceSummary.rows, sharedConfig.allowedWriteRoots),
      allowedWriteRoots: [...sharedConfig.allowedWriteRoots],
    };
  } catch (error) {
    return {
      workspaceSummary,
      rows: augmentRows(workspaceSummary.rows, undefined),
      allowedWriteRoots: [],
      sharedConfigError: formatWorkspaceRegistryError(error),
    };
  }
}
