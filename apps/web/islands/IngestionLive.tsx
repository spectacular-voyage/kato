import {
  type ActivityState,
  activityStateDot,
  activityStateLabel,
  recordingActivityStateLabel,
} from "../src/loaders/activity_state.ts";
import type { SessionsPageData } from "../src/loaders/sessions.ts";
import { buildIngestionHref } from "../src/session_routes.ts";
import { formatTimestamp } from "../src/time.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

function recordingState(
  state: "engaged-active" | "engaged-stale" | "stopped",
): ActivityState {
  switch (state) {
    case "engaged-active":
      return "active";
    case "engaged-stale":
      return "stale";
    case "stopped":
      return "inactive";
  }
}

function buildPageTitle(
  workspaceAlias: string | undefined,
  workspaceId: string | undefined,
): string {
  const workspaceLabel = workspaceAlias ?? workspaceId;
  return workspaceLabel ? `Ingestion for ${workspaceLabel}` : "Ingestion";
}

function buildCountSummary(options: {
  includeStale: boolean;
  activeSessionCount: number;
  staleSessionCount: number;
}): string {
  if (!options.includeStale) {
    return `Active: ${options.activeSessionCount}`;
  }
  return `Active: ${options.activeSessionCount}, Idle: ${options.staleSessionCount}`;
}

export default function IngestionLive(
  props: { initialData: SessionsPageData; endpoint: string },
) {
  const pageData = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  const rows = pageData.rows.filter((row) => row.canOpenIngestView);
  const heading = buildPageTitle(
    pageData.workspaceFilterAlias,
    pageData.workspaceFilterId,
  );
  const countSummary = buildCountSummary({
    includeStale: pageData.includeStale,
    activeSessionCount: rows.filter((row) => row.state === "active").length,
    staleSessionCount: rows.filter((row) => row.state === "stale").length,
  });

  return (
    <section class="grid">
      <article class="card span-12">
        <div class="page-toolbar">
          <div>
            <h2>{heading}</h2>
            {pageData.workspaceFilterId
              ? (
                <p class="page-toolbar-summary muted mono">
                  Workspace: {pageData.workspaceFilterId}
                </p>
              )
              : null}
            <p class="page-toolbar-summary muted mono">{countSummary}</p>
          </div>
          <div class="page-actions">
            <a
              class={pageData.includeStale
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildIngestionHref({
                includeStale: true,
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              All Sessions
            </a>
            <a
              class={!pageData.includeStale
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildIngestionHref({
                includeStale: false,
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              Active Only
            </a>
            {pageData.workspaceFilter
              ? (
                <a
                  class="secondary-button"
                  href={buildIngestionHref({
                    includeStale: pageData.includeStale,
                  })}
                >
                  Clear Workspace Filter
                </a>
              )
              : null}
          </div>
        </div>

        <ul class="session-activity-list">
          {rows.length === 0
            ? <li class="muted">No sessions match the current filters.</li>
            : rows.map((row) => (
              <li
                key={row.sessionKey}
                class="session-activity-row"
                id={`session-${row.sessionId}`}
              >
                <div class="session-activity-top">
                  <div class="session-activity-copy">
                    <div class="mono session-activity-title">
                      <span
                        class={`activity-state-dot ${row.state}`}
                        aria-hidden="true"
                      >
                        {activityStateDot(row.state)}
                      </span>{" "}
                      {row.provider}:{" "}
                      <strong class="session-activity-snippet">
                        {row.snippet ?? "(no snippet)"}
                      </strong>{" "}
                      ({row.sessionShortId})
                    </div>
                  </div>
                  <div class="session-activity-meta">
                    <div class={`mono activity-state-text ${row.state}`}>
                      {activityStateLabel(row.state)}
                    </div>
                  </div>
                </div>

                <div class="muted session-activity-details">
                  Updated {formatTimestamp(row.updatedAt)} · Last event{" "}
                  {formatTimestamp(row.lastEventAt)}
                </div>

                <ul class="recording-list">
                  {row.recordings.length === 0
                    ? (
                      <li class="muted">
                        No recordings associated with this session.
                      </li>
                    )
                    : row.recordings.map((recording) => {
                      const uiState = recordingState(recording.state);
                      const workspaceLabel = recording.workspaceAlias ??
                        recording.workspaceId ??
                        "workspace";
                      return (
                        <li key={recording.key} class="recording-row">
                          <div class="recording-row-top">
                            <div class="mono recording-state-line">
                              <span
                                class={`activity-state-dot ${uiState}`}
                                aria-hidden="true"
                              >
                                {activityStateDot(uiState)}
                              </span>
                              <a
                                class="recording-primary-link"
                                href={recording.workspaceHref}
                              >
                                {workspaceLabel}
                              </a>
                              <span>:</span>
                              <span>{recording.displayOutputPath}</span>
                            </div>
                          </div>
                          <div class="muted">
                            {recordingActivityStateLabel(uiState)} · Started
                            {" "}
                            {formatTimestamp(recording.startedAt)}
                            {uiState === "inactive"
                              ? ` · Stopped ${
                                formatTimestamp(recording.stoppedAt)
                              }`
                              : ` · Last write ${
                                formatTimestamp(recording.lastWriteAt)
                              }`}
                          </div>
                        </li>
                      );
                    })}
                </ul>
              </li>
            ))}
        </ul>
      </article>
    </section>
  );
}
