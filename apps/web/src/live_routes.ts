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

export interface LiveRouteOptions {
  katoDir?: string;
}

export async function getChromeStatusResponse(
  options: LiveRouteOptions = {},
): Promise<Response> {
  return liveJsonResponse(
    await loadAppChromeStatus({ katoDir: options.katoDir }),
  );
}

export async function getSummaryResponse(
  options: LiveRouteOptions = {},
): Promise<Response> {
  return liveJsonResponse(
    await loadSummaryPageData({ katoDir: options.katoDir }),
  );
}

export async function getMaintenanceTwinsResponse(
  url: URL,
  options: LiveRouteOptions = {},
): Promise<Response> {
  return liveJsonResponse(
    await loadMaintenanceTwinsData({
      ...parseSessionPageQuery(url),
      katoDir: options.katoDir,
    }),
  );
}

export async function getSessionsResponse(
  url: URL,
  options: LiveRouteOptions = {},
): Promise<Response> {
  return liveJsonResponse(
    await loadSessionsPageData({
      ...parseSessionPageQuery(url),
      katoDir: options.katoDir,
    }),
  );
}

export async function getRecordingsResponse(
  url: URL,
  options: LiveRouteOptions = {},
): Promise<Response> {
  return liveJsonResponse(
    await loadRecordingsPageData({
      ...parseRecordingsPageQuery(url),
      katoDir: options.katoDir,
    }),
  );
}

export async function getWorkspacesResponse(
  options: LiveRouteOptions = {},
): Promise<Response> {
  return liveJsonResponse(
    await loadWorkspacesPageData({ katoDir: options.katoDir }),
  );
}

export async function getLogsResponse(
  url: URL,
  options: LiveRouteOptions = {},
): Promise<Response> {
  return liveJsonResponse(
    await loadLogPageData({
      ...parseLogsPageQuery(url),
      katoDir: options.katoDir,
    }),
  );
}

export async function getSessionSnippetResponse(
  url: URL,
  options: LiveRouteOptions = {},
): Promise<Response> {
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
      katoDir: options.katoDir,
      allowSourceReplay: url.searchParams.get("source") === "1",
    }),
  );
}
