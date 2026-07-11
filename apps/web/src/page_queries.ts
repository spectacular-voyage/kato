import {
  DEFAULT_LOG_LEVEL_FILTER,
  type LogChannelFilter,
  type LogLevelFilter,
  type LogScopeFilter,
} from "./loaders/logs.ts";
import type { RecordingStateFilter } from "./loaders/recordings.ts";

export interface SessionPageQuery {
  includeStale: boolean;
  workspaceFilter?: string;
}

export interface RecordingsPageQuery {
  workspaceFilter?: string;
  stateFilter: RecordingStateFilter;
}

export interface LogsPageQuery {
  channel: LogChannelFilter;
  scope: LogScopeFilter;
  level: LogLevelFilter;
  eventFilter?: string;
  textFilter?: string;
}

function normalizeSearchValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function parseSessionPageQuery(url: URL): SessionPageQuery {
  return {
    includeStale: url.searchParams.get("view") !== "active",
    workspaceFilter: normalizeSearchValue(url.searchParams.get("workspace")),
  };
}

export function parseRecordingsPageQuery(url: URL): RecordingsPageQuery {
  const state = url.searchParams.get("state");

  return {
    workspaceFilter: normalizeSearchValue(url.searchParams.get("workspace")),
    stateFilter: state === "engaged-active" || state === "engaged-stale" ||
        state === "stopped"
      ? state
      : "all",
  };
}

export function parseLogsPageQuery(url: URL): LogsPageQuery {
  const channel = url.searchParams.get("channel");
  const scope = url.searchParams.get("scope");
  const level = url.searchParams.get("level");

  return {
    channel: channel === "operational" || channel === "security-audit"
      ? channel
      : "all",
    scope: scope === "daemon" || scope === "web" ? scope : "all",
    level: level === "all" || level === "debug" || level === "info" ||
        level === "warn" || level === "error"
      ? level
      : DEFAULT_LOG_LEVEL_FILTER,
    eventFilter: normalizeSearchValue(url.searchParams.get("event")),
    textFilter: normalizeSearchValue(url.searchParams.get("q")),
  };
}
