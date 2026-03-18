import {
  flattenSessionRecordings,
  loadSessionActivityRows,
  type LoadSessionActivityRowsOptions,
  type RecordingListEntry,
  resolveWorkspaceFilter,
} from "./sessions.ts";
import { resolveDefaultKatoDir } from "@kato/runtime";

export type RecordingStateFilter =
  | "all"
  | "engaged-active"
  | "engaged-stale"
  | "stopped";

export interface RecordingsPageData {
  includeStale: boolean;
  workspaceFilter?: string;
  workspaceFilterId?: string;
  workspaceFilterAlias?: string;
  workspaceFilterDisplayName?: string;
  stateFilter: RecordingStateFilter;
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  rows: RecordingListEntry[];
}

export interface LoadRecordingsPageDataOptions
  extends LoadSessionActivityRowsOptions {
  stateFilter?: RecordingStateFilter;
}

function matchesStateFilter(
  state: RecordingsPageData["rows"][number]["state"],
  stateFilter: RecordingStateFilter,
): boolean {
  return stateFilter === "all" || state === stateFilter;
}

export async function loadRecordingsPageData(
  options: LoadRecordingsPageDataOptions = {},
): Promise<RecordingsPageData> {
  const includeStale = options.includeStale ?? true;
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const [sessionRows, resolvedWorkspaceFilter] = await Promise.all([
    loadSessionActivityRows({
      ...options,
      includeStale,
      recordingsMode: "all",
      katoDir,
    }),
    resolveWorkspaceFilter(options.workspaceFilter, katoDir),
  ]);
  const stateFilter = options.stateFilter ?? "all";
  const allRows = flattenSessionRecordings(sessionRows);
  const rows = allRows.filter((row) =>
    matchesStateFilter(row.state, stateFilter)
  );

  return {
    includeStale,
    workspaceFilter: resolvedWorkspaceFilter?.selector,
    workspaceFilterId: resolvedWorkspaceFilter?.workspaceId,
    workspaceFilterAlias: resolvedWorkspaceFilter?.workspaceAlias,
    workspaceFilterDisplayName: resolvedWorkspaceFilter?.workspaceDisplayName,
    stateFilter,
    activeRecordingCount:
      allRows.filter((row) => row.state === "engaged-active")
        .length,
    staleRecordingCount: allRows.filter((row) => row.state === "engaged-stale")
      .length,
    stoppedRecordingCount:
      allRows.filter((row) => row.state === "stopped").length,
    rows,
  };
}
