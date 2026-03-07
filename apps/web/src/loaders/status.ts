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
import { toStatusViewModel } from "../main.ts";

export interface SummaryPageData {
  generatedAt: string;
  heartbeatAt: string;
  daemon: "running" | "stopped";
  daemonPid?: number;
  daemonVersion?: string;
  sessionCount: number;
  recordingCount: number;
  sessions: DaemonSessionStatus[];
  providers: ProviderStatus[];
  memory?: MemoryStatus;
  stale: boolean;
  statusPath: string;
}

export interface LoadSummaryPageDataOptions {
  includeStale?: boolean;
  now?: () => Date;
  statusPath?: string;
  statusStore?: DaemonStatusSnapshotStoreLike;
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

  return {
    generatedAt: viewModel.generatedAt,
    heartbeatAt: snapshot.heartbeatAt,
    daemon: viewModel.daemon,
    daemonPid: snapshot.daemonPid,
    daemonVersion: snapshot.daemonVersion,
    sessionCount: viewModel.sessionCount,
    recordingCount: viewModel.recordingCount,
    sessions: viewModel.sessions,
    providers: snapshot.providers,
    memory: viewModel.memory,
    stale: isStatusSnapshotStale(snapshot, now()),
    statusPath,
  };
}
