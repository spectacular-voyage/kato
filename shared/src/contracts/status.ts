export interface ProviderStatus {
  provider: string;
  activeSessions: number;
  lastMessageAt?: string;
}

export interface RecordingStatus {
  activeRecordings: number;
  destinations: number;
}

export interface DaemonStatusSnapshot {
  schemaVersion: number;
  generatedAt: string;
  heartbeatAt: string;
  daemonRunning: boolean;
  daemonPid?: number;
  providers: ProviderStatus[];
  recordings: RecordingStatus;
}
