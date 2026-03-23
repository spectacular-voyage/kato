import type {
  DaemonRecordingStatus,
  DaemonSessionStatus,
  SessionMetadataV1,
} from "@kato/shared";
import { DEFAULT_STATUS_STALE_AFTER_MS, isSessionStale } from "@kato/shared";
import {
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  PersistentSessionStateStore,
  type RegisteredWorkspace,
  resolveDefaultKatoDir,
  resolveDefaultStatusPath,
  resolveDefaultWorkspaceRegistryPath,
  WorkspaceRegistryFileStore,
} from "@kato/runtime";
import { relative } from "@std/path";
import {
  type ActivityState,
  deriveSessionGenerationState,
  providerAutoGeneratesTwins,
} from "../activity_state.ts";
import { loadRuntimeConfigOrDefault } from "./activity_state.ts";
import { buildSessionInventorySessionHref } from "../session_routes.ts";
import { resolveKatoDirFromStatusPath } from "./logs.ts";

export interface SessionRecordingActivityRow {
  key: string;
  state: "engaged-active" | "engaged-stale" | "stopped";
  workspaceId?: string;
  workspaceAlias?: string;
  workspaceDisplayName?: string;
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
  workspaceFilterDisplayName?: string;
  workspaceOptions: WorkspaceOption[];
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
  workspaceEntries?: RegisteredWorkspace[];
}

export interface ResolvedWorkspaceFilter {
  selector: string;
  workspaceId: string;
  workspaceAlias?: string;
  workspaceDisplayName?: string;
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

export interface WorkspaceOption {
  workspaceId: string;
  alias: string;
  displayName?: string;
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

function resolveEngagedRecordingState(options: {
  startedAt?: string;
  lastWriteAt?: string;
  sessionStale: boolean;
  now: Date;
}): SessionRecordingActivityRow["state"] {
  for (const value of [options.lastWriteAt, options.startedAt]) {
    if (!value) {
      continue;
    }
    return isSessionStale(
        value,
        options.now,
        DEFAULT_STATUS_STALE_AFTER_MS,
      )
      ? "engaged-stale"
      : "engaged-active";
  }
  return options.sessionStale ? "engaged-stale" : "engaged-active";
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

async function loadRegisteredWorkspaces(
  katoDir: string,
): Promise<RegisteredWorkspace[]> {
  try {
    const store = new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
    return await store.load();
  } catch {
    return [];
  }
}

function sortRecordings(
  rows: SessionRecordingActivityRow[],
): SessionRecordingActivityRow[] {
  return [...rows].sort((a, b) => {
    const timeDiff = resolveActivityTimestamp(b) - resolveActivityTimestamp(a);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.outputPath.localeCompare(b.outputPath);
  });
}

function matchesWorkspaceFilter(
  row: SessionRecordingActivityRow,
  resolvedWorkspaceFilter: ResolvedWorkspaceFilter | undefined,
): boolean {
  if (!resolvedWorkspaceFilter) {
    return true;
  }
  return row.workspaceId === resolvedWorkspaceFilter.workspaceId ||
    (
      !row.workspaceId &&
      !!row.workspaceAlias &&
      row.workspaceAlias === resolvedWorkspaceFilter.workspaceAlias
    );
}

function resolveWorkspaceDisplayName(
  row: SessionRecordingActivityRow,
  workspaceDisplayNamesById: ReadonlyMap<string, string | undefined>,
  workspaceDisplayNamesByAlias: ReadonlyMap<string, string | undefined>,
): string | undefined {
  return (row.workspaceId
    ? workspaceDisplayNamesById.get(row.workspaceId)
    : undefined) ??
    (row.workspaceAlias
      ? workspaceDisplayNamesByAlias.get(row.workspaceAlias)
      : undefined);
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

function hasPersistedTwinState(metadata: SessionMetadataV1): boolean {
  return hasTwinHistory(metadata) ||
    metadata.recentFingerprints.length > 0 ||
    metadata.ingestionActivatedAt !== undefined;
}

async function twinFileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
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

async function normalizePersistedTwinMetadata(
  sessionStore: PersistentSessionStateStore,
  metadata: SessionMetadataV1,
): Promise<SessionMetadataV1> {
  if (!hasPersistedTwinState(metadata)) {
    return metadata;
  }
  if (await twinFileExists(metadata.twinPath)) {
    return metadata;
  }
  return await sessionStore.resetSessionTwinPersistence(metadata);
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
  now: Date,
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
  const activeStartedAt = activeCycle?.startedAt ?? liveRecording?.startedAt;
  const activeLastWriteAt = liveRecording?.lastWriteAt ??
    activeCycle?.lastWriteAt;

  if (activeCycle || output.desiredState === "on") {
    return [{
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        activeCycle?.recordingCycleId ?? liveRecording?.recordingId ?? "active",
      ].join(":"),
      state: resolveEngagedRecordingState({
        startedAt: activeStartedAt,
        lastWriteAt: activeLastWriteAt,
        sessionStale,
        now,
      }),
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt: activeStartedAt,
      lastWriteAt: activeLastWriteAt,
      recordingCycleId: activeCycle?.recordingCycleId,
    }];
  }

  const latestStoppedCycle = findLatestStoppedCycle(output);
  if (latestStoppedCycle) {
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
      lastWriteAt: latestStoppedCycle.lastWriteAt,
      stoppedAt: latestStoppedCycle.stoppedAt,
      recordingCycleId: latestStoppedCycle.recordingCycleId,
    }];
  }

  if (!liveRecording) {
    return [];
  }

  return [{
    key: [
      output.workspaceId,
      output.currentResolvedPath,
      liveRecording.recordingId ?? "active",
    ].join(":"),
    state: resolveEngagedRecordingState({
      startedAt: liveRecording.startedAt,
      lastWriteAt: liveRecording.lastWriteAt,
      sessionStale,
      now,
    }),
    workspaceId: output.workspaceId,
    workspaceAlias: output.workspaceAliasSnapshot ??
      liveRecording.workspaceAlias,
    workspaceHref: buildWorkspaceHref(output.workspaceId),
    outputPath: output.currentResolvedPath,
    displayOutputPath,
    startedAt: liveRecording.startedAt,
    lastWriteAt: liveRecording.lastWriteAt,
    recordingCycleId: liveRecording.recordingId,
  }];
}

function buildAllRecordingRowsForOutput(
  output: SessionWorkspaceOutputState,
  liveRecordings: DaemonRecordingStatus[],
  sessionStale: boolean,
  now: Date,
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
    const startedAt = cycle.startedAt ??
      (active ? liveRecording?.startedAt : undefined);
    const lastWriteAt = active
      ? liveRecording?.lastWriteAt ?? cycle.lastWriteAt
      : cycle.lastWriteAt;
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        cycle.recordingCycleId,
      ].join(":"),
      state: active
        ? resolveEngagedRecordingState({
          startedAt,
          lastWriteAt,
          sessionStale,
          now,
        })
        : "stopped",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt,
      stoppedAt: active ? undefined : cycle.stoppedAt,
      lastWriteAt,
      recordingCycleId: cycle.recordingCycleId,
    });
  }

  const hasActiveRow = rows.some((row) => row.state !== "stopped");
  if (
    !hasActiveRow &&
    (output.desiredState === "on" || (rows.length === 0 && liveRecording))
  ) {
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        activeCycle?.recordingCycleId ?? liveRecording?.recordingId ?? "active",
      ].join(":"),
      state: resolveEngagedRecordingState({
        startedAt: activeCycle?.startedAt ?? liveRecording?.startedAt,
        lastWriteAt: liveRecording?.lastWriteAt ?? activeCycle?.lastWriteAt,
        sessionStale,
        now,
      }),
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
  now: Date,
): SessionRecordingActivityRow[] {
  const liveRecordings = live?.recordings ?? [];
  const rows: SessionRecordingActivityRow[] = [];
  const seenOutputPaths = new Set<string>();
  const sessionStale = live?.stale ?? true;

  for (const output of session.workspaceOutputs ?? []) {
    const outputRows = recordingsMode === "all"
      ? buildAllRecordingRowsForOutput(
        output,
        liveRecordings,
        sessionStale,
        now,
      )
      : buildRecordingRowsForOutput(
        output,
        liveRecordings,
        sessionStale,
        now,
      );
    for (const row of outputRows) {
      rows.push(row);
      seenOutputPaths.add(row.outputPath);
    }
  }

  for (const liveRecording of liveRecordings) {
    if (seenOutputPaths.has(liveRecording.outputPath)) {
      continue;
    }
    rows.push({
      key: [
        session.sessionKey,
        liveRecording.outputPath,
        liveRecording.recordingId ?? "active",
      ].join(":"),
      state: resolveEngagedRecordingState({
        startedAt: liveRecording.startedAt,
        lastWriteAt: liveRecording.lastWriteAt,
        sessionStale,
        now,
      }),
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
  workspaceEntries?: RegisteredWorkspace[],
): Promise<ResolvedWorkspaceFilter | undefined> {
  const trimmed = selector?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const entries = workspaceEntries ?? await loadRegisteredWorkspaces(katoDir);
    const matched = entries.find((entry) =>
      entry.workspaceId === trimmed || entry.alias === trimmed
    );
    if (matched) {
      return {
        selector: trimmed,
        workspaceId: matched.workspaceId,
        workspaceAlias: matched.alias,
        workspaceDisplayName: matched.displayName,
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
      sessionHref: buildSessionInventorySessionHref(row.sessionId),
      updatedAt: row.updatedAt,
      lastEventAt: row.lastEventAt,
    }))
  ).sort((a, b) => {
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
  const statusPath = options.statusPath ??
    resolveDefaultStatusPath(options.katoDir ?? resolveDefaultKatoDir());
  const katoDir = options.katoDir ?? resolveKatoDirFromStatusPath(statusPath);
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(statusPath, now);
  const sessionStore = new PersistentSessionStateStore({
    katoDir,
    now,
  });
  const workspaceEntriesPromise = options.workspaceEntries
    ? Promise.resolve(options.workspaceEntries)
    : loadRegisteredWorkspaces(katoDir);
  const [snapshot, metadataList, runtimeConfig, workspaceEntries] =
    await Promise.all([
      statusStore.load(),
      sessionStore.listSessionMetadata(),
      loadRuntimeConfigOrDefault({ katoDir }),
      workspaceEntriesPromise,
    ]);
  const normalizedMetadataList = await Promise.all(
    metadataList.map((metadata) =>
      normalizePersistedTwinMetadata(sessionStore, metadata)
    ),
  );

  const liveBySessionId = new Map(
    (snapshot.sessions ?? []).map((session) => [session.sessionId, session]),
  );
  const resolvedWorkspaceFilter = await resolveWorkspaceFilter(
    options.workspaceFilter,
    katoDir,
    workspaceEntries,
  );
  const workspaceDisplayNamesById = new Map(
    workspaceEntries.map((entry) => [entry.workspaceId, entry.displayName]),
  );
  const workspaceDisplayNamesByAlias = new Map(
    workspaceEntries.map((entry) => [entry.alias, entry.displayName]),
  );
  const statusClock = (() => {
    const generatedAtMs = Date.parse(snapshot.generatedAt);
    return Number.isNaN(generatedAtMs) ? now() : new Date(generatedAtMs);
  })();
  const includeStale = options.includeStale ?? true;
  const recordingsMode = options.recordingsMode ?? "latest";

  const rows = (await Promise.all(normalizedMetadataList.map((
    metadata,
  ): SessionActivityRow => {
    const live = liveBySessionId.get(metadata.sessionId);
    const recordings = buildRecordingRows(
      metadata,
      live,
      recordingsMode,
      statusClock,
    );
    const filteredRecordings = resolvedWorkspaceFilter
      ? recordings.filter((row) =>
        matchesWorkspaceFilter(row, resolvedWorkspaceFilter)
      )
      : recordings;
    const displayRecordings = filteredRecordings.map((recording) => {
      const workspaceDisplayName = resolveWorkspaceDisplayName(
        recording,
        workspaceDisplayNamesById,
        workspaceDisplayNamesByAlias,
      );
      return workspaceDisplayName
        ? {
          ...recording,
          workspaceDisplayName,
        }
        : recording;
    });
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
      activeRecordingCount,
      staleRecordingCount,
      stoppedRecordingCount:
        filteredRecordings.filter((row) => row.state === "stopped").length,
      recordings: displayRecordings,
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
  const statusPath = options.statusPath ??
    resolveDefaultStatusPath(options.katoDir ?? resolveDefaultKatoDir());
  const katoDir = options.katoDir ?? resolveKatoDirFromStatusPath(statusPath);
  const workspaceEntries = options.workspaceEntries ??
    await loadRegisteredWorkspaces(katoDir);
  const [rows, resolvedWorkspaceFilter] = await Promise.all([
    loadSessionActivityRows({
      ...options,
      includeStale,
      katoDir,
      statusPath,
      workspaceEntries,
    }),
    resolveWorkspaceFilter(
      options.workspaceFilter,
      katoDir,
      workspaceEntries,
    ),
  ]);
  const workspaceOptions = workspaceEntries
    .map((entry) => ({
      workspaceId: entry.workspaceId,
      alias: entry.alias,
      displayName: entry.displayName,
    }))
    .sort((a, b) =>
      a.alias.localeCompare(b.alias) ||
      a.workspaceId.localeCompare(b.workspaceId)
    );

  return {
    includeStale,
    workspaceFilter: resolvedWorkspaceFilter?.selector,
    workspaceFilterId: resolvedWorkspaceFilter?.workspaceId,
    workspaceFilterAlias: resolvedWorkspaceFilter?.workspaceAlias,
    workspaceFilterDisplayName: resolvedWorkspaceFilter?.workspaceDisplayName,
    workspaceOptions,
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
