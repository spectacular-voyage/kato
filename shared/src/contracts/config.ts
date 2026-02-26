export type ConfigSource = "local-file" | "centralized-service";

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeFeatureFlags {
  writerIncludeCommentary: boolean;
  writerIncludeThinking: boolean;
  writerIncludeToolCalls: boolean;
  writerItalicizeUserMessages: boolean;
  daemonExportEnabled: boolean;
  captureIncludeSystemEvents: boolean;
}

export interface RuntimeLoggingConfig {
  operationalLevel: RuntimeLogLevel;
  auditLevel: RuntimeLogLevel;
}

export interface ProviderSessionRoots {
  claude: string[];
  codex: string[];
  gemini: string[];
}

export interface ProviderAutoGenerateSnapshots {
  claude?: boolean;
  codex?: boolean;
  gemini?: boolean;
}

export interface RuntimeConfig {
  schemaVersion: 1;
  runtimeDir: string;
  statusPath: string;
  controlPath: string;
  allowedWriteRoots: string[];
  providerSessionRoots: ProviderSessionRoots;
  globalAutoGenerateSnapshots?: boolean;
  providerAutoGenerateSnapshots?: ProviderAutoGenerateSnapshots;
  cleanSessionStatesOnShutdown?: boolean;
  featureFlags: RuntimeFeatureFlags;
  logging: RuntimeLoggingConfig;
  daemonMaxMemoryMb: number;
}

export interface RuntimeConfigMetadata {
  configSource: ConfigSource;
  statusSchemaVersion: 1;
  conversationSchemaVersion: 2;
}
