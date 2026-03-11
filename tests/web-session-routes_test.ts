import { assertEquals } from "@std/assert";
import {
  buildMaintenanceHref,
  buildSessionInventoryHref,
  buildSessionInventorySessionHref,
} from "../apps/web/src/session_routes.ts";

Deno.test("session route builders omit empty filters and default to stale-inclusive inventory", () => {
  assertEquals(buildSessionInventoryHref(), "/sessions");
  assertEquals(
    buildSessionInventorySessionHref("sess-123"),
    "/sessions#session-sess-123",
  );
  assertEquals(buildMaintenanceHref(), "/maintenance");
  assertEquals(
    buildMaintenanceHref({ workspaceFilter: "   " }),
    "/maintenance",
  );
});

Deno.test("session route builders normalize active-view and workspace filters", () => {
  assertEquals(
    buildSessionInventoryHref({
      includeStale: false,
      workspaceFilter: "  ws-alpha  ",
    }),
    "/sessions?view=active&workspace=ws-alpha",
  );
  assertEquals(
    buildSessionInventorySessionHref("sess-123", {
      includeStale: false,
      workspaceFilter: "  ",
    }),
    "/sessions?view=active#session-sess-123",
  );
  assertEquals(
    buildMaintenanceHref({
      includeStale: false,
      workspaceFilter: " ws-beta ",
    }),
    "/maintenance?view=active&workspace=ws-beta",
  );
});
