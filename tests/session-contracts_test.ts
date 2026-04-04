import { assert, assertEquals } from "@std/assert";
import {
  isSessionMetadataV1,
  isSessionTwinEventV1,
  type SessionMetadataV1,
  type SessionTwinEventV1,
} from "@kato/shared";

function makeSessionMetadata(): SessionMetadataV1 {
  return {
    schemaVersion: 1,
    sessionKey: "codex:session-1",
    provider: "codex",
    providerSessionId: "session-1",
    sessionId: "kato-session-1",
    createdAt: "2026-03-14T10:00:00.000Z",
    updatedAt: "2026-03-14T10:00:00.000Z",
    sourceFilePath: "C:/tmp/provider-session.jsonl",
    ingestCursor: { kind: "byte-offset", value: 0 },
    twinPath: "C:/tmp/provider-session.twin.jsonl",
    nextTwinSeq: 1,
    recentFingerprints: [],
  };
}

function makeSessionTwinEvent(): SessionTwinEventV1 {
  return {
    schemaVersion: 1,
    session: {
      provider: "claude",
      providerSessionId: "provider-session-1",
      sessionId: "kato-session-1",
    },
    seq: 1,
    kind: "assistant.message",
    source: {
      providerEventType: "assistant",
      cursor: { kind: "byte-offset", value: 10 },
      emitIndex: 0,
    },
    payload: { text: "hello" },
  };
}

Deno.test(
  "isSessionMetadataV1 tolerates workspace destinations without stored path hints",
  () => {
    const metadata = makeSessionMetadata();
    metadata.workspaceOutputs = [
      {
        workspaceId: "workspace-1",
        desiredState: "on",
        currentDestination: {
          kind: "workspace-relative",
        },
        currentResolvedPath: "C:/workspace/notes/output.md",
        workspaceRootSnapshot: "C:/workspace",
        resolvedDefaultOutputDir: "C:/workspace/notes",
        filenameTemplate: "{provider}.md",
        writerFeatureFlags: {
          writerIncludeCommentary: true,
          writerIncludeThinking: true,
          writerIncludeToolCalls: true,
          writerItalicizeUserMessages: false,
          writerRelativizeLocalLinks: true,
        },
        writeCursor: 0,
        recordingCycles: [{
          recordingCycleId: "cycle-1",
          startedCursor: 0,
          startedAt: "2026-03-14T10:00:00.000Z",
          lastWriteAt: "2026-03-14T10:01:00.000Z",
        }],
      },
      {
        workspaceId: "workspace-2",
        desiredState: "off",
        currentDestination: {
          kind: "absolute-explicit",
        },
        currentResolvedPath: "C:/outside/output.md",
        workspaceRootSnapshot: "C:/workspace",
        resolvedDefaultOutputDir: "C:/workspace/notes",
        filenameTemplate: "{provider}.md",
        writerFeatureFlags: {
          writerIncludeCommentary: true,
          writerIncludeThinking: false,
          writerIncludeToolCalls: true,
          writerItalicizeUserMessages: true,
          writerRelativizeLocalLinks: false,
        },
        writeCursor: 5,
        recordingCycles: [],
      },
    ];

    assert(isSessionMetadataV1(metadata));
  },
);

Deno.test(
  "isSessionMetadataV1 rejects blank workspace destination path hints when present",
  () => {
    const metadata = makeSessionMetadata();
    metadata.workspaceOutputs = [{
      workspaceId: "workspace-1",
      desiredState: "on",
      currentDestination: {
        kind: "workspace-relative",
        relativePathFromWorkspaceRoot: "   ",
      },
      currentResolvedPath: "C:/workspace/notes/output.md",
      workspaceRootSnapshot: "C:/workspace",
      resolvedDefaultOutputDir: "C:/workspace/notes",
      filenameTemplate: "{provider}.md",
      writerFeatureFlags: {
        writerIncludeCommentary: true,
        writerIncludeThinking: true,
        writerIncludeToolCalls: true,
        writerItalicizeUserMessages: false,
      },
      writeCursor: 0,
      recordingCycles: [],
    }];

    assertEquals(isSessionMetadataV1(metadata), false);
  },
);

Deno.test(
  "isSessionMetadataV1 rejects non-string recording cycle lastWriteAt values",
  () => {
    const metadata = makeSessionMetadata();
    metadata.workspaceOutputs = [{
      workspaceId: "workspace-1",
      desiredState: "on",
      currentDestination: {
        kind: "workspace-relative",
      },
      currentResolvedPath: "C:/workspace/notes/output.md",
      workspaceRootSnapshot: "C:/workspace",
      resolvedDefaultOutputDir: "C:/workspace/notes",
      filenameTemplate: "{provider}.md",
      writerFeatureFlags: {
        writerIncludeCommentary: true,
        writerIncludeThinking: true,
        writerIncludeToolCalls: true,
        writerItalicizeUserMessages: false,
      },
      writeCursor: 0,
      recordingCycles: [{
        recordingCycleId: "cycle-1",
        startedCursor: 0,
        lastWriteAt: 123 as unknown as string,
      }],
    }];

    assertEquals(isSessionMetadataV1(metadata), false);
  },
);

Deno.test(
  "isSessionTwinEventV1 rejects empty-string optional metadata that should be omitted instead",
  () => {
    const cases: Array<{ label: string; event: SessionTwinEventV1 }> = [
      {
        label: "providerEventId",
        event: {
          ...makeSessionTwinEvent(),
          source: {
            ...makeSessionTwinEvent().source,
            providerEventId: "",
          },
        },
      },
      {
        label: "providerTimestamp",
        event: {
          ...makeSessionTwinEvent(),
          time: { providerTimestamp: "" },
        },
      },
      {
        label: "capturedAt",
        event: {
          ...makeSessionTwinEvent(),
          time: { capturedAt: "   " },
        },
      },
      {
        label: "turnId",
        event: {
          ...makeSessionTwinEvent(),
          turnId: "",
        },
      },
      {
        label: "model",
        event: {
          ...makeSessionTwinEvent(),
          model: "   ",
        },
      },
    ];

    for (const testCase of cases) {
      assertEquals(
        isSessionTwinEventV1(testCase.event),
        false,
        `expected invalid twin event for ${testCase.label}`,
      );
    }
  },
);

Deno.test("isSessionTwinEventV1 accepts non-empty optional metadata", () => {
  const event: SessionTwinEventV1 = {
    ...makeSessionTwinEvent(),
    source: {
      ...makeSessionTwinEvent().source,
      providerEventId: "evt-1",
    },
    time: {
      providerTimestamp: "2026-03-14T10:00:00.000Z",
      capturedAt: "2026-03-14T10:00:01.000Z",
    },
    turnId: "turn-1",
    model: "claude-sonnet-4-6",
  };

  assert(isSessionTwinEventV1(event));
});
