import { Head } from "fresh/runtime";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { loadSessionsPageData } from "../src/loaders/sessions.ts";
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

function buildSessionsHref(
  options: { includeStale: boolean; workspaceFilter?: string },
): string {
  const url = new URL("http://kato.local/sessions");
  if (!options.includeStale) {
    url.searchParams.set("view", "active");
  }
  if (options.workspaceFilter) {
    url.searchParams.set("workspace", options.workspaceFilter);
  }
  return `${url.pathname}${url.search}`;
}

export default define.page(async function SessionsPage(ctx) {
  const includeStale = ctx.url.searchParams.get("view") !== "active";
  const workspaceFilter = ctx.url.searchParams.get("workspace")?.trim() ||
    undefined;
  const [pageData, appStatus] = await Promise.all([
    loadSessionsPageData({
      includeStale,
      workspaceFilter,
    }),
    loadAppChromeStatus(),
  ]);

  return (
    <>
      <Head>
        <title>Kato Web · Sessions</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Sessions"
          description="Integrated session and recording view built from the live snapshot plus persistent session metadata."
          currentPath="/sessions"
          showLogout
          appStatus={appStatus}
        />

        <section class="grid">
          <article class="card span-12">
            <div class="page-toolbar">
              <div>
                <h2>Session Activity</h2>
                <p class="page-toolbar-summary muted mono">
                  Active: {pageData.activeSessionCount}, Stale:{" "}
                  {pageData.staleSessionCount}
                  {pageData.workspaceFilter
                    ? ` · Workspace: ${pageData.workspaceFilter}`
                    : ""}
                </p>
              </div>
              <div class="page-actions">
                <a
                  class={pageData.includeStale
                    ? "secondary-button current-filter"
                    : "secondary-button"}
                  href={buildSessionsHref({
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
                  href={buildSessionsHref({
                    includeStale: false,
                    workspaceFilter: pageData.workspaceFilter,
                  })}
                >
                  Active Only
                </a>
                {pageData.workspaceFilter
                  ? (
                    <a class="secondary-button" href="/sessions">
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
                    No sessions match the current filters.
                  </li>
                )
                : pageData.rows.map((row) => (
                  <li
                    key={row.sessionKey}
                    class="session-activity-row"
                    id={`session-${row.sessionId}`}
                  >
                    <div class="session-activity-top">
                      <div class="session-activity-copy">
                        <div class="mono session-activity-title">
                          {row.stale ? "○" : "●"} {row.provider}:{" "}
                          <strong class="session-activity-snippet">
                            {row.snippet ?? "(no snippet)"}
                          </strong>{" "}
                          ({row.sessionShortId})
                        </div>
                      </div>
                      <div class="session-activity-meta">
                        <div class={row.stale ? "stale mono" : "ok mono"}>
                          {row.stale ? "stale" : "active"}
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
                        : row.recordings.map((recording) => (
                          <li key={recording.key} class="recording-row">
                            <div class="recording-row-top">
                              <div class="mono recording-state-line">
                                <span
                                  class={`recording-state-dot ${recording.status}`}
                                  aria-hidden="true"
                                >
                                  {recording.status === "active" ? "●" : "○"}
                                </span>
                                <span>
                                  {recording.status === "active"
                                    ? "recording active"
                                    : "recording stopped"}
                                </span>
                              </div>
                              <div class="muted mono">
                                workspace: {recording.workspaceAlias ??
                                  recording.workspaceId ??
                                  "unresolved"}
                              </div>
                            </div>
                            <div class="mono recording-path">
                              {recording.outputPath}
                            </div>
                            <div class="muted">
                              Started {formatTimestamp(recording.startedAt)}
                              {recording.status === "active"
                                ? ` · Last write ${
                                  formatTimestamp(recording.lastWriteAt)
                                }`
                                : ` · Stopped ${
                                  formatTimestamp(recording.stoppedAt)
                                }`}
                            </div>
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
            </ul>
          </article>
        </section>
      </div>
    </>
  );
});
