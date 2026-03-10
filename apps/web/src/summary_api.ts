import type { SummaryPageData } from "./loaders/status.ts";

export const SUMMARY_API_CACHE_CONTROL = "no-store, no-cache, must-revalidate";

export function summaryApiResponse(summary: SummaryPageData): Response {
  return Response.json(summary, {
    headers: {
      "cache-control": SUMMARY_API_CACHE_CONTROL,
    },
  });
}
