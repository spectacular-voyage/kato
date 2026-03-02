import type {
  DaemonSessionStatus,
  DaemonStatusSnapshot,
  MemoryStatus,
} from "@kato/shared";
import { filterSessionsForDisplay } from "@kato/shared";

export interface StatusViewModel {
  generatedAt: string;
  daemon: "running" | "stopped";
  sessionCount: number;
  recordingCount: number;
  sessions: DaemonSessionStatus[];
  memory?: MemoryStatus;
}

export function toStatusViewModel(
  snapshot: DaemonStatusSnapshot,
  opts: { includeStale?: boolean } = {},
): StatusViewModel {
  const includeStale = opts.includeStale ?? false;

  const sessions = filterSessionsForDisplay(snapshot.sessions ?? [], {
    includeStale,
  });

  return {
    generatedAt: snapshot.generatedAt,
    daemon: snapshot.daemonRunning ? "running" : "stopped",
    sessionCount: sessions.length,
    recordingCount: snapshot.recordings.activeRecordings,
    sessions,
    memory: snapshot.memory,
  };
}
