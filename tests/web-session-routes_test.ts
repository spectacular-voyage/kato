import { assertEquals } from "@std/assert";
import {
  buildMaintenanceHref,
  buildRecordingRowAnchorId,
  buildRecordingsHref,
  buildRecordingsRecordingHref,
  buildSessionInventoryHref,
  buildSessionInventorySessionHref,
} from "../apps/web/src/session_routes.ts";
import {
  parseSessionPageQuery,
  parseSessionsPageQuery,
} from "../apps/web/src/page_queries.ts";

Deno.test("sessions query parser only hides subagents when explicitly requested", () => {
  assertEquals(
    parseSessionsPageQuery(new URL("http://kato.local/sessions")),
    {
      includeStale: true,
      includeSubagents: true,
      workspaceFilter: undefined,
    },
  );
  assertEquals(
    parseSessionsPageQuery(
      new URL("http://kato.local/sessions?subagents=unknown"),
    ),
    {
      includeStale: true,
      includeSubagents: true,
      workspaceFilter: undefined,
    },
  );
  assertEquals(
    parseSessionsPageQuery(
      new URL(
        "http://kato.local/sessions?view=active&workspace=ws-alpha&subagents=hide",
      ),
    ),
    {
      includeStale: false,
      includeSubagents: false,
      workspaceFilter: "ws-alpha",
    },
  );
});

Deno.test("maintenance session query parsing ignores the Sessions-only subagent filter", () => {
  assertEquals(
    parseSessionPageQuery(
      new URL("http://kato.local/maintenance?subagents=hide"),
    ),
    {
      includeStale: true,
      workspaceFilter: undefined,
    },
  );
});

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

Deno.test("session route builders compose the subagent filter without changing maintenance routes", () => {
  assertEquals(
    buildSessionInventoryHref({
      includeStale: false,
      includeSubagents: false,
      workspaceFilter: "  ws-alpha  ",
    }),
    "/sessions?view=active&workspace=ws-alpha&subagents=hide",
  );
  assertEquals(
    buildSessionInventorySessionHref("sess-123", {
      includeStale: false,
      includeSubagents: false,
      workspaceFilter: "  ws-alpha  ",
    }),
    "/sessions?view=active&workspace=ws-alpha&subagents=hide#session-sess-123",
  );
  assertEquals(
    buildMaintenanceHref({
      includeStale: false,
      includeSubagents: false,
      workspaceFilter: "  ws-alpha  ",
    }),
    "/maintenance?view=active&workspace=ws-alpha",
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
