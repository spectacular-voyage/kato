import { assertEquals, assertThrows } from "@std/assert";
import {
  buildMaintenanceHiddenFields,
  DEFAULT_TWINS_DAYS,
  parseTwinsDays,
  resolveTwinsDaysParam,
} from "../apps/web/src/maintenance_state.ts";

Deno.test("parseTwinsDays rejects empty cleanup values", () => {
  assertThrows(
    () => parseTwinsDays("   "),
    Error,
    "Twin cleanup days is required",
  );
});

Deno.test("resolveTwinsDaysParam falls back to default for empty values", () => {
  assertEquals(resolveTwinsDaysParam(null), DEFAULT_TWINS_DAYS);
  assertEquals(resolveTwinsDaysParam("   "), DEFAULT_TWINS_DAYS);
});

Deno.test("buildMaintenanceHiddenFields preserves maintenance filters and twin cleanup options", () => {
  assertEquals(
    buildMaintenanceHiddenFields({
      includeStale: false,
      workspaceFilter: "  ws-alpha  ",
      twinsDays: 0,
      deleteTwinMetadata: true,
    }),
    [
      { name: "includeStale", value: "false" },
      { name: "workspaceFilter", value: "ws-alpha" },
      { name: "twinsDays", value: "0" },
      { name: "deleteTwinMetadata", value: "on" },
    ],
  );
});
