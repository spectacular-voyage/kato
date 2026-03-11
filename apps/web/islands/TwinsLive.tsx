import { type SessionIngestionAction } from "../src/loaders/sessions.ts";
import type { TwinActivityRow, TwinsPageData } from "../src/loaders/twins.ts";
import { buildTwinInventoryHref } from "../src/session_routes.ts";
import { formatTimestamp } from "../src/time.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

function ingestionActionLabel(action: SessionIngestionAction): string {
  switch (action) {
    case "start":
      return "create twin";
    case "continue":
      return "update twin";
    case "none":
      return "";
  }
}

function twinStateLabel(row: TwinActivityRow): string {
  switch (row.twinState) {
    case "current":
      return "current";
    case "behind":
      return "behind source";
    case "absent":
      return "no twin";
  }
}

function buildPageTitle(
  workspaceAlias: string | undefined,
  workspaceId: string | undefined,
): string {
  const workspaceLabel = workspaceAlias ?? workspaceId;
  return workspaceLabel ? `Twins for ${workspaceLabel}` : "Twins";
}

export default function TwinsLive(
  props: {
    initialData: TwinsPageData;
    endpoint: string;
    csrfToken?: string;
  },
) {
  const pageData = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  const heading = buildPageTitle(
    pageData.workspaceFilterAlias,
    pageData.workspaceFilterId,
  );

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
            <p class="page-toolbar-summary muted mono">
              Current: {pageData.currentTwinCount}, Behind:{" "}
              {pageData.behindTwinCount}, No twin: {pageData.absentTwinCount}
            </p>
          </div>
          <div class="page-actions">
            <a
              class={pageData.includeStale
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildTwinInventoryHref({
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
              href={buildTwinInventoryHref({
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
                  href={buildTwinInventoryHref({
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
          {pageData.rows.length === 0
            ? <li class="muted">No sessions match the current filters.</li>
            : pageData.rows.map((row) => (
              <li
                key={row.sessionKey}
                class="session-activity-row"
                id={`session-${row.sessionId}`}
              >
                <div class="session-activity-top">
                  <div class="session-activity-copy">
                    <div class="mono session-activity-title">
                      {row.provider}:{" "}
                      <strong class="session-activity-snippet">
                        {row.snippet ?? "(no snippet)"}
                      </strong>{" "}
                      ({row.sessionShortId})
                    </div>
                  </div>
                  <div class="session-activity-meta">
                    <div
                      class={`mono activity-state-text ${
                        row.twinState === "current"
                          ? "active"
                          : row.twinState === "behind"
                          ? "stale"
                          : "inactive"
                      }`}
                    >
                      {twinStateLabel(row)}
                    </div>
                  </div>
                </div>

                <div class="muted session-activity-details">
                  Updated {formatTimestamp(row.updatedAt)} · Last event{" "}
                  {formatTimestamp(row.lastEventAt)}
                </div>
                <div class="muted session-activity-details mono">
                  Twin: {row.twinPath}
                </div>
                <div class="muted session-activity-details mono">
                  Source: {row.sourceFilePath}
                </div>
                <div class="muted session-activity-details">
                  Live state: {row.state} · Recordings{" "}
                  {row.activeRecordingCount} active / {row.staleRecordingCount}
                  {" "}
                  idle / {row.stoppedRecordingCount} stopped
                </div>

                {row.twinAction !== "none"
                  ? (
                    <form method="post" class="session-list-action-form">
                      <input
                        type="hidden"
                        name="action"
                        value="start-ingestion"
                      />
                      <input
                        type="hidden"
                        name="csrfToken"
                        value={props.csrfToken ?? ""}
                      />
                      <input
                        type="hidden"
                        name="sessionId"
                        value={row.sessionId}
                      />
                      <input
                        type="hidden"
                        name="includeStale"
                        value={String(pageData.includeStale)}
                      />
                      <input
                        type="hidden"
                        name="workspaceFilter"
                        value={pageData.workspaceFilter ?? ""}
                      />
                      <button
                        type="submit"
                        class="mono session-inline-action"
                      >
                        {ingestionActionLabel(row.twinAction)}
                      </button>
                    </form>
                  )
                  : null}
              </li>
            ))}
        </ul>
      </article>
    </section>
  );
}
