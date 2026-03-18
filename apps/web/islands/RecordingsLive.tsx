import { formatWorkspaceLabel } from "@kato/shared";
import {
  type ActivityState,
  activityStateDot,
  recordingActivityStateLabel,
} from "../src/activity_state.ts";
import type { RecordingsPageData } from "../src/loaders/recordings.ts";
import {
  buildRecordingRowAnchorId,
  buildRecordingsHref,
} from "../src/session_routes.ts";
import { TimestampText } from "../src/TimestampText.tsx";
import SessionSnippet from "./SessionSnippet.tsx";
import { useBrowserTimeZone } from "./use_browser_time_zone.ts";
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

export default function RecordingsLive(
  props: { initialData: RecordingsPageData; endpoint: string },
) {
  const pageData = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  const timeZone = useBrowserTimeZone();
  const workspaceLabel = pageData.workspaceFilterAlias
    ? formatWorkspaceLabel(
      pageData.workspaceFilterAlias,
      pageData.workspaceFilterDisplayName,
    )
    : pageData.workspaceFilterId;

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
              Recording: {pageData.activeRecordingCount}, Ready to record:{" "}
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
              Recording
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
              Ready to record
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

        <hr class="sessions-header-divider" />

        <ul class="session-activity-list">
          {pageData.rows.length === 0
            ? <li class="muted">No recordings match the current filters.</li>
            : pageData.rows.map((row) => {
              const uiState = recordingState(row.state);
              const rowWorkspaceLabel = row.workspaceAlias
                ? formatWorkspaceLabel(
                  row.workspaceAlias,
                  row.workspaceDisplayName,
                )
                : row.workspaceId ?? "workspace";
              return (
                <li
                  key={row.key}
                  class="session-activity-row"
                  id={buildRecordingRowAnchorId({
                    recordingCycleId: row.recordingCycleId,
                    rowKey: row.key,
                  })}
                >
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
                  <div class="session-list-primary">
                    <span class="mono">{row.provider}:</span>{" "}
                    <SessionSnippet
                      sessionId={row.sessionId}
                      snippet={row.snippet}
                      snippetClass="session-list-snippet"
                    />{" "}
                    <a
                      class="workspace-session-link mono"
                      href={row.sessionHref}
                    >
                      ({row.sessionShortId})
                    </a>
                  </div>
                  <div class="muted">
                    Started{" "}
                    <TimestampText value={row.startedAt} timeZone={timeZone} />
                    {uiState === "inactive"
                      ? (
                        <>
                          {" · "}Stopped{" "}
                          <TimestampText
                            value={row.stoppedAt}
                            timeZone={timeZone}
                          />
                        </>
                      )
                      : (
                        <>
                          {" · "}Last write{" "}
                          <TimestampText
                            value={row.lastWriteAt}
                            timeZone={timeZone}
                          />
                        </>
                      )}
                  </div>
                </li>
              );
            })}
        </ul>
      </article>
    </section>
  );
}
