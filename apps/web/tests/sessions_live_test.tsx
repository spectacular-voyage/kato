import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { h } from "preact";
import { renderToString } from "npm:preact-render-to-string@^6.6.3";
import SessionsLive from "../islands/SessionsLive.tsx";
import type { SessionsPageData } from "../src/loaders/sessions.ts";

function makeSessionsPageData(): SessionsPageData {
  return {
    includeStale: false,
    workspaceFilter: "ws-alpha",
    workspaceFilterId: "ws-alpha",
    workspaceFilterAlias: "alpha",
    workspaceOptions: [{
      workspaceId: "ws-alpha",
      alias: "alpha",
      displayName: "Alpha Workspace",
    }],
    sessionCount: 1,
    activeSessionCount: 1,
    staleSessionCount: 0,
    inactiveSessionCount: 0,
    activeRecordingCount: 1,
    staleRecordingCount: 0,
    stoppedRecordingCount: 0,
    rows: [{
      sessionKey: "codex:provider-session-1",
      provider: "codex",
      sessionId: "sess-active",
      sessionShortId: "sess-act",
      providerSessionId: "provider-session-1",
      snippet: "Keep the session filters stable",
      updatedAt: "2026-07-10T16:00:00.000Z",
      lastEventAt: "2026-07-10T16:00:00.000Z",
      twinSizeBytes: 12_345,
      stale: false,
      state: "active",
      activeRecordingCount: 1,
      staleRecordingCount: 0,
      stoppedRecordingCount: 0,
      recordings: [{
        key: "recording-active",
        state: "engaged-active",
        workspaceId: "ws-alpha",
        workspaceAlias: "alpha",
        workspaceDisplayName: "Alpha Workspace",
        workspaceHref: "/workspaces#workspace-ws-alpha",
        outputPath: "/tmp/alpha/notes/session.md",
        displayOutputPath: "notes/session.md",
        startedAt: "2026-07-10T15:55:00.000Z",
        lastWriteAt: "2026-07-10T16:00:00.000Z",
        recordingCycleId: "cycle-active",
      }],
    }],
  };
}

function renderSessions(includeTwinSize = true): string {
  const initialData = makeSessionsPageData();
  if (!includeTwinSize && initialData.rows[0]) {
    delete initialData.rows[0].twinSizeBytes;
  }
  return renderToString(
    h(SessionsLive, {
      initialData,
      endpoint: "/api/sessions?view=active&workspace=ws-alpha",
      csrfToken: "csrf-123",
    }),
  );
}

Deno.test("SessionsLive renders twin size and absent states beside the updated timestamp", () => {
  const sizedHtml = renderSessions();

  assertMatch(
    sizedHtml,
    /Updated\s*<time[^>]*>[^<]+<\/time>\s*· Twin 12\.1 KB/,
  );

  const absentHtml = renderSessions(false);
  assertStringIncludes(absentHtml, "· Twin absent");
});

Deno.test("SessionsLive omits obsolete sub-conversation controls and preserves navigation filters", () => {
  const html = renderSessions();

  assertEquals(html.includes("Sub-conversations"), false);
  assertEquals(html.includes(">Grouped<"), false);
  assertEquals(html.includes(">Hidden<"), false);
  assertEquals(html.includes("subagents=hide"), false);
  assertMatch(
    html,
    /<a class="secondary-button" href="\/sessions\?workspace=ws-alpha">All Sessions<\/a>/,
  );
  assertMatch(
    html,
    /<a class="secondary-button current-filter" href="\/sessions\?view=active&amp;workspace=ws-alpha">Active Only<\/a>/,
  );
  assertMatch(
    html,
    /<a class="secondary-button" href="\/sessions\?view=active">Clear Filter<\/a>/,
  );
});

Deno.test("SessionsLive renders recursive groups closed by default with child Twin summaries", () => {
  const initialData = makeSessionsPageData();
  const parent = initialData.rows[0];
  assertEquals(parent?.sessionId, "sess-active");
  initialData.sessionCount = 2;
  initialData.activeSessionCount = 2;
  initialData.rows.push({
    sessionKey: "codex:provider-session-child",
    provider: "codex",
    sessionId: "sess-child",
    sessionShortId: "sess-chi",
    providerSessionId: "provider-session-child",
    snippet: "Child content must start collapsed",
    updatedAt: "2026-07-10T16:01:00.000Z",
    lastEventAt: "2026-07-10T16:01:00.000Z",
    twinSizeBytes: 2_048,
    stale: false,
    state: "active",
    activeRecordingCount: 0,
    staleRecordingCount: 0,
    stoppedRecordingCount: 0,
    relationship: {
      kind: "subconversation",
      parentSessionId: "sess-active",
    },
    recordings: [],
  });

  const html = renderToString(
    h(SessionsLive, {
      initialData,
      endpoint: "/api/sessions?view=active&workspace=ws-alpha",
      csrfToken: "csrf-123",
    }),
  );

  assertMatch(
    html,
    /<button[^>]*class="session-tree-toggle[^>]*aria-expanded="false"[^>]*aria-controls="session-children-sess-active"/,
  );
  assertStringIncludes(html, "1 sub-conversation");
  assertStringIncludes(html, "2.0 KB child Twin");
  assertMatch(
    html,
    /<ul id="session-children-sess-active" class="session-tree-children" hidden><\/ul>/,
  );
  assertEquals(html.includes("Child content must start collapsed"), false);
});

Deno.test("SessionsLive omits obsolete subagent state from recording action forms", () => {
  const html = renderSessions();
  const recordingForms = html.match(
    /<form[^>]*class="[^"]*session-list-action-form[^"]*"[\s\S]*?<\/form>/g,
  ) ?? [];

  assertEquals(recordingForms.length, 2);
  for (const form of recordingForms) {
    assertEquals(form.includes('name="includeSubagents"'), false);
  }
});
