import type {
  DaemonRecordingStatus,
  DaemonSessionStatus,
  SessionMetadataV1,
} from "@kato/shared";
import {
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
  resolveDefaultStatusPath,
} from "@kato/runtime";

export interface SessionRecordingActivityRow {
  key: string;
  status: "active" | "stopped";
  workspaceId?: string;
  workspaceAlias?: string;
  outputPath: string;
  startedAt?: string;
  stoppedAt?: string;
  lastWriteAt?: string;
  recordingCycleId?: string;
}

export interface SessionActivityRow {
  sessionKey: string;
  provider: string;
  sessionId: string;
  sessionShortId: string;
  providerSessionId: string;
  snippet?: string;
  updatedAt: string;
  lastEventAt?: string;
  stale: boolean;
  sourceFilePath: string;
  twinPath: string;
  activeRecordingCount: number;
  stoppedRecordingCount: number;
  recordings: SessionRecordingActivityRow[];
}

export interface SessionsPageData {
  includeStale: boolean;
  workspaceFilter?: string;
  sessionCount: number;
  activeSessionCount: number;
  staleSessionCount: number;
  activeRecordingCount: number;
  stoppedRecordingCount: number;
  rows: SessionActivityRow[];
}

export interface LoadSessionActivityRowsOptions {
  includeStale?: boolean;
  workspaceFilter?: string;
  now?: () => Date;
  katoDir?: string;
  statusPath?: string;
  statusStore?: DaemonStatusSnapshotStoreLike;
}

function resolveActivityTimestamp(
  row: Pick<
    SessionRecordingActivityRow,
    "lastWriteAt" | "stoppedAt" | "startedAt"
  >,
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

function sortRecordings(
  rows: SessionRecordingActivityRow[],
): SessionRecordingActivityRow[] {
  return [...rows].sort((a, b) => {
    const statusDiff = Number(b.status === "active") -
      Number(a.status === "active");
    if (statusDiff !== 0) {
      return statusDiff;
    }
    const timeDiff = resolveActivityTimestamp(b) - resolveActivityTimestamp(a);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.outputPath.localeCompare(b.outputPath);
  });
}

function deriveSessionShortId(
  session: SessionMetadataV1,
  live: DaemonSessionStatus | undefined,
): string {
  return live?.sessionShortId ?? session.sessionId.slice(0, 8);
}

function findActiveCycle(
  output: SessionWorkspaceOutputState,
): SessionWorkspaceOutputState["recordingCycles"][number] | undefined {
  if (!output.activeRecordingCycleId) {
    return undefined;
  }
  return output.recordingCycles.find((
    cycle: SessionWorkspaceOutputState["recordingCycles"][number],
  ) => cycle.recordingCycleId === output.activeRecordingCycleId);
}

function buildRecordingRowsForOutput(
  output: SessionWorkspaceOutputState,
  liveRecordings: DaemonRecordingStatus[],
): SessionRecordingActivityRow[] {
  const rows: SessionRecordingActivityRow[] = [];
  const activeCycle = findActiveCycle(output);
  const liveRecording = liveRecordings.find((recording) =>
    recording.outputPath === output.currentResolvedPath
  );

  if (activeCycle || output.desiredState === "on" || liveRecording) {
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        activeCycle?.recordingCycleId ?? liveRecording?.recordingId ?? "active",
      ].join(":"),
      status: "active",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      outputPath: output.currentResolvedPath,
      startedAt: activeCycle?.startedAt ?? liveRecording?.startedAt,
      lastWriteAt: liveRecording?.lastWriteAt,
      recordingCycleId: activeCycle?.recordingCycleId,
    });
  }

  for (const cycle of output.recordingCycles) {
    if (
      activeCycle &&
      cycle.recordingCycleId === activeCycle.recordingCycleId
    ) {
      continue;
    }
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        cycle.recordingCycleId,
      ].join(":"),
      status: "stopped",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot,
      outputPath: output.currentResolvedPath,
      startedAt: cycle.startedAt,
      stoppedAt: cycle.stoppedAt,
      recordingCycleId: cycle.recordingCycleId,
    });
  }

  return rows;
}

function buildRecordingRows(
  session: SessionMetadataV1,
  live: DaemonSessionStatus | undefined,
): SessionRecordingActivityRow[] {
  const liveRecordings = live?.recordings ?? [];
  const rows: SessionRecordingActivityRow[] = [];
  const seenActiveOutputs = new Set<string>();

  for (const output of session.workspaceOutputs ?? []) {
    const outputRows = buildRecordingRowsForOutput(output, liveRecordings);
    for (const row of outputRows) {
      rows.push(row);
      if (row.status === "active") {
        seenActiveOutputs.add(row.outputPath);
      }
    }
  }

  for (const liveRecording of liveRecordings) {
    if (seenActiveOutputs.has(liveRecording.outputPath)) {
      continue;
    }
    rows.push({
      key: [
        session.sessionKey,
        liveRecording.outputPath,
        liveRecording.recordingId ?? "active",
      ].join(":"),
      status: "active",
      workspaceAlias: liveRecording.workspaceAlias,
      outputPath: liveRecording.outputPath,
      startedAt: liveRecording.startedAt,
      lastWriteAt: liveRecording.lastWriteAt,
      recordingCycleId: liveRecording.recordingId,
    });
  }

  return sortRecordings(rows);
}

export async function loadSessionActivityRows(
  options: LoadSessionActivityRowsOptions = {},
): Promise<SessionActivityRow[]> {
  const now = options.now ?? (() => new Date());
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const statusPath = options.statusPath ?? resolveDefaultStatusPath(katoDir);
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(statusPath, now);
  const sessionStore = new PersistentSessionStateStore({
    katoDir,
    now,
  });
  const [snapshot, metadataList] = await Promise.all([
    statusStore.load(),
    sessionStore.listSessionMetadata(),
  ]);

  const liveBySessionId = new Map(
    (snapshot.sessions ?? []).map((session) => [session.sessionId, session]),
  );
  const workspaceFilter = options.workspaceFilter?.trim();
  const includeStale = options.includeStale ?? true;

  const rows = metadataList.map((metadata): SessionActivityRow => {
    const live = liveBySessionId.get(metadata.sessionId);
    const recordings = buildRecordingRows(metadata, live);
    const activeRecordingCount = recordings.filter((row) =>
      row.status === "active"
    )
      .length;
    return {
      sessionKey: metadata.sessionKey,
      provider: metadata.provider,
      sessionId: metadata.sessionId,
      sessionShortId: deriveSessionShortId(metadata, live),
      providerSessionId: metadata.providerSessionId,
      snippet: live?.snippet ?? metadata.snippet,
      updatedAt: live?.updatedAt ?? metadata.updatedAt,
      lastEventAt: live?.lastEventAt,
      stale: live?.stale ?? true,
      sourceFilePath: metadata.sourceFilePath,
      twinPath: metadata.twinPath,
      activeRecordingCount,
      stoppedRecordingCount: recordings.length - activeRecordingCount,
      recordings,
    };
  }).filter((row) => includeStale || !row.stale).filter((row) =>
    !workspaceFilter ||
    row.recordings.some((recording) =>
      recording.workspaceId === workspaceFilter
    )
  );

  rows.sort((a, b) => {
    const staleDiff = Number(a.stale) - Number(b.stale);
    if (staleDiff !== 0) {
      return staleDiff;
    }
    const recordingDiff = b.activeRecordingCount - a.activeRecordingCount;
    if (recordingDiff !== 0) {
      return recordingDiff;
    }
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) {
      return updatedDiff;
    }
    return `${a.provider}:${a.sessionId}`.localeCompare(
      `${b.provider}:${b.sessionId}`,
    );
  });

  return rows;
}

export async function loadSessionsPageData(
  options: LoadSessionActivityRowsOptions = {},
): Promise<SessionsPageData> {
  const includeStale = options.includeStale ?? true;
  const rows = await loadSessionActivityRows({
    ...options,
    includeStale,
  });

  return {
    includeStale,
    workspaceFilter: options.workspaceFilter?.trim() || undefined,
    sessionCount: rows.length,
    activeSessionCount: rows.filter((row) => !row.stale).length,
    staleSessionCount: rows.filter((row) => row.stale).length,
    activeRecordingCount: rows.reduce(
      (sum, row) => sum + row.activeRecordingCount,
      0,
    ),
    stoppedRecordingCount: rows.reduce(
      (sum, row) => sum + row.stoppedRecordingCount,
      0,
    ),
    rows,
  };
}
type SessionWorkspaceOutputState = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number];
