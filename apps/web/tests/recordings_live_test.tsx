import { assert, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { h } from "preact";
import { renderToString } from "npm:preact-render-to-string@6.6.6";
import RecordingsLive from "../islands/RecordingsLive.tsx";
import type { RecordingsPageData } from "../src/loaders/recordings.ts";

function makeRecordingsPageData(): RecordingsPageData {
  return {
    includeStale: true,
    stateFilter: "all",
    activeRecordingCount: 1,
    staleRecordingCount: 1,
    stoppedRecordingCount: 1,
    rows: [
      {
        key: "row-active",
        state: "engaged-active",
        provider: "codex",
        sessionId: "sess-active",
        sessionShortId: "abc5589",
        snippet: "web commands phase 2",
        sessionState: "active",
        sessionHref: "/sessions#session-sess-active",
        updatedAt: "2026-03-18T18:05:00.000Z",
        workspaceId: "ws-kato",
        workspaceAlias: "k",
        workspaceDisplayName: "kato",
        workspaceHref: "/workspaces#workspace-ws-kato",
        outputPath: "/tmp/kato/conv.active.md",
        displayOutputPath: "conv.active.md",
        startedAt: "2026-03-17T15:38:17.000Z",
        lastWriteAt: "2026-03-18T10:50:51.000Z",
        recordingCycleId: "cycle-active",
      },
      {
        key: "row-stale",
        state: "engaged-stale",
        provider: "codex",
        sessionId: "sess-stale",
        sessionShortId: "dfd3ef66",
        snippet: "picking up the pieces",
        sessionState: "stale",
        sessionHref: "/sessions#session-sess-stale",
        updatedAt: "2026-03-17T00:37:00.000Z",
        workspaceId: "ws-alpha",
        workspaceAlias: "w",
        workspaceHref: "/workspaces#workspace-ws-alpha",
        outputPath: "/tmp/alpha/wa.conv.2026.md",
        displayOutputPath: "wa.conv.2026.md",
        startedAt: "2026-03-17T00:37:00.000Z",
        lastWriteAt: undefined,
        recordingCycleId: "cycle-stale",
      },
      {
        key: "row-stopped",
        state: "stopped",
        provider: "sflo",
        sessionId: "sess-stopped",
        sessionShortId: "d4c99fb9",
        snippet: "existing solutions that could be extended with weave",
        sessionState: "inactive",
        sessionHref: "/sessions#session-sess-stopped",
        updatedAt: "2026-03-14T09:58:44.000Z",
        workspaceId: "ws-sflo",
        workspaceAlias: "sflo",
        workspaceHref: "/workspaces#workspace-ws-sflo",
        outputPath: "/tmp/sflo/sflo.conv.2026.md",
        displayOutputPath: "sflo.conv.2026.md",
        startedAt: "2026-03-14T09:58:44.000Z",
        stoppedAt: "2026-03-14T10:10:00.000Z",
        recordingCycleId: "cycle-stopped",
      },
    ],
  };
}

Deno.test("RecordingsLive renders labeled detail lines, session links, and idle disarm copy", () => {
  const html = renderToString(
    h(RecordingsLive, {
      initialData: makeRecordingsPageData(),
      endpoint: "/api/recordings",
      csrfToken: "csrf-123",
    }),
  );

  assertStringIncludes(
    html,
    "Recording: 1, Armed for recording: 1, Stopped: 1",
  );
  assertStringIncludes(html, ">armed for recording<");
  assertStringIncludes(html, "[disarm]");
  assertStringIncludes(html, "File:");
  assertStringIncludes(html, "Workspace:");
  assertStringIncludes(html, "Session:");
  assertMatch(
    html,
    /<a[^>]*href="\/sessions#session-sess-stale"[^>]*>picking up the pieces<\/a>/,
  );
  assertMatch(
    html,
    /<a[^>]*href="\/sessions#session-sess-stale"[^>]*>\(dfd3ef66\)<\/a>/,
  );

  const fileIndex = html.indexOf("File:");
  const startedIndex = html.indexOf("Started");
  const workspaceIndex = html.indexOf("Workspace:");
  const sessionIndex = html.indexOf("Session:");
  assert(fileIndex !== -1);
  assert(startedIndex !== -1);
  assert(workspaceIndex !== -1);
  assert(sessionIndex !== -1);
  assert(fileIndex < startedIndex);
  assert(startedIndex < workspaceIndex);
  assert(workspaceIndex < sessionIndex);
});
