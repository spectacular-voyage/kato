import {
  type ActivityState,
  activityStateDot,
} from "../src/loaders/activity_state.ts";
import type { WorkspacesPageData } from "../src/loaders/workspaces.ts";
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

function workspaceShortId(workspaceId: string): string {
  return workspaceId.slice(0, 8);
}

export default function WorkspacesLive(
  props: {
    initialData: WorkspacesPageData;
    endpoint: string;
    csrfToken?: string;
  },
) {
  const pageData = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });

  return (
    <section class="grid">
      <article class="card span-12">
        <h2>Registered Workspaces</h2>
        {pageData.workspaceSummary.unavailableReason
          ? (
            <p class="danger">
              {pageData.workspaceSummary.unavailableReason}
            </p>
          )
          : (
            <ul class="workspace-list">
              {pageData.rows.length === 0
                ? <li class="muted">No workspaces registered.</li>
                : pageData.rows.map((row) => (
                  <li
                    key={row.workspaceId}
                    class="workspace-row"
                    id={`workspace-${row.workspaceId}`}
                  >
                    <div class="workspace-row-header">
                      <div class="workspace-row-main">
                        <div class="workspace-row-title">{row.alias}</div>
                        <div class="muted mono workspace-row-id">
                          {workspaceShortId(row.workspaceId)}
                        </div>
                        <div class="muted mono">{row.workspaceRoot}</div>
                        <div class="workspace-health-row">
                          <span class={row.valid ? "ok mono" : "danger mono"}>
                            {row.valid
                              ? "config valid"
                              : row.invalidReason ?? "invalid"}
                          </span>
                          <span
                            class={row.writePathCovered === false
                              ? "danger mono"
                              : "muted mono"}
                          >
                            {row.writePathCovered === undefined
                              ? "write coverage unavailable"
                              : row.writePathCovered
                              ? "write root covered"
                              : "write root not covered"}
                          </span>
                        </div>
                        {row.workspaceUsername
                          ? (
                            <div class="muted mono">
                              workspace username: {row.workspaceUsername}
                            </div>
                          )
                          : null}
                      </div>
                      <div class="workspace-row-actions">
                        <a
                          class="secondary-button"
                          href={buildIngestionHref({
                            workspaceFilter: row.workspaceId,
                          })}
                        >
                          View Ingestion
                        </a>
                        <a
                          class="secondary-button"
                          href={`/recordings?workspace=${
                            encodeURIComponent(row.workspaceId)
                          }`}
                        >
                          View Recordings
                        </a>
                        <form method="post">
                          <input
                            type="hidden"
                            name="action"
                            value="unregister"
                          />
                          <input
                            type="hidden"
                            name="csrfToken"
                            value={props.csrfToken ?? ""}
                          />
                          <input
                            type="hidden"
                            name="selector"
                            value={row.workspaceId}
                          />
                          <button
                            class="secondary-button danger-button"
                            type="submit"
                          >
                            Unregister
                          </button>
                        </form>
                      </div>
                    </div>

                    <details class="workspace-recordings-toggle">
                      <summary class="workspace-recording-summary mono">
                        recordings: {row.activeRecordingCount} active ·{" "}
                        {row.staleRecordingCount} idle ·{" "}
                        {row.stoppedRecordingCount} stopped
                      </summary>
                      <div class="muted workspace-recording-note">
                        {row.latestRecordingAt
                          ? `Latest recording activity ${
                            formatTimestamp(row.latestRecordingAt)
                          }`
                          : "No recordings associated with this workspace yet."}
                      </div>
                      {row.recordings.length > 0
                        ? (
                          <ul class="recording-list workspace-recordings">
                            {row.recordings.map((recording) => {
                              const uiState = recordingState(recording.state);
                              return (
                                <li
                                  key={recording.key}
                                  class="recording-row"
                                >
                                  <div class="recording-row-top">
                                    <a
                                      class="mono workspace-session-link"
                                      href={recording.sessionLink}
                                    >
                                      <span
                                        class={`activity-state-dot ${uiState}`}
                                        aria-hidden="true"
                                      >
                                        {activityStateDot(uiState)}
                                      </span>{" "}
                                      {recording.snippet ?? "(no snippet)"}
                                    </a>
                                    <span class="muted mono">
                                      {recording.provider}:{" "}
                                      {recording.sessionShortId}
                                    </span>
                                  </div>
                                  <div class="mono recording-path">
                                    {recording.displayOutputPath}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )
                        : null}
                    </details>
                  </li>
                ))}
            </ul>
          )}
      </article>

      <article class="card span-12">
        <h2>Write Root Coverage</h2>
        {pageData.sharedConfigError
          ? <p class="danger">{pageData.sharedConfigError}</p>
          : (
            <>
              <p class="muted">
                Registered workspaces are checked against shared{" "}
                <code>allowedWriteRoots</code>.
              </p>
              <ul class="provider-list">
                {pageData.allowedWriteRoots.length === 0
                  ? <li class="muted">No shared write roots configured.</li>
                  : pageData.allowedWriteRoots.map((root) => (
                    <li key={root} class="mono">{root}</li>
                  ))}
              </ul>
            </>
          )}
      </article>
    </section>
  );
}
