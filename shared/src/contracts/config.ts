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
  includeSessionIds: boolean;
  includeWorkspaceIds: boolean;
  includeRecordingIds: boolean;
  includeConversationEventKinds: boolean;
}

export interface UserParticipantsConfig {
  defaultUsername: string;
  workspaceUsernames: Record<string, string>;
  excludeMeFromParticipantList: boolean;
}

export interface UserConfig {
  schemaVersion: 1;
  participants: UserParticipantsConfig;
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

export interface SharedBehaviorConfig {
  schemaVersion: 1;
  allowedWriteRoots: string[];
  exportTimezone?: string;
  exportMarkdownFrontmatter: MarkdownFrontmatterConfig;
  exportFeatureFlags: ExportFeatureFlags;
}

export interface CliConfig {
  schemaVersion: 1;
  logging: RuntimeLoggingConfig;
}

export interface RuntimeConfig {
  schemaVersion: 1;
  runtimeDir: string;
  katoDir?: string;
  providerSessionRoots: ProviderSessionRoots;
  globalAutoGenerateSnapshots?: boolean;
  providerAutoGenerateSnapshots?: ProviderAutoGenerateSnapshots;
  cleanSessionStatesOnShutdown?: boolean;
  daemonFeatureFlags: DaemonFeatureFlags;
  logging: RuntimeLoggingConfig;
  daemonMaxMemoryMb: number;
}

export interface RuntimeConfigMetadata {
  configSource: ConfigSource;
  statusSchemaVersion: 2;
  conversationSchemaVersion: 2;
}
