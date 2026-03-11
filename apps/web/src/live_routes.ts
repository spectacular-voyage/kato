import { liveJsonResponse } from "./api_response.ts";
import { loadMaintenanceTwinsData } from "./loaders/maintenance_twins.ts";
import { loadLogPageData } from "./loaders/logs.ts";
import { loadRecordingsPageData } from "./loaders/recordings.ts";
import { loadSessionsPageData } from "./loaders/sessions.ts";
import { loadAppChromeStatus, loadSummaryPageData } from "./loaders/status.ts";
import { resolveSessionSnippet } from "./session_snippets.ts";
import { loadWorkspacesPageData } from "./loaders/workspaces.ts";
import {
  parseLogsPageQuery,
  parseRecordingsPageQuery,
  parseSessionPageQuery,
} from "./page_queries.ts";

export async function getChromeStatusResponse(): Promise<Response> {
  return liveJsonResponse(await loadAppChromeStatus());
}

export async function getSummaryResponse(): Promise<Response> {
  return liveJsonResponse(await loadSummaryPageData());
}

export async function getMaintenanceTwinsResponse(url: URL): Promise<Response> {
  return liveJsonResponse(
    await loadMaintenanceTwinsData(parseSessionPageQuery(url)),
  );
}

export async function getSessionsResponse(url: URL): Promise<Response> {
  return liveJsonResponse(
    await loadSessionsPageData(parseSessionPageQuery(url)),
  );
}

export async function getRecordingsResponse(url: URL): Promise<Response> {
  return liveJsonResponse(
    await loadRecordingsPageData(parseRecordingsPageQuery(url)),
  );
}

export async function getWorkspacesResponse(): Promise<Response> {
  return liveJsonResponse(await loadWorkspacesPageData());
}

export async function getLogsResponse(url: URL): Promise<Response> {
  return liveJsonResponse(await loadLogPageData(parseLogsPageQuery(url)));
}

export async function getSessionSnippetResponse(url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) {
    return Response.json(
      {
        sessionId: "",
        status: "unavailable",
        error: "sessionId is required",
      },
      {
        status: 400,
        headers: {
          "cache-control": "no-store, no-cache, must-revalidate",
        },
      },
    );
  }
  return liveJsonResponse(
    await resolveSessionSnippet({
      sessionId,
      allowSourceReplay: url.searchParams.get("source") === "1",
    }),
  );
}
