import { LIVE_JSON_CACHE_CONTROL, liveJsonResponse } from "./api_response.ts";
import type { SummaryPageData } from "./loaders/status.ts";

export const SUMMARY_API_CACHE_CONTROL = LIVE_JSON_CACHE_CONTROL;

export function summaryApiResponse(summary: SummaryPageData): Response {
  return liveJsonResponse(summary);
}
