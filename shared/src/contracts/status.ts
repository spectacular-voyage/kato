export interface ProviderStatus {
  provider: string;
  activeSessions: number;
  lastMessageAt?: string;
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
  outputPath: string;
  startedAt: string;
  lastWriteAt: string;
}

export interface DaemonSessionStatus {
  provider: string;
  sessionId: string;
  sessionShortId?: string;
  providerSessionId?: string;
  snippet?: string;
  updatedAt: string;
  lastMessageAt?: string;
  stale: boolean;
  recording?: DaemonRecordingStatus;
}

export interface DaemonStatusSnapshot {
  schemaVersion: number;
  generatedAt: string;
  heartbeatAt: string;
  daemonRunning: boolean;
  daemonPid?: number;
  providers: ProviderStatus[];
  recordings: RecordingStatus;
  memory?: MemoryStatus;
  sessions?: DaemonSessionStatus[];
}
