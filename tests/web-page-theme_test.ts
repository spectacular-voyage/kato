import { assertEquals } from "@std/assert";
import { resolvePageThemeRoot } from "../apps/web/src/page_theme.ts";

Deno.test("resolvePageThemeRoot returns summary for the home route", () => {
  assertEquals(resolvePageThemeRoot("/"), "summary");
  assertEquals(resolvePageThemeRoot(""), "summary");
  assertEquals(resolvePageThemeRoot(undefined), "summary");
});

Deno.test("resolvePageThemeRoot returns the top-level route segment", () => {
  assertEquals(resolvePageThemeRoot("/recordings"), "recordings");
  assertEquals(resolvePageThemeRoot("/logs"), "logs");
  assertEquals(resolvePageThemeRoot("/logs/detail"), "logs");
  assertEquals(resolvePageThemeRoot(" /maintenance "), "maintenance");
});
