import { liveJsonResponse } from "./api_response.ts";
import { loadLogPageData } from "./loaders/logs.ts";
import { loadRecordingsPageData } from "./loaders/recordings.ts";
import { loadSessionsPageData } from "./loaders/sessions.ts";
import { loadAppChromeStatus, loadSummaryPageData } from "./loaders/status.ts";
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

export async function getIngestionResponse(url: URL): Promise<Response> {
  return liveJsonResponse(
    await loadSessionsPageData(parseSessionPageQuery(url)),
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
