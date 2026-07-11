import type { RecordingStateFilter } from "./loaders/recordings.ts";
import { hashStringFNV1a } from "@kato/runtime";

export interface SessionRouteOptions {
  includeStale?: boolean;
  includeSubagents?: boolean;
  workspaceFilter?: string;
}

function applySessionRouteOptions(
  url: URL,
  options: SessionRouteOptions,
): void {
  if (options.includeStale === false) {
    url.searchParams.set("view", "active");
  } else {
    url.searchParams.delete("view");
  }

  const workspaceFilter = options.workspaceFilter?.trim();
  if (workspaceFilter) {
    url.searchParams.set("workspace", workspaceFilter);
  } else {
    url.searchParams.delete("workspace");
  }
}

export function buildSessionInventoryHref(
  options: SessionRouteOptions = {},
): string {
  const url = new URL("http://kato.local/sessions");
  applySessionRouteOptions(url, options);
  if (options.includeSubagents === false) {
    url.searchParams.set("subagents", "hide");
  } else {
    url.searchParams.delete("subagents");
  }
  return `${url.pathname}${url.search}`;
}

export function buildSessionInventorySessionHref(
  sessionId: string,
  options: SessionRouteOptions = {},
): string {
  return `${buildSessionInventoryHref(options)}#session-${sessionId}`;
}

export function buildMaintenanceHref(
  options: SessionRouteOptions = {},
): string {
  const url = new URL("http://kato.local/maintenance");
  applySessionRouteOptions(url, options);
  return `${url.pathname}${url.search}`;
}

export function buildRecordingsHref(
  options: {
    stateFilter?: RecordingStateFilter;
    workspaceFilter?: string;
  } = {},
): string {
  const url = new URL("http://kato.local/recordings");
  if (options.stateFilter && options.stateFilter !== "all") {
    url.searchParams.set("state", options.stateFilter);
  }
  const workspaceFilter = options.workspaceFilter?.trim();
  if (workspaceFilter) {
    url.searchParams.set("workspace", workspaceFilter);
  }
  return `${url.pathname}${url.search}`;
}

export function buildRecordingRowAnchorId(
  options: { recordingCycleId?: string; rowKey?: string },
): string {
  const recordingCycleId = options.recordingCycleId?.trim();
  if (recordingCycleId) {
    return `recording-${recordingCycleId}`;
  }
  const rowKey = options.rowKey?.trim();
  if (rowKey) {
    return `recording-key-${hashStringFNV1a(rowKey)}`;
  }
  return "recordings";
}

export function buildRecordingsRecordingHref(
  options: {
    stateFilter?: RecordingStateFilter;
    workspaceFilter?: string;
    recordingCycleId?: string;
    rowKey?: string;
  },
): string {
  return `${
    buildRecordingsHref({
      stateFilter: options.stateFilter,
      workspaceFilter: options.workspaceFilter,
    })
  }#${
    buildRecordingRowAnchorId({
      recordingCycleId: options.recordingCycleId,
      rowKey: options.rowKey,
    })
  }`;
}
