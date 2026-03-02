export type ConfigSource = "local-file" | "centralized-service";

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";

export interface DaemonFeatureFlags {
  daemonExportEnabled: boolean;
  captureIncludeSystemEvents: boolean;
}

export interface ExportFeatureFlags {
  writerIncludeCommentary: boolean;
  writerIncludeThinking: boolean;
  writerIncludeToolCalls: boolean;
  writerIncludeToolResults: boolean;
  writerIncludeDecisionPrompt: boolean;
  writerIncludeDecisionOptions: boolean;
  writerIncludeDecisionSelection: boolean;
  writerItalicizeUserMessages: boolean;
}

export interface RuntimeLoggingConfig {
  operationalLevel: RuntimeLogLevel;
  auditLevel: RuntimeLogLevel;
}

export interface MarkdownFrontmatterConfig {
  includeFrontmatterInMarkdownRecordings: boolean;
  includeUpdatedInFrontmatter: boolean;
  addParticipantUsernameToFrontmatter: boolean;
  defaultParticipantUsername: string;
  includeSessionIds: boolean;
  includeWorkspaceIds: boolean;
  includeRecordingIds: boolean;
  includeConversationEventKinds: boolean;
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
  katoDir?: string;
  statusPath: string;
  controlPath: string;
  allowedWriteRoots: string[];
  providerSessionRoots: ProviderSessionRoots;
  globalAutoGenerateSnapshots?: boolean;
  providerAutoGenerateSnapshots?: ProviderAutoGenerateSnapshots;
  cleanSessionStatesOnShutdown?: boolean;
  daemonFeatureFlags: DaemonFeatureFlags;
  exportMarkdownFrontmatter: MarkdownFrontmatterConfig;
  exportFeatureFlags: ExportFeatureFlags;
  logging: RuntimeLoggingConfig;
  daemonMaxMemoryMb: number;
}

export interface RuntimeConfigMetadata {
  configSource: ConfigSource;
  statusSchemaVersion: 1;
  conversationSchemaVersion: 2;
}
