import type {
  MaintenanceTwinAction,
  MaintenanceTwinRow,
  MaintenanceTwinsData,
} from "../src/loaders/maintenance_twins.ts";
import { buildMaintenanceHref } from "../src/session_routes.ts";
import { formatTimestamp } from "../src/time.ts";
import SessionSnippet from "./SessionSnippet.tsx";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

interface MaintenanceTwinsLiveProps {
  initialData: MaintenanceTwinsData;
  endpoint: string;
  csrfToken?: string;
  twinsDays: number;
  deleteTwinMetadata: boolean;
}

function twinStateLabel(row: MaintenanceTwinRow): string {
  switch (row.twinState) {
    case "current":
      return "current";
    case "behind":
      return "behind source";
    case "absent":
      return "no twin";
  }
}

function twinActionLabel(action: MaintenanceTwinAction): string {
  switch (action) {
    case "create":
      return "create twin";
    case "update":
      return "update twin";
    case "none":
      return "";
  }
}

function buildPageTitle(
  workspaceAlias: string | undefined,
  workspaceId: string | undefined,
): string {
  const workspaceLabel = workspaceAlias ?? workspaceId;
  return workspaceLabel
    ? `Twin Maintenance for ${workspaceLabel}`
    : "Twin Maintenance";
}

function TrashIcon() {
  return (
    <svg
      class="maintenance-twin-delete-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export default function MaintenanceTwinsLive(props: MaintenanceTwinsLiveProps) {
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
    <article class="card span-12">
      <div class="page-toolbar">
        <div>
          <h2>{heading}</h2>
          <p class="muted">
            Inspect persisted twin freshness, rebuild outdated twins, and remove
            stale persisted history without touching provider source files.
          </p>
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
            href={buildMaintenanceHref({
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
            href={buildMaintenanceHref({
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
                href={buildMaintenanceHref({
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
              <div class="maintenance-twin-row-top">
                <div class="session-activity-copy">
                  <div class="mono session-activity-title">
                    {row.provider}:{" "}
                    <SessionSnippet
                      sessionId={row.sessionId}
                      snippet={row.snippet}
                      snippetClass="session-activity-snippet"
                    />{" "}
                    ({row.sessionShortId})
                  </div>
                </div>
                <div class="maintenance-twin-actions">
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
                  {row.twinAction !== "none"
                    ? (
                      <form method="post" class="session-list-action-form">
                        <input
                          type="hidden"
                          name="action"
                          value="twin-ingest"
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
                        <input
                          type="hidden"
                          name="twinsDays"
                          value={String(props.twinsDays)}
                        />
                        {props.deleteTwinMetadata
                          ? (
                            <input
                              type="hidden"
                              name="deleteTwinMetadata"
                              value="on"
                            />
                          )
                          : null}
                        <button
                          type="submit"
                          class="mono session-inline-action"
                        >
                          {twinActionLabel(row.twinAction)}
                        </button>
                      </form>
                    )
                    : null}
                  {row.twinPresent
                    ? (
                      <form method="post" class="session-list-action-form">
                        <input
                          type="hidden"
                          name="action"
                          value="twin-delete"
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
                        <input
                          type="hidden"
                          name="twinsDays"
                          value={String(props.twinsDays)}
                        />
                        {props.deleteTwinMetadata
                          ? (
                            <input
                              type="hidden"
                              name="deleteTwinMetadata"
                              value="on"
                            />
                          )
                          : null}
                        <button
                          type="submit"
                          class="maintenance-twin-delete-button"
                          title="delete twin"
                          aria-label={`delete twin for ${row.provider} ${row.sessionShortId}`}
                        >
                          <TrashIcon />
                        </button>
                      </form>
                    )
                    : null}
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
                Live state: {row.state} · Recordings {row.activeRecordingCount}
                {" "}
                active / {row.staleRecordingCount} idle /{" "}
                {row.stoppedRecordingCount} stopped
              </div>
            </li>
          ))}
      </ul>
    </article>
  );
}
