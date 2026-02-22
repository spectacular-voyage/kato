import type { DaemonStatusSnapshot } from "@kato/shared";

export interface StatusViewModel {
  generatedAt: string;
  daemon: "running" | "stopped";
  sessionCount: number;
  recordingCount: number;
}

export function toStatusViewModel(
  snapshot: DaemonStatusSnapshot,
): StatusViewModel {
  const sessionCount = snapshot.providers.reduce((sum, p) => {
    return sum + p.activeSessions;
  }, 0);

  return {
    generatedAt: snapshot.generatedAt,
    daemon: snapshot.daemonRunning ? "running" : "stopped",
    sessionCount,
    recordingCount: snapshot.recordings.activeRecordings,
  };
}
