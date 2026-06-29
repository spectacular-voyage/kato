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

export type SecretsPolicyMode = "off" | "detect" | "redact";

export interface SecretsPolicyConfig {
  mode: SecretsPolicyMode;
  disabledRules: string[];
  /** Literal substrings, or `/pattern/` entries compiled as regexes. */
  allowlist: string[];
}

export interface MarkdownFrontmatterConfig {
  includeFrontmatterInMarkdownRecordings: boolean;
  includeUpdatedInFrontmatter: boolean;
  addParticipantUsernameToFrontmatter: boolean;
  addParticipantUsernameToHeadings: boolean;
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

export interface UserTagLibrariesConfig {
  globalSuggestions: string[];
  workspaceSuggestions: Record<string, string[]>;
}

export interface UserConfig {
  schemaVersion: 1;
  participants: UserParticipantsConfig;
  tagLibraries?: UserTagLibrariesConfig;
}

export interface ProviderSessionRoots {
  claude: string[];
  codex: string[];
  gemini: string[];
}

export interface ProviderAutoGenerateTwins {
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
  secretsPolicy: SecretsPolicyConfig;
}

export interface CliConfig {
  schemaVersion: 1;
  logging: RuntimeLoggingConfig;
}

export interface WebAuthConfig {
  username: string;
  passwordSalt: string;
  passwordHash: string;
  sessionSecret: string;
  cookieName: string;
}

export interface WebConfig {
  schemaVersion: 1;
  hostname: string;
  port: number;
  auth: WebAuthConfig;
}

export interface RuntimeConfig {
  schemaVersion: 1;
  runtimeDir: string;
  katoDir?: string;
  providerSessionRoots: ProviderSessionRoots;
  globalAutoGenerateTwins?: boolean;
  providerAutoGenerateTwins?: ProviderAutoGenerateTwins;
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
