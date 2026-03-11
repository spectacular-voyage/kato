import {
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
} from "@kato/runtime";
import type { ActivityState } from "./activity_state.ts";
import type { SessionRecordingActivityRow } from "./sessions.ts";
import {
  loadSessionActivityRows,
  type LoadSessionActivityRowsOptions,
  resolveWorkspaceFilter,
  type SessionIngestionAction,
} from "./sessions.ts";

export type TwinPersistenceState = "current" | "behind" | "absent";

export interface TwinActivityRow {
  sessionKey: string;
  provider: string;
  sessionId: string;
  sessionShortId: string;
  providerSessionId: string;
  snippet?: string;
  updatedAt: string;
  lastEventAt?: string;
  state: ActivityState;
  twinState: TwinPersistenceState;
  twinPresent: boolean;
  twinAction: SessionIngestionAction;
  twinPath: string;
  sourceFilePath: string;
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  recordings: SessionRecordingActivityRow[];
}

export interface TwinsPageData {
  includeStale: boolean;
  workspaceFilter?: string;
  workspaceFilterId?: string;
  workspaceFilterAlias?: string;
  sessionCount: number;
  currentTwinCount: number;
  behindTwinCount: number;
  absentTwinCount: number;
  rows: TwinActivityRow[];
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

export async function loadTwinsPageData(
  options: LoadSessionActivityRowsOptions = {},
): Promise<TwinsPageData> {
  const includeStale = options.includeStale ?? true;
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sessionStore = new PersistentSessionStateStore({ katoDir });
  const [sessionRows, metadataRows, resolvedWorkspaceFilter] = await Promise
    .all([
      loadSessionActivityRows({
        ...options,
        includeStale,
        katoDir,
      }),
      sessionStore.listSessionMetadata(),
      resolveWorkspaceFilter(options.workspaceFilter, katoDir),
    ]);
  const metadataBySessionKey = new Map(
    metadataRows.map((metadata) => [metadata.sessionKey, metadata]),
  );
  const mappedRows: Array<TwinActivityRow | undefined> = await Promise.all(
    sessionRows.map(async (row) => {
      const metadata = metadataBySessionKey.get(row.sessionKey);
      if (!metadata) {
        return undefined;
      }

      const twinPresent = metadata.nextTwinSeq > 1;
      const twinState: TwinPersistenceState = !twinPresent
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
        twinPresent,
        twinAction: row.ingestionAction,
        twinPath: metadata.twinPath,
        sourceFilePath: metadata.sourceFilePath,
        activeRecordingCount: row.activeRecordingCount,
        staleRecordingCount: row.staleRecordingCount,
        stoppedRecordingCount: row.stoppedRecordingCount,
        recordings: row.recordings,
      };
    }),
  );
  const rows = mappedRows.filter((row): row is TwinActivityRow =>
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
