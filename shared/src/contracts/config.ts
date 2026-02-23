export type ConfigSource = "local-file" | "centralized-service";

export interface RuntimeFeatureFlags {
  writerIncludeThinking: boolean;
  writerIncludeToolCalls: boolean;
  writerItalicizeUserMessages: boolean;
  daemonExportEnabled: boolean;
}

export interface RuntimeConfig {
  schemaVersion: 1;
  runtimeDir: string;
  statusPath: string;
  controlPath: string;
  allowedWriteRoots: string[];
  featureFlags: RuntimeFeatureFlags;
}

export interface RuntimeConfigMetadata {
  configSource: ConfigSource;
  statusSchemaVersion: 1;
  conversationSchemaVersion: 1;
}
