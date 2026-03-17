import { assertEquals } from "@std/assert";
import {
  buildMaintenanceHref,
  buildRecordingRowAnchorId,
  buildRecordingsHref,
  buildRecordingsRecordingHref,
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

Deno.test("recordings route builders normalize filters and stable anchors", () => {
  assertEquals(buildRecordingsHref(), "/recordings");
  assertEquals(
    buildRecordingsHref({
      stateFilter: "engaged-stale",
      workspaceFilter: " ws-beta ",
    }),
    "/recordings?state=engaged-stale&workspace=ws-beta",
  );
  assertEquals(
    buildRecordingRowAnchorId({ recordingCycleId: "cycle-123" }),
    "recording-cycle-123",
  );
  assertEquals(
    buildRecordingRowAnchorId({
      rowKey: "ws-beta:/tmp/notes/file.md:active",
    }),
    "recording-key-c0c867711e269078",
  );
  assertEquals(
    buildRecordingsRecordingHref({
      workspaceFilter: " ws-beta ",
      recordingCycleId: "cycle-123",
    }),
    "/recordings?workspace=ws-beta#recording-cycle-123",
  );
});
