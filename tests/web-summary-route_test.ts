import { assertEquals, assertExists } from "@std/assert";
import {
  SUMMARY_API_CACHE_CONTROL,
  summaryApiResponse,
} from "../apps/web/src/summary_api.ts";

Deno.test("summary api disables response caching", async () => {
  const response = summaryApiResponse(
    {} as Parameters<typeof summaryApiResponse>[0],
  );

  assertEquals(
    response.headers.get("cache-control"),
    SUMMARY_API_CACHE_CONTROL,
  );
  assertExists(response.headers.get("content-type"));
});
