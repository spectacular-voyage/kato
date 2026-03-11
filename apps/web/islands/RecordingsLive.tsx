import {
  type ActivityState,
  activityStateDot,
  recordingActivityStateLabel,
} from "../src/loaders/activity_state.ts";
import type {
  RecordingsPageData,
  RecordingStateFilter,
} from "../src/loaders/recordings.ts";
import { formatTimestamp } from "../src/time.ts";
import SessionSnippet from "./SessionSnippet.tsx";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

function buildRecordingsHref(
  options: {
    stateFilter: RecordingStateFilter;
    workspaceFilter?: string;
  },
): string {
  const url = new URL("http://kato.local/recordings");
  if (options.stateFilter !== "all") {
    url.searchParams.set("state", options.stateFilter);
  }
  if (options.workspaceFilter) {
    url.searchParams.set("workspace", options.workspaceFilter);
  }
  return `${url.pathname}${url.search}`;
}

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

export default function RecordingsLive(
  props: { initialData: RecordingsPageData; endpoint: string },
) {
  const pageData = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  const workspaceLabel = pageData.workspaceFilterAlias ??
    pageData.workspaceFilterId;

  return (
    <section class="grid">
      <article class="card span-12">
        <div class="page-toolbar">
          <div>
            <h2>
              {workspaceLabel
                ? `Recordings for ${workspaceLabel}`
                : "Recordings"}
            </h2>
            {pageData.workspaceFilterId
              ? (
                <p class="page-toolbar-summary muted mono">
                  Workspace: {pageData.workspaceFilterId}
                </p>
              )
              : null}
            <p class="page-toolbar-summary muted mono">
              Active: {pageData.activeRecordingCount}, Idle:{" "}
              {pageData.staleRecordingCount}, Stopped:{" "}
              {pageData.stoppedRecordingCount}
            </p>
          </div>
          <div class="page-actions">
            <a
              class={pageData.stateFilter === "all"
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildRecordingsHref({
                stateFilter: "all",
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              All States
            </a>
            <a
              class={pageData.stateFilter === "engaged-active"
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildRecordingsHref({
                stateFilter: "engaged-active",
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              Active
            </a>
            <a
              class={pageData.stateFilter === "engaged-stale"
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildRecordingsHref({
                stateFilter: "engaged-stale",
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              Idle
            </a>
            <a
              class={pageData.stateFilter === "stopped"
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildRecordingsHref({
                stateFilter: "stopped",
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              Stopped
            </a>
            {pageData.workspaceFilter
              ? (
                <a
                  class="secondary-button"
                  href={buildRecordingsHref({
                    stateFilter: pageData.stateFilter,
                  })}
                >
                  Clear Workspace Filter
                </a>
              )
              : null}
          </div>
        </div>

        <ul class="session-activity-list">
          {pageData.rows.length === 0
            ? <li class="muted">No recordings match the current filters.</li>
            : pageData.rows.map((row) => {
              const uiState = recordingState(row.state);
              const rowWorkspaceLabel = row.workspaceAlias ??
                row.workspaceId ??
                "workspace";
              return (
                <li key={row.key} class="session-activity-row">
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
                        href={row.workspaceHref}
                      >
                        {rowWorkspaceLabel}
                      </a>
                      <span>:</span>
                      <span>{row.displayOutputPath}</span>
                    </div>
                    <div class={`mono activity-state-text ${uiState}`}>
                      {recordingActivityStateLabel(uiState)}
                    </div>
                  </div>
                  <div>
                    <a
                      class="workspace-session-link"
                      href={row.sessionHref}
                    >
                      {row.provider}: {row.sessionShortId}
                    </a>{" "}
                    ·{" "}
                    <SessionSnippet
                      sessionId={row.sessionId}
                      snippet={row.snippet}
                    />
                  </div>
                  <div class="muted">
                    Started {formatTimestamp(row.startedAt)}
                    {uiState === "inactive"
                      ? ` · Stopped ${formatTimestamp(row.stoppedAt)}`
                      : ` · Last write ${formatTimestamp(row.lastWriteAt)}`}
                  </div>
                </li>
              );
            })}
        </ul>
      </article>
    </section>
  );
}
