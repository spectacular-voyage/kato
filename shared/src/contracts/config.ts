export type ConfigSource = "local-file" | "centralized-service";

export interface RuntimeConfig {
  schemaVersion: 1;
  runtimeDir: string;
  statusPath: string;
  controlPath: string;
  allowedWriteRoots: string[];
}

export interface RuntimeConfigMetadata {
  configSource: ConfigSource;
  statusSchemaVersion: 1;
  conversationSchemaVersion: 1;
}
