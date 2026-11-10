// Log filter values shared by the logs page and its browser island. Kept apart
// from loaders/logs.ts, which reads log files and must stay out of the client
// bundle.
import type { LogLevel } from "@kato/runtime";

export type LogLevelFilter = LogLevel | "all";

export const DEFAULT_LOG_LEVEL_FILTER: LogLevelFilter = "warn";
