import {
  isPathWithinRoots,
  loadUserSettings,
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
import { buildIngestionSessionHref } from "../session_routes.ts";

export interface WorkspaceRecordingEntry {
  key: string;
  state: "engaged-active" | "engaged-stale" | "stopped";
  provider: string;
  sessionId: string;
  sessionShortId: string;
  snippet?: string;
  outputPath: string;
  displayOutputPath: string;
  startedAt?: string;
  stoppedAt?: string;
  lastWriteAt?: string;
  sessionLink: string;
}

export interface WorkspaceManagementRow extends WorkspaceSummaryRow {
  workspaceUsername?: string;
  writePathCovered?: boolean;
  activeRecordingCount: number;
  staleRecordingCount: number;
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
  const [workspaceSummary, sessionRows, userSettings] = await Promise.all([
    loadWorkspaceSummary(),
    loadSessionActivityRows({ katoDir, includeStale: true }),
    loadUserSettings({ katoDir }),
  ]);
  const workspaceUsernames = new Map(
    Object.entries(userSettings.config.participants.workspaceUsernames),
  );
  const recordingsByWorkspace = new Map<string, WorkspaceRecordingEntry[]>();

  for (const session of sessionRows) {
    for (const recording of session.recordings) {
      if (!recording.workspaceId) {
        continue;
      }
      const row: WorkspaceRecordingEntry = {
        key: `${recording.key}:${session.sessionId}`,
        state: recording.state,
        provider: session.provider,
        sessionId: session.sessionId,
        sessionShortId: session.sessionShortId,
        snippet: session.snippet,
        outputPath: recording.outputPath,
        displayOutputPath: recording.displayOutputPath,
        startedAt: recording.startedAt,
        stoppedAt: recording.stoppedAt,
        lastWriteAt: recording.lastWriteAt,
        sessionLink: buildIngestionSessionHref(session.sessionId, {
          workspaceFilter: recording.workspaceId,
        }),
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
          const order = {
            "engaged-active": 0,
            "engaged-stale": 1,
            "stopped": 2,
          } as const;
          const statusDiff = order[a.state] - order[b.state];
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
        workspaceUsername: workspaceUsernames.get(row.workspaceId),
        writePathCovered: allowedWriteRoots
          ? isPathWithinRoots(row.workspaceRoot, allowedWriteRoots)
          : undefined,
        activeRecordingCount: recordings.filter((recording) =>
          recording.state === "engaged-active"
        ).length,
        staleRecordingCount: recordings.filter((recording) =>
          recording.state === "engaged-stale"
        ).length,
        stoppedRecordingCount: recordings.filter((recording) =>
          recording.state === "stopped"
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
