import {
  activityStateDot,
  activityStateLabel,
} from "../src/loaders/activity_state.ts";
import type {
  SessionActivityRow,
  SessionIngestionAction,
  SessionsPageData,
} from "../src/loaders/sessions.ts";
import {
  buildIngestionSessionHref,
  buildSessionInventoryHref,
} from "../src/session_routes.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

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

function buildSessionListStateLabel(row: SessionActivityRow): string {
  if (row.state !== "inactive") {
    return activityStateLabel(row.state);
  }
  switch (row.ingestionAction) {
    case "start":
      return "not ingested";
    case "continue":
      return "continue ingestion";
    case "none":
      return row.canOpenIngestView ? "idle" : "not ingested";
  }
}

function ingestionActionLabel(action: SessionIngestionAction): string {
  switch (action) {
    case "start":
      return "start ingestion";
    case "continue":
      return "continue ingestion";
    case "none":
      return "";
  }
}

function buildPageTitle(
  workspaceAlias: string | undefined,
  workspaceId: string | undefined,
): string {
  const workspaceLabel = workspaceAlias ?? workspaceId;
  return workspaceLabel ? `Sessions for ${workspaceLabel}` : "Sessions";
}

function buildCountSummary(options: {
  includeStale: boolean;
  activeSessionCount: number;
  staleSessionCount: number;
  inactiveSessionCount: number;
}): string {
  if (!options.includeStale) {
    return `Active: ${options.activeSessionCount}`;
  }
  return `Active: ${options.activeSessionCount}, Idle: ${options.staleSessionCount}, Not ingested: ${options.inactiveSessionCount}`;
}

export default function SessionsLive(
  props: {
    initialData: SessionsPageData;
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
  const countSummary = buildCountSummary({
    includeStale: pageData.includeStale,
    activeSessionCount: pageData.activeSessionCount,
    staleSessionCount: pageData.staleSessionCount,
    inactiveSessionCount: pageData.inactiveSessionCount,
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
              href={buildSessionInventoryHref({
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
              href={buildSessionInventoryHref({
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
                  href={buildSessionInventoryHref({
                    includeStale: pageData.includeStale,
                  })}
                >
                  Clear Workspace Filter
                </a>
              )
              : null}
          </div>
        </div>

        <ul class="session-list-rows">
          {pageData.rows.length === 0
            ? <li class="muted">No sessions match the current filters.</li>
            : pageData.rows.map((row) => (
              <li
                key={row.sessionKey}
                class={`session-list-row ${row.state}`}
              >
                <div class="session-list-action">
                  <span
                    class={`activity-state-dot session-list-dot ${row.state}`}
                    aria-label={buildSessionListStateLabel(row)}
                    title={buildSessionListStateLabel(row)}
                  >
                    {activityStateDot(row.state)}
                  </span>
                </div>
                {!row.canOpenIngestView
                  ? (
                    <span class="session-list-copy">
                      <span class="session-list-primary">
                        <span class="mono">{row.provider}:</span>{" "}
                        <strong>{row.snippet ?? "(no snippet)"}</strong>{" "}
                        <span class="mono">({row.sessionShortId})</span>
                      </span>{" "}
                      <span class="muted mono session-list-updated">
                        Updated {formatTimestamp(row.updatedAt)}
                      </span>
                    </span>
                  )
                  : (
                    <a
                      class="session-list-link"
                      href={buildIngestionSessionHref(row.sessionId, {
                        includeStale: pageData.includeStale,
                        workspaceFilter: pageData.workspaceFilter,
                      })}
                    >
                      <span class="session-list-copy">
                        <span class="session-list-primary">
                          <span class="mono">{row.provider}:</span>{" "}
                          <strong>{row.snippet ?? "(no snippet)"}</strong>{" "}
                          <span class="mono">({row.sessionShortId})</span>
                        </span>{" "}
                        <span class="muted mono session-list-updated">
                          Updated {formatTimestamp(row.updatedAt)}
                        </span>
                      </span>
                    </a>
                  )}
                <div class="session-list-right">
                  {row.ingestionAction !== "none"
                    ? (
                      <form
                        method="post"
                        class="session-list-action-form"
                      >
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
                          {ingestionActionLabel(row.ingestionAction)}
                        </button>
                      </form>
                    )
                    : null}
                </div>
              </li>
            ))}
        </ul>
      </article>
    </section>
  );
}
