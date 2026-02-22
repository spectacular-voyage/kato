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
  generatedAt: string;
  daemonRunning: boolean;
  daemonPid?: number;
  providers: ProviderStatus[];
  recordings: RecordingStatus;
}
