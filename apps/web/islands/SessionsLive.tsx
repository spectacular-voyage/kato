import { activityStateDot, activityStateLabel } from "../src/activity_state.ts";
import type {
  SessionActivityRow,
  SessionsPageData,
} from "../src/loaders/sessions.ts";
import { buildSessionInventoryHref } from "../src/session_routes.ts";
import { TimestampText } from "../src/TimestampText.tsx";
import SessionSnippet from "./SessionSnippet.tsx";
import { useBrowserTimeZone } from "./use_browser_time_zone.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

function buildSessionListStateLabel(row: SessionActivityRow): string {
  return activityStateLabel(row.state);
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
  return `Active: ${options.activeSessionCount}, Idle: ${options.staleSessionCount}, Inactive: ${options.inactiveSessionCount}`;
}

export default function SessionsLive(
  props: {
    initialData: SessionsPageData;
    endpoint: string;
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
  const timeZone = useBrowserTimeZone();

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
                id={`session-${row.sessionId}`}
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
                <span class="session-list-copy">
                  <span class="session-list-primary">
                    <span class="mono">{row.provider}:</span>{" "}
                    <SessionSnippet
                      sessionId={row.sessionId}
                      snippet={row.snippet}
                      snippetClass="session-list-snippet"
                    />{" "}
                    <span class="mono">({row.sessionShortId})</span>
                  </span>{" "}
                  <span class="muted mono session-list-updated">
                    Updated{" "}
                    <TimestampText value={row.updatedAt} timeZone={timeZone} />
                  </span>
                </span>
                <div class="session-list-right" />
              </li>
            ))}
        </ul>
      </article>
    </section>
  );
}
