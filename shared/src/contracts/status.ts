import type { ProviderSessionTitleSource } from "./session_state.ts";

export interface ProviderStatus {
  provider: string;
  activeSessions: number;
  lastEventAt?: string;
}

export interface RecordingStatus {
  activeRecordings: number;
  destinations: number;
}

export interface MemoryProcessStats {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
}

export interface MemorySnapshotStats {
  estimatedBytes: number;
  sessionCount: number;
  eventCount: number;
  evictionsTotal: number;
  bytesReclaimedTotal: number;
  evictionsByReason: Record<string, number>;
  overBudget: boolean;
}

export interface MemoryStatus {
  daemonMaxMemoryBytes: number;
  process: MemoryProcessStats;
  snapshots: MemorySnapshotStats;
}

export interface DaemonRecordingStatus {
  recordingId?: string;
  recordingShortId?: string;
  workspaceAlias?: string;
  outputPath: string;
  startedAt: string;
  restartedAt?: string;
  lastWriteAt: string;
}

export interface DaemonSessionStatus {
  provider: string;
  sessionId: string;
  sessionShortId?: string;
  providerSessionId?: string;
  snippet?: string;
  /** Present when `snippet` carries a provider-maintained session title. */
  titleSource?: ProviderSessionTitleSource;
  updatedAt: string;
  lastEventAt?: string;
  stale: boolean;
  recordings?: DaemonRecordingStatus[];
}

/**
 * A provider session whose source transcript currently fails to ingest.
 * Listed independently of `sessions` (which filters for liveness) so a
 * stalled session stays visible. Cleared by the next successful ingest.
 */
export interface DaemonIngestionFailureStatus {
  provider: string;
  /** Provider session id (the transcript's id). */
  sessionId: string;
  error: string;
  firstFailedAt: string;
  lastFailedAt: string;
  consecutiveFailures: number;
  nextRetryAt: string;
}

/**
 * A provider whose file watcher is not trusted for some session roots, so
 * those roots are rescanned every few seconds instead of every few minutes.
 * Listed only while degraded; absent when every root is watched normally.
 */
export interface DaemonWatchDegradedStatus {
  provider: string;
  /**
   * `watcher-down`: the watcher failed and is being restarted.
   * `missed-changes`: rescans found changes the watcher never reported.
   */
  reason: "watcher-down" | "missed-changes";
  roots: string[];
  since: string;
  /** Changes the watcher missed before the roots were degraded. */
  missedChanges?: number;
}

export interface DaemonStatusSnapshot {
  schemaVersion: number;
  generatedAt: string;
  heartbeatAt: string;
  daemonRunning: boolean;
  daemonPid?: number;
  daemonVersion?: string;
  providers: ProviderStatus[];
  recordings: RecordingStatus;
  memory?: MemoryStatus;
  sessions?: DaemonSessionStatus[];
  ingestionFailures?: DaemonIngestionFailureStatus[];
  watchDegraded?: DaemonWatchDegradedStatus[];
}
