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
  resolveDefaultWorkspaceRegistryPath,
  WorkspaceRegistryFileStore,
} from "@kato/runtime";
import { relative } from "@std/path";
import {
  type ActivityState,
  deriveSessionGenerationState,
  loadRuntimeConfigOrDefault,
  providerAutoGeneratesTwins,
} from "./activity_state.ts";
import { buildIngestionSessionHref } from "../session_routes.ts";

export interface SessionRecordingActivityRow {
  key: string;
  state: "engaged-active" | "engaged-stale" | "stopped";
  workspaceId?: string;
  workspaceAlias?: string;
  workspaceHref: string;
  outputPath: string;
  displayOutputPath: string;
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
  state: ActivityState;
  canOpenIngestView: boolean;
  ingestionAction: SessionIngestionAction;
  sourceFilePath: string;
  twinPath: string;
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  recordings: SessionRecordingActivityRow[];
}

export interface SessionsPageData {
  includeStale: boolean;
  workspaceFilter?: string;
  workspaceFilterId?: string;
  workspaceFilterAlias?: string;
  sessionCount: number;
  activeSessionCount: number;
  staleSessionCount: number;
  inactiveSessionCount: number;
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  rows: SessionActivityRow[];
}

export interface LoadSessionActivityRowsOptions {
  includeStale?: boolean;
  workspaceFilter?: string;
  recordingsMode?: "latest" | "all";
  now?: () => Date;
  katoDir?: string;
  statusPath?: string;
  statusStore?: DaemonStatusSnapshotStoreLike;
}

export type SessionIngestionAction = "start" | "continue" | "none";

export interface ResolvedWorkspaceFilter {
  selector: string;
  workspaceId: string;
  workspaceAlias?: string;
}

export interface RecordingListEntry extends SessionRecordingActivityRow {
  provider: string;
  sessionId: string;
  sessionShortId: string;
  snippet?: string;
  sessionState: ActivityState;
  sessionHref: string;
  updatedAt: string;
  lastEventAt?: string;
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

function resolveCycleTimestamp(
  cycle: Pick<
    SessionWorkspaceOutputState["recordingCycles"][number],
    "stoppedAt" | "startedAt"
  >,
): number {
  for (const value of [cycle.stoppedAt, cycle.startedAt]) {
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

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isUsableRelativePath(value: string): boolean {
  return value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    !/^[A-Za-z]:/.test(value);
}

function resolveDisplayOutputPath(
  outputPath: string,
  workspaceRoot?: string,
  relativePathHint?: string,
): string {
  const hinted = normalizePath(relativePathHint?.trim() ?? "");
  if (isUsableRelativePath(hinted)) {
    return hinted;
  }

  if (workspaceRoot) {
    const rel = normalizePath(relative(workspaceRoot, outputPath));
    if (isUsableRelativePath(rel)) {
      return rel;
    }
  }

  return outputPath;
}

function buildWorkspaceHref(workspaceId: string | undefined): string {
  return workspaceId ? `/workspaces#workspace-${workspaceId}` : "/workspaces";
}

function sortRecordings(
  rows: SessionRecordingActivityRow[],
): SessionRecordingActivityRow[] {
  return [...rows].sort((a, b) => {
    const order = {
      "engaged-active": 0,
      "engaged-stale": 1,
      "stopped": 2,
    } as const;
    const statusDiff = order[a.state] - order[b.state];
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

function hasTwinHistory(metadata: SessionMetadataV1): boolean {
  return metadata.nextTwinSeq > 1;
}

function hasLegacyManualIngestionHistory(metadata: SessionMetadataV1): boolean {
  return hasTwinHistory(metadata) &&
    (metadata.commandCursor ?? 0) === 0;
}

function hasExplicitTwinHistory(metadata: SessionMetadataV1): boolean {
  return metadata.ingestionActivatedAt !== undefined ||
    hasLegacyManualIngestionHistory(metadata);
}

function hasExplicitIngestionHistory(metadata: SessionMetadataV1): boolean {
  return hasExplicitTwinHistory(metadata) ||
    (metadata.workspaceOutputs?.length ?? 0) > 0;
}

function hasVisibleIngestionHistory(
  metadata: SessionMetadataV1,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfigOrDefault>>,
): boolean {
  return hasExplicitIngestionHistory(metadata) ||
    providerAutoGeneratesTwins(metadata.provider, runtimeConfig);
}

function normalizePersistedSessionState(
  metadata: SessionMetadataV1,
  state: ActivityState,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfigOrDefault>>,
): ActivityState {
  if (
    state === "inactive" &&
    hasVisibleIngestionHistory(metadata, runtimeConfig)
  ) {
    return "stale";
  }
  return state;
}

function hasVisibleTwinHistory(
  metadata: SessionMetadataV1,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfigOrDefault>>,
): boolean {
  return hasTwinHistory(metadata) &&
    (
      hasExplicitTwinHistory(metadata) ||
      providerAutoGeneratesTwins(metadata.provider, runtimeConfig)
    );
}

async function needsIngestionContinuation(
  metadata: SessionMetadataV1,
): Promise<boolean> {
  const lastObservedMtimeMs = metadata.lastObservedMtimeMs;
  if (
    lastObservedMtimeMs === undefined || !Number.isFinite(lastObservedMtimeMs)
  ) {
    return false;
  }

  try {
    const sourceFileMtimeMs = (await Deno.stat(metadata.sourceFilePath)).mtime
      ?.getTime();
    return sourceFileMtimeMs !== undefined &&
      Number.isFinite(sourceFileMtimeMs) &&
      sourceFileMtimeMs > lastObservedMtimeMs;
  } catch {
    return false;
  }
}

async function resolveSessionIngestionUiState(
  metadata: SessionMetadataV1,
  _state: ActivityState,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfigOrDefault>>,
): Promise<{
  canOpenIngestView: boolean;
  ingestionAction: SessionIngestionAction;
}> {
  if (!hasVisibleTwinHistory(metadata, runtimeConfig)) {
    return {
      canOpenIngestView: false,
      ingestionAction: "start",
    };
  }

  return {
    canOpenIngestView: true,
    ingestionAction: await needsIngestionContinuation(metadata)
      ? "continue"
      : "none",
  };
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

function findLatestStoppedCycle(
  output: SessionWorkspaceOutputState,
): SessionWorkspaceOutputState["recordingCycles"][number] | undefined {
  const stoppedCycles = output.recordingCycles.filter((cycle) =>
    cycle.recordingCycleId !== output.activeRecordingCycleId
  );
  return [...stoppedCycles].sort((a, b) =>
    resolveCycleTimestamp(b) - resolveCycleTimestamp(a)
  )[0];
}

function buildRecordingRowsForOutput(
  output: SessionWorkspaceOutputState,
  liveRecordings: DaemonRecordingStatus[],
  sessionStale: boolean,
): SessionRecordingActivityRow[] {
  const activeCycle = findActiveCycle(output);
  const liveRecording = liveRecordings.find((recording) =>
    recording.outputPath === output.currentResolvedPath
  );
  const displayOutputPath = resolveDisplayOutputPath(
    output.currentResolvedPath,
    output.workspaceRootSnapshot,
    output.currentDestination.relativePathFromWorkspaceRoot,
  );

  if (activeCycle || output.desiredState === "on" || liveRecording) {
    return [{
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        activeCycle?.recordingCycleId ?? liveRecording?.recordingId ?? "active",
      ].join(":"),
      state: sessionStale ? "engaged-stale" : "engaged-active",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt: activeCycle?.startedAt ?? liveRecording?.startedAt,
      lastWriteAt: liveRecording?.lastWriteAt,
      recordingCycleId: activeCycle?.recordingCycleId,
    }];
  }

  const latestStoppedCycle = findLatestStoppedCycle(output);
  if (!latestStoppedCycle) {
    return [];
  }

  return [{
    key: [
      output.workspaceId,
      output.currentResolvedPath,
      latestStoppedCycle.recordingCycleId,
    ].join(":"),
    state: "stopped",
    workspaceId: output.workspaceId,
    workspaceAlias: output.workspaceAliasSnapshot,
    workspaceHref: buildWorkspaceHref(output.workspaceId),
    outputPath: output.currentResolvedPath,
    displayOutputPath,
    startedAt: latestStoppedCycle.startedAt,
    stoppedAt: latestStoppedCycle.stoppedAt,
    recordingCycleId: latestStoppedCycle.recordingCycleId,
  }];
}

function buildAllRecordingRowsForOutput(
  output: SessionWorkspaceOutputState,
  liveRecordings: DaemonRecordingStatus[],
  sessionStale: boolean,
): SessionRecordingActivityRow[] {
  const activeCycle = findActiveCycle(output);
  const liveRecording = liveRecordings.find((recording) =>
    recording.outputPath === output.currentResolvedPath
  );
  const displayOutputPath = resolveDisplayOutputPath(
    output.currentResolvedPath,
    output.workspaceRootSnapshot,
    output.currentDestination.relativePathFromWorkspaceRoot,
  );
  const rows: SessionRecordingActivityRow[] = [];

  for (const cycle of output.recordingCycles) {
    const active = activeCycle?.recordingCycleId === cycle.recordingCycleId;
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        cycle.recordingCycleId,
      ].join(":"),
      state: active
        ? sessionStale ? "engaged-stale" : "engaged-active"
        : "stopped",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt: cycle.startedAt ??
        (active ? liveRecording?.startedAt : undefined),
      stoppedAt: active ? undefined : cycle.stoppedAt,
      lastWriteAt: active ? liveRecording?.lastWriteAt : undefined,
      recordingCycleId: cycle.recordingCycleId,
    });
  }

  const hasActiveRow = rows.some((row) => row.state !== "stopped");
  if (!hasActiveRow && (output.desiredState === "on" || liveRecording)) {
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        activeCycle?.recordingCycleId ?? liveRecording?.recordingId ?? "active",
      ].join(":"),
      state: sessionStale ? "engaged-stale" : "engaged-active",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt: activeCycle?.startedAt ?? liveRecording?.startedAt,
      lastWriteAt: liveRecording?.lastWriteAt,
      recordingCycleId: activeCycle?.recordingCycleId ??
        liveRecording?.recordingId,
    });
  }

  return rows;
}

function buildRecordingRows(
  session: SessionMetadataV1,
  live: DaemonSessionStatus | undefined,
  recordingsMode: "latest" | "all" = "latest",
): SessionRecordingActivityRow[] {
  const liveRecordings = live?.recordings ?? [];
  const rows: SessionRecordingActivityRow[] = [];
  const seenActiveOutputs = new Set<string>();
  const sessionStale = live?.stale ?? true;

  for (const output of session.workspaceOutputs ?? []) {
    const outputRows = recordingsMode === "all"
      ? buildAllRecordingRowsForOutput(
        output,
        liveRecordings,
        sessionStale,
      )
      : buildRecordingRowsForOutput(
        output,
        liveRecordings,
        sessionStale,
      );
    for (const row of outputRows) {
      rows.push(row);
      if (row.state !== "stopped") {
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
      state: sessionStale ? "engaged-stale" : "engaged-active",
      workspaceAlias: liveRecording.workspaceAlias,
      workspaceHref: buildWorkspaceHref(undefined),
      outputPath: liveRecording.outputPath,
      displayOutputPath: liveRecording.outputPath,
      startedAt: liveRecording.startedAt,
      lastWriteAt: liveRecording.lastWriteAt,
      recordingCycleId: liveRecording.recordingId,
    });
  }

  return sortRecordings(rows);
}

export async function resolveWorkspaceFilter(
  selector: string | undefined,
  katoDir: string,
): Promise<ResolvedWorkspaceFilter | undefined> {
  const trimmed = selector?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const store = new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
    const entries = await store.load();
    const matched = entries.find((entry) =>
      entry.workspaceId === trimmed || entry.alias === trimmed
    );
    if (matched) {
      return {
        selector: trimmed,
        workspaceId: matched.workspaceId,
        workspaceAlias: matched.alias,
      };
    }
  } catch {
    // Treat missing or unreadable registry data as unresolved metadata only.
  }

  return {
    selector: trimmed,
    workspaceId: trimmed,
  };
}

export function flattenSessionRecordings(
  rows: SessionActivityRow[],
): RecordingListEntry[] {
  return rows.flatMap((row) =>
    row.recordings.map((recording) => ({
      ...recording,
      provider: row.provider,
      sessionId: row.sessionId,
      sessionShortId: row.sessionShortId,
      snippet: row.snippet,
      sessionState: row.state,
      sessionHref: buildIngestionSessionHref(row.sessionId),
      updatedAt: row.updatedAt,
      lastEventAt: row.lastEventAt,
    }))
  ).sort((a, b) => {
    const order = {
      "engaged-active": 0,
      "engaged-stale": 1,
      "stopped": 2,
    } as const;
    const stateDiff = order[a.state] - order[b.state];
    if (stateDiff !== 0) {
      return stateDiff;
    }
    const timeDiff = resolveActivityTimestamp(b) - resolveActivityTimestamp(a);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    const workspaceDiff = (a.workspaceAlias ?? a.workspaceId ?? "")
      .localeCompare(
        b.workspaceAlias ?? b.workspaceId ?? "",
      );
    if (workspaceDiff !== 0) {
      return workspaceDiff;
    }
    return a.displayOutputPath.localeCompare(b.displayOutputPath);
  });
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
  const [snapshot, metadataList, runtimeConfig] = await Promise.all([
    statusStore.load(),
    sessionStore.listSessionMetadata(),
    loadRuntimeConfigOrDefault(),
  ]);

  const liveBySessionId = new Map(
    (snapshot.sessions ?? []).map((session) => [session.sessionId, session]),
  );
  const resolvedWorkspaceFilter = await resolveWorkspaceFilter(
    options.workspaceFilter,
    katoDir,
  );
  const includeStale = options.includeStale ?? true;
  const recordingsMode = options.recordingsMode ?? "latest";

  const rows = (await Promise.all(metadataList.map(async (
    metadata,
  ): Promise<SessionActivityRow> => {
    const live = liveBySessionId.get(metadata.sessionId);
    const recordings = buildRecordingRows(metadata, live, recordingsMode);
    const filteredRecordings = resolvedWorkspaceFilter
      ? recordings.filter((row) =>
        row.workspaceId === resolvedWorkspaceFilter.workspaceId
      )
      : recordings;
    const activeRecordingCount = filteredRecordings.filter((row) =>
      row.state === "engaged-active"
    ).length;
    const staleRecordingCount = filteredRecordings.filter((row) =>
      row.state === "engaged-stale"
    ).length;
    const state = normalizePersistedSessionState(
      metadata,
      deriveSessionGenerationState(
        {
          provider: metadata.provider,
          stale: live?.stale ?? true,
          activeRecordingCount,
          staleRecordingCount,
        },
        runtimeConfig,
      ),
      runtimeConfig,
    );
    const ingestionUiState = await resolveSessionIngestionUiState(
      metadata,
      state,
      runtimeConfig,
    );
    return {
      sessionKey: metadata.sessionKey,
      provider: metadata.provider,
      sessionId: metadata.sessionId,
      sessionShortId: deriveSessionShortId(metadata, live),
      providerSessionId: metadata.providerSessionId,
      snippet: live?.snippet,
      updatedAt: live?.updatedAt ?? metadata.updatedAt,
      lastEventAt: live?.lastEventAt,
      stale: live?.stale ?? true,
      state,
      canOpenIngestView: ingestionUiState.canOpenIngestView,
      ingestionAction: ingestionUiState.ingestionAction,
      sourceFilePath: metadata.sourceFilePath,
      twinPath: metadata.twinPath,
      activeRecordingCount,
      staleRecordingCount,
      stoppedRecordingCount:
        filteredRecordings.filter((row) => row.state === "stopped").length,
      recordings: filteredRecordings,
    };
  }))).filter((row) => includeStale || !row.stale).filter((row) =>
    !resolvedWorkspaceFilter || row.recordings.length > 0
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
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const [rows, resolvedWorkspaceFilter] = await Promise.all([
    loadSessionActivityRows({
      ...options,
      includeStale,
      katoDir,
    }),
    resolveWorkspaceFilter(options.workspaceFilter, katoDir),
  ]);

  return {
    includeStale,
    workspaceFilter: resolvedWorkspaceFilter?.selector,
    workspaceFilterId: resolvedWorkspaceFilter?.workspaceId,
    workspaceFilterAlias: resolvedWorkspaceFilter?.workspaceAlias,
    sessionCount: rows.length,
    activeSessionCount: rows.filter((row) => row.state === "active").length,
    staleSessionCount: rows.filter((row) => row.state === "stale").length,
    inactiveSessionCount: rows.filter((row) => row.state === "inactive").length,
    activeRecordingCount: rows.reduce(
      (sum, row) => sum + row.activeRecordingCount,
      0,
    ),
    staleRecordingCount: rows.reduce(
      (sum, row) => sum + row.staleRecordingCount,
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
