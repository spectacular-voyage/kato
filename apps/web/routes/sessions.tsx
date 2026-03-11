import { Head } from "fresh/runtime";
import AppHeader from "../src/app_header.tsx";
import {
  activityStateDot,
  activityStateLabel,
} from "../src/loaders/activity_state.ts";
import { ingestPersistedSession } from "../src/session_ingestion.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import {
  loadSessionsPageData,
  type SessionActivityRow,
  type SessionIngestionAction,
  type SessionsPageData,
} from "../src/loaders/sessions.ts";
import { createWebLoggers } from "../src/logging.ts";
import {
  buildIngestionSessionHref,
  buildSessionInventoryHref,
} from "../src/session_routes.ts";
import { define } from "../utils.ts";

function decodeMessage(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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

async function loadSessionsViewData(url: URL): Promise<{
  appStatus: Awaited<ReturnType<typeof loadAppChromeStatus>>;
  pageData: SessionsPageData;
  heading: string;
  countSummary: string;
  notice?: string;
  error?: string;
}> {
  const includeStale = url.searchParams.get("view") !== "active";
  const workspaceFilter = url.searchParams.get("workspace")?.trim() ||
    undefined;
  const [pageData, appStatus] = await Promise.all([
    loadSessionsPageData({
      includeStale,
      workspaceFilter,
    }),
    loadAppChromeStatus(),
  ]);
  return {
    appStatus,
    pageData,
    heading: buildPageTitle(
      pageData.workspaceFilterAlias,
      pageData.workspaceFilterId,
    ),
    countSummary: buildCountSummary({
      includeStale: pageData.includeStale,
      activeSessionCount: pageData.activeSessionCount,
      staleSessionCount: pageData.staleSessionCount,
      inactiveSessionCount: pageData.inactiveSessionCount,
    }),
    notice: decodeMessage(url.searchParams.get("notice")),
    error: decodeMessage(url.searchParams.get("error")),
  };
}

function SessionsView(props: {
  appStatus: Awaited<ReturnType<typeof loadAppChromeStatus>>;
  pageData: SessionsPageData;
  heading: string;
  countSummary: string;
  notice?: string;
  error?: string;
  csrfToken?: string;
}) {
  return (
    <>
      <Head>
        <title>Kato Web · Sessions</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Sessions"
          description="Discovered chat-session inventory with current ingestion status and links into operational ingestion details."
          currentPath="/sessions"
          showLogout
          appStatus={props.appStatus}
        />

        {props.notice ? <p class="notice-banner ok">{props.notice}</p> : null}
        {props.error ? <p class="notice-banner danger">{props.error}</p> : null}

        <section class="grid">
          <article class="card span-12">
            <div class="page-toolbar">
              <div>
                <h2>{props.heading}</h2>
                {props.pageData.workspaceFilterId
                  ? (
                    <p class="page-toolbar-summary muted mono">
                      Workspace: {props.pageData.workspaceFilterId}
                    </p>
                  )
                  : null}
                <p class="page-toolbar-summary muted mono">
                  {props.countSummary}
                </p>
              </div>
              <div class="page-actions">
                <a
                  class={props.pageData.includeStale
                    ? "secondary-button current-filter"
                    : "secondary-button"}
                  href={buildSessionInventoryHref({
                    includeStale: true,
                    workspaceFilter: props.pageData.workspaceFilter,
                  })}
                >
                  All Sessions
                </a>
                <a
                  class={!props.pageData.includeStale
                    ? "secondary-button current-filter"
                    : "secondary-button"}
                  href={buildSessionInventoryHref({
                    includeStale: false,
                    workspaceFilter: props.pageData.workspaceFilter,
                  })}
                >
                  Active Only
                </a>
                {props.pageData.workspaceFilter
                  ? (
                    <a
                      class="secondary-button"
                      href={buildSessionInventoryHref({
                        includeStale: props.pageData.includeStale,
                      })}
                    >
                      Clear Workspace Filter
                    </a>
                  )
                  : null}
              </div>
            </div>

            <ul class="session-list-rows">
              {props.pageData.rows.length === 0
                ? (
                  <li class="muted">
                    No sessions match the current filters.
                  </li>
                )
                : props.pageData.rows.map((row) => (
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
                            <strong>{row.snippet ?? "(no snippet)"}</strong>
                            {" "}
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
                            includeStale: props.pageData.includeStale,
                            workspaceFilter: props.pageData.workspaceFilter,
                          })}
                        >
                          <span class="session-list-copy">
                            <span class="session-list-primary">
                              <span class="mono">{row.provider}:</span>{" "}
                              <strong>{row.snippet ?? "(no snippet)"}</strong>
                              {" "}
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
                              value={String(props.pageData.includeStale)}
                            />
                            <input
                              type="hidden"
                              name="workspaceFilter"
                              value={props.pageData.workspaceFilter ?? ""}
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
      </div>
    </>
  );
}

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const includeStale = String(form.get("includeStale") ?? "true") !== "false";
    const workspaceFilter = String(form.get("workspaceFilter") ?? "").trim() ||
      undefined;
    const redirectUrl = new URL(
      buildSessionInventoryHref({
        includeStale,
        workspaceFilter,
      }),
      ctx.req.url,
    );
    const { operationalLogger, auditLogger } = createWebLoggers();

    try {
      if (action !== "start-ingestion") {
        return new Response("unsupported sessions action", { status: 400 });
      }

      const sessionId = String(form.get("sessionId") ?? "").trim();
      if (sessionId.length === 0) {
        throw new Error("Session id is required");
      }

      const result = await ingestPersistedSession({
        sessionId,
        operationalLogger,
        auditLogger,
      });
      const notice = result.appendedTwinEvents > 0
        ? `ingestion completed: ${result.provider} (${result.sessionShortId})`
        : result.parsedEvents > 0
        ? `ingestion already current: ${result.provider} (${result.sessionShortId})`
        : `no ingestable events found: ${result.provider} (${result.sessionShortId})`;
      redirectUrl.searchParams.set("notice", notice);
      return Response.redirect(redirectUrl, 303);
    } catch (error) {
      await operationalLogger.error(
        "web.sessions.mutation.failed",
        "Session mutation failed",
        {
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      redirectUrl.searchParams.set(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      return Response.redirect(redirectUrl, 303);
    }
  },
});

export default define.page(async function SessionsPage(ctx) {
  const viewData = await loadSessionsViewData(ctx.url);
  return <SessionsView {...viewData} csrfToken={ctx.state.csrfToken} />;
});
