import { formatWorkspaceLabel } from "@kato/shared";
import { type ActivityState, activityStateDot } from "../src/activity_state.ts";
import type { RecordingsPageData } from "../src/loaders/recordings.ts";
import {
  canRestartSessionRecording,
  canStopSessionRecording,
  recordingsPageStaleFilterLabel,
  recordingsPageStateLabel,
  recordingsPageStopActionLabel,
} from "../src/session_recording_view_model.ts";
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
  props: {
    initialData: RecordingsPageData;
    endpoint: string;
    csrfToken?: string;
  },
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

  function RecordingsPageActionFields(
    actionProps: {
      sessionId: string;
      recordingCycleId?: string;
      rowKey: string;
      workspaceId?: string;
      outputPath: string;
    },
  ) {
    return (
      <>
        <input type="hidden" name="sessionId" value={actionProps.sessionId} />
        <input
          type="hidden"
          name="stateFilter"
          value={pageData.stateFilter}
        />
        <input
          type="hidden"
          name="workspaceFilter"
          value={pageData.workspaceFilter ?? ""}
        />
        <input
          type="hidden"
          name="recordingCycleId"
          value={actionProps.recordingCycleId ?? ""}
        />
        <input type="hidden" name="rowKey" value={actionProps.rowKey} />
        <input
          type="hidden"
          name="workspaceId"
          value={actionProps.workspaceId ?? ""}
        />
        <input
          type="hidden"
          name="outputPath"
          value={actionProps.outputPath}
        />
        <input
          type="hidden"
          name="csrfToken"
          value={props.csrfToken ?? ""}
        />
      </>
    );
  }

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
              Recording: {pageData.activeRecordingCount},{" "}
              {recordingsPageStaleFilterLabel()}:{" "}
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
              {recordingsPageStaleFilterLabel()}
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
              const stopActionLabel = recordingsPageStopActionLabel(row.state);
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
                    <div class="recording-row-copy">
                      <div class="mono muted recording-file-line">
                        <span class="recording-detail-label">File:</span>{" "}
                        <span class="recording-file-path">
                          {row.displayOutputPath}
                        </span>
                      </div>
                      <div class="muted recording-detail-line recording-timestamps-line">
                        Started{" "}
                        <TimestampText
                          value={row.startedAt}
                          timeZone={timeZone}
                        />
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
                      <div class="recording-detail-line">
                        <span class="mono recording-detail-label">
                          Workspace:
                        </span>{" "}
                        <span class="mono recording-state-line">
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
                        </span>
                      </div>
                      <div class="recording-detail-line session-list-primary">
                        <span class="mono recording-detail-label">
                          Session:
                        </span>{" "}
                        <span class="mono">{row.provider}:</span>{" "}
                        <SessionSnippet
                          sessionId={row.sessionId}
                          snippet={row.snippet}
                          snippetClass="session-list-snippet recording-session-link"
                          title={`Session ${row.sessionShortId}`}
                          href={row.sessionHref}
                        />{" "}
                        <a
                          class="workspace-session-link mono"
                          href={row.sessionHref}
                        >
                          ({row.sessionShortId})
                        </a>
                      </div>
                    </div>
                    <div class="session-activity-meta recording-row-meta">
                      <div
                        class={`mono activity-state-text recording-row-state ${uiState}`}
                      >
                        {recordingsPageStateLabel(uiState)}
                      </div>
                      {row.state !== "stopped" &&
                          canStopSessionRecording(row)
                        ? (
                          <form
                            method="post"
                            class="session-list-action-form session-inline-action-form"
                          >
                            <RecordingsPageActionFields
                              sessionId={row.sessionId}
                              recordingCycleId={row.recordingCycleId}
                              rowKey={row.key}
                              workspaceId={row.workspaceId}
                              outputPath={row.outputPath}
                            />
                            <input
                              type="hidden"
                              name="action"
                              value="stop-recording"
                            />
                            <button
                              class="session-inline-action session-inline-action-danger mono"
                              type="submit"
                            >
                              [{stopActionLabel}]
                            </button>
                          </form>
                        )
                        : null}
                      {canRestartSessionRecording(row)
                        ? (
                          <form
                            method="post"
                            class="session-list-action-form session-inline-action-form"
                          >
                            <RecordingsPageActionFields
                              sessionId={row.sessionId}
                              recordingCycleId={row.recordingCycleId}
                              rowKey={row.key}
                              workspaceId={row.workspaceId}
                              outputPath={row.outputPath}
                            />
                            <input
                              type="hidden"
                              name="action"
                              value="restart-recording"
                            />
                            <button
                              class="session-inline-action mono"
                              type="submit"
                            >
                              [re-arm]
                            </button>
                          </form>
                        )
                        : null}
                    </div>
                  </div>
                </li>
              );
            })}
        </ul>
      </article>
    </section>
  );
}
