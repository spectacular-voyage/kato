export const LIVE_JSON_CACHE_CONTROL = "no-store, no-cache, must-revalidate";

export function liveJsonResponse(payload: unknown): Response {
  return Response.json(payload, {
    headers: {
      "cache-control": LIVE_JSON_CACHE_CONTROL,
    },
  });
}
