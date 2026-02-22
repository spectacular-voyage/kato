export type ConfigSource = "local-file" | "centralized-service";

export interface RuntimeConfigMetadata {
  configSource: ConfigSource;
  statusSchemaVersion: 1;
  conversationSchemaVersion: 1;
}
