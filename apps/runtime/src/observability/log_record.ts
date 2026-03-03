export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  channel: "operational" | "security-audit";
  event: string;
  message: string;
  attributes?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): Promise<void> | void;
}

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
