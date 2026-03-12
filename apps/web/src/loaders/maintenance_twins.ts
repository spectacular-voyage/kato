import {
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
} from "@kato/runtime";
import type { ActivityState } from "../activity_state.ts";
import type { LoadSessionActivityRowsOptions } from "./sessions.ts";
import {
  loadSessionActivityRows,
  resolveWorkspaceFilter,
  type SessionRecordingActivityRow,
} from "./sessions.ts";

export type MaintenanceTwinState = "current" | "behind" | "absent";
export type MaintenanceTwinAction = "create" | "update" | "none";

export interface MaintenanceTwinRow {
  sessionKey: string;
  provider: string;
  sessionId: string;
  sessionShortId: string;
  providerSessionId: string;
  snippet?: string;
  updatedAt: string;
  lastEventAt?: string;
  state: ActivityState;
  twinState: MaintenanceTwinState;
  twinAction: MaintenanceTwinAction;
  twinPresent: boolean;
  twinPath: string;
  sourceFilePath: string;
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  recordings: SessionRecordingActivityRow[];
}

export interface MaintenanceTwinsData {
  includeStale: boolean;
  workspaceFilter?: string;
  workspaceFilterId?: string;
  workspaceFilterAlias?: string;
  sessionCount: number;
  currentTwinCount: number;
  behindTwinCount: number;
  absentTwinCount: number;
  rows: MaintenanceTwinRow[];
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

async function needsTwinUpdate(
  sourceFilePath: string,
  lastObservedMtimeMs: number | undefined,
): Promise<boolean> {
  if (
    lastObservedMtimeMs === undefined || !Number.isFinite(lastObservedMtimeMs)
  ) {
    return false;
  }

  try {
    const sourceFileMtimeMs = (await Deno.stat(sourceFilePath)).mtime
      ?.getTime();
    return sourceFileMtimeMs !== undefined &&
      Number.isFinite(sourceFileMtimeMs) &&
      sourceFileMtimeMs > lastObservedMtimeMs;
  } catch {
    return false;
  }
}

function resolveTwinAction(state: MaintenanceTwinState): MaintenanceTwinAction {
  switch (state) {
    case "absent":
      return "create";
    case "behind":
      return "update";
    case "current":
      return "none";
  }
}

export async function loadMaintenanceTwinsData(
  options: LoadSessionActivityRowsOptions = {},
): Promise<MaintenanceTwinsData> {
  const includeStale = options.includeStale ?? true;
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sessionRows = await loadSessionActivityRows({
    ...options,
    includeStale,
    katoDir,
  });
  const sessionStore = new PersistentSessionStateStore({ katoDir });
  const [metadataRows, resolvedWorkspaceFilter] = await Promise.all([
    sessionStore.listSessionMetadata(),
    resolveWorkspaceFilter(options.workspaceFilter, katoDir),
  ]);
  const metadataBySessionKey = new Map(
    metadataRows.map((metadata) => [metadata.sessionKey, metadata]),
  );
  const mappedRows: Array<MaintenanceTwinRow | undefined> = await Promise.all(
    sessionRows.map(async (row) => {
      const metadata = metadataBySessionKey.get(row.sessionKey);
      if (!metadata) {
        return undefined;
      }

      const twinFilePresent = await twinFileExists(metadata.twinPath);
      const twinPresent = twinFilePresent && metadata.nextTwinSeq > 1;
      const twinState: MaintenanceTwinState = !twinPresent
        ? "absent"
        : await needsTwinUpdate(
            metadata.sourceFilePath,
            metadata.lastObservedMtimeMs,
          )
        ? "behind"
        : "current";

      return {
        sessionKey: row.sessionKey,
        provider: row.provider,
        sessionId: row.sessionId,
        sessionShortId: row.sessionShortId,
        providerSessionId: row.providerSessionId,
        snippet: row.snippet,
        updatedAt: row.updatedAt,
        lastEventAt: row.lastEventAt,
        state: row.state,
        twinState,
        twinAction: resolveTwinAction(twinState),
        twinPresent,
        twinPath: metadata.twinPath,
        sourceFilePath: metadata.sourceFilePath,
        activeRecordingCount: row.activeRecordingCount,
        staleRecordingCount: row.staleRecordingCount,
        stoppedRecordingCount: row.stoppedRecordingCount,
        recordings: row.recordings,
      };
    }),
  );
  const rows = mappedRows.filter((row): row is MaintenanceTwinRow =>
    row !== undefined
  );

  return {
    includeStale,
    workspaceFilter: resolvedWorkspaceFilter?.selector,
    workspaceFilterId: resolvedWorkspaceFilter?.workspaceId,
    workspaceFilterAlias: resolvedWorkspaceFilter?.workspaceAlias,
    sessionCount: rows.length,
    currentTwinCount: rows.filter((row) => row.twinState === "current").length,
    behindTwinCount: rows.filter((row) => row.twinState === "behind").length,
    absentTwinCount: rows.filter((row) => row.twinState === "absent").length,
    rows,
  };
}
