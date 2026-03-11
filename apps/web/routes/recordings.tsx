import { Head } from "fresh/runtime";
import AppHeader from "../src/app_header.tsx";
import {
  type ActivityState,
  activityStateDot,
  recordingActivityStateLabel,
} from "../src/loaders/activity_state.ts";
import {
  loadRecordingsPageData,
  type RecordingStateFilter,
} from "../src/loaders/recordings.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { define } from "../utils.ts";

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function parseStateFilter(value: string | null): RecordingStateFilter {
  return value === "engaged-active" || value === "engaged-stale" ||
      value === "stopped"
    ? value
    : "all";
}

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

export default define.page(async function RecordingsPage(ctx) {
  const workspaceFilter = ctx.url.searchParams.get("workspace")?.trim() ||
    undefined;
  const stateFilter = parseStateFilter(ctx.url.searchParams.get("state"));
  const [pageData, appStatus] = await Promise.all([
    loadRecordingsPageData({
      workspaceFilter,
      stateFilter,
    }),
    loadAppChromeStatus(),
  ]);
  const workspaceLabel = pageData.workspaceFilterAlias ??
    pageData.workspaceFilterId;

  return (
    <>
      <Head>
        <title>Kato Web · Recordings</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Recordings"
          description="Full recording history and live recording status across all discovered sessions."
          currentPath="/recordings"
          showLogout
          appStatus={appStatus}
        />

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
                    <a class="secondary-button" href="/recordings">
                      Clear Workspace Filter
                    </a>
                  )
                  : null}
              </div>
            </div>

            <ul class="session-activity-list">
              {pageData.rows.length === 0
                ? (
                  <li class="muted">
                    No recordings match the current filters.
                  </li>
                )
                : pageData.rows.map((row) => {
                  const uiState = recordingState(row.state);
                  const workspaceLabel = row.workspaceAlias ??
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
                            {workspaceLabel}
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
                        {row.snippet ? `· ${row.snippet}` : ""}
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
      </div>
    </>
  );
});
