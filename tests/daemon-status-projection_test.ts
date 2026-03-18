import { assertEquals, assertExists } from "@std/assert";
import type { DaemonSessionStatus, SessionMetadataV1 } from "@kato/shared";
import type { ActiveRecording } from "../apps/daemon/src/writer/mod.ts";
import type {
  SessionSnapshotMetadataEntry,
} from "../apps/daemon/src/orchestrator/ingestion_runtime.ts";
import {
  summarizeRecordingStatus,
  toActiveRecordingsFromMetadata,
  toProviderStatuses,
  toSessionStatuses,
} from "../apps/daemon/src/orchestrator/runtime_status_projection.ts";
import type {
  SessionWorkspaceOutputStateV1,
} from "../shared/src/contracts/session_state.ts";
import { resolveTestTempPath } from "./test_temp.ts";

const STATUS_PROJECTION_WORKSPACE_ROOT = resolveTestTempPath(
  "status-projection",
  "workspace",
);
const STATUS_PROJECTION_OUTPUT_PATH = resolveTestTempPath(
  "status-projection",
  "out.md",
);

function makeSnapshotEntry(
  overrides: Partial<SessionSnapshotMetadataEntry> & {
    provider: string;
    sessionId: string;
    updatedAt: string;
  },
): SessionSnapshotMetadataEntry {
  return {
    provider: overrides.provider,
    sessionId: overrides.sessionId,
    metadata: {
      updatedAt: overrides.updatedAt,
      eventCount: 1,
      truncatedEvents: 0,
      ...(overrides.metadata ?? {}),
    },
  };
}

function makeWorkspaceOutput(
  overrides: Partial<SessionWorkspaceOutputStateV1> = {},
): SessionWorkspaceOutputStateV1 {
  return {
    workspaceId: "workspace-1",
    workspaceAliasSnapshot: "Docs",
    desiredState: "on",
    currentDestination: {
      kind: "absolute-explicit",
      absolutePath: STATUS_PROJECTION_OUTPUT_PATH,
    },
    currentResolvedPath: STATUS_PROJECTION_OUTPUT_PATH,
    workspaceRootSnapshot: STATUS_PROJECTION_WORKSPACE_ROOT,
    resolvedDefaultOutputDir: STATUS_PROJECTION_WORKSPACE_ROOT,
    filenameTemplate: "{provider}.md",
    writerFeatureFlags: {
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
      writerIncludeToolCalls: true,
      writerIncludeToolResults: true,
      writerIncludeDecisionPrompt: true,
      writerIncludeDecisionOptions: true,
      writerIncludeDecisionSelection: true,
      writerItalicizeUserMessages: false,
    },
    writeCursor: 0,
    recordingCycles: [],
    ...overrides,
  };
}

function makeSessionMetadata(
  overrides: Partial<SessionMetadataV1> & {
    provider: string;
    providerSessionId: string;
    sessionId: string;
    updatedAt: string;
  },
): SessionMetadataV1 {
  const {
    provider,
    providerSessionId,
    sessionId,
    updatedAt,
    ...rest
  } = overrides;
  return {
    schemaVersion: 1,
    sessionKey: `${provider}:${providerSessionId}`,
    provider,
    providerSessionId,
    sessionId,
    createdAt: updatedAt,
    updatedAt,
    sourceFilePath: resolveTestTempPath(
      "status-projection",
      `${providerSessionId}.jsonl`,
    ),
    ingestCursor: { kind: "byte-offset", value: 0 },
    twinPath: resolveTestTempPath("status-projection", `${sessionId}.jsonl`),
    nextTwinSeq: 1,
    recentFingerprints: [],
    ...rest,
  };
}

Deno.test(
  "toProviderStatuses aggregates fresh providers, keeps latest lastEventAt, and omits stale entries",
  () => {
    const statuses = toProviderStatuses(
      [
        makeSnapshotEntry({
          provider: "codex",
          sessionId: "s1",
          updatedAt: "2026-02-22T10:00:00.000Z",
          metadata: {
            updatedAt: "2026-02-22T10:00:00.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:00.000Z",
          },
        }),
        makeSnapshotEntry({
          provider: "codex",
          sessionId: "s2",
          updatedAt: "2026-02-22T10:00:05.000Z",
          metadata: {
            updatedAt: "2026-02-22T10:00:05.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:05.000Z",
          },
        }),
        makeSnapshotEntry({
          provider: "claude",
          sessionId: "s3",
          updatedAt: "2026-02-22T10:00:03.000Z",
        }),
        makeSnapshotEntry({
          provider: "codex",
          sessionId: "stale",
          updatedAt: "2026-02-22T09:00:00.000Z",
          metadata: {
            updatedAt: "2026-02-22T09:00:00.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T09:00:00.000Z",
          },
        }),
      ],
      new Date("2026-02-22T10:00:06.000Z"),
      60_000,
    );

    assertEquals(statuses, [
      {
        provider: "claude",
        activeSessions: 1,
      },
      {
        provider: "codex",
        activeSessions: 2,
        lastEventAt: "2026-02-22T10:00:05.000Z",
      },
    ]);
  },
);

Deno.test(
  "toActiveRecordingsFromMetadata and summarizeRecordingStatus keep active sessions only",
  () => {
    const activeMetadata = makeSessionMetadata({
      provider: "codex",
      providerSessionId: "session-active",
      sessionId: "kato-session-active-12345678",
      updatedAt: "2026-02-22T10:00:00.000Z",
      workspaceOutputs: [
        makeWorkspaceOutput({
          currentResolvedPath: resolveTestTempPath(
            "status-projection",
            "active.md",
          ),
          activeRecordingCycleId: "recording-active-1",
          recordingCycles: [
            {
              recordingCycleId: "recording-active-0",
              startedCursor: 0,
              startedAt: "2026-02-22T08:00:00.000Z",
            },
            {
              recordingCycleId: "recording-active-1",
              startedCursor: 10,
              startedAt: "2026-02-22T09:00:00.000Z",
              lastWriteAt: "2026-02-22T09:45:00.000Z",
            },
          ],
        }),
      ],
    });
    const staleMetadata = makeSessionMetadata({
      provider: "codex",
      providerSessionId: "session-stale",
      sessionId: "kato-session-stale-12345678",
      updatedAt: "2026-02-22T08:00:00.000Z",
      workspaceOutputs: [
        makeWorkspaceOutput({
          currentResolvedPath: resolveTestTempPath(
            "status-projection",
            "stale.md",
          ),
          activeRecordingCycleId: "recording-stale-1",
          recordingCycles: [{
            recordingCycleId: "recording-stale-1",
            startedCursor: 0,
            startedAt: "2026-02-22T07:00:00.000Z",
            lastWriteAt: "2026-02-22T07:30:00.000Z",
          }],
        }),
        makeWorkspaceOutput({
          desiredState: "off",
          currentResolvedPath: resolveTestTempPath(
            "status-projection",
            "off.md",
          ),
        }),
      ],
    });

    const activeRecordings = toActiveRecordingsFromMetadata([
      activeMetadata,
      staleMetadata,
    ]);

    assertEquals(activeRecordings.length, 2);
    const active = activeRecordings.find((recording) =>
      recording.sessionId === "session-active"
    );
    assertExists(active);
    assertEquals(active.startedAt, "2026-02-22T08:00:00.000Z");
    assertEquals(active.restartedAt, "2026-02-22T09:00:00.000Z");
    assertEquals(active.lastWriteAt, "2026-02-22T09:45:00.000Z");

    const summary = summarizeRecordingStatus(activeRecordings, [
      {
        provider: "codex",
        sessionId: "kato-session-active-12345678",
        providerSessionId: "session-active",
        updatedAt: "2026-02-22T10:00:00.000Z",
        stale: false,
      } as DaemonSessionStatus,
      {
        provider: "codex",
        sessionId: "kato-session-stale-12345678",
        providerSessionId: "session-stale",
        updatedAt: "2026-02-22T08:00:00.000Z",
        stale: true,
      } as DaemonSessionStatus,
    ]);

    assertEquals(summary, {
      activeRecordings: 1,
      destinations: 1,
    });
  },
);

Deno.test(
  "toSessionStatuses maps persisted metadata and sorts by recency",
  () => {
    const activeRecordings: ActiveRecording[] = [{
      recordingId: "recording-abcdef123456",
      provider: "codex",
      sessionId: "provider-codex",
      workspaceAlias: "Docs",
      outputPath: resolveTestTempPath("status-projection", "codex.md"),
      startedAt: "2026-02-22T09:58:00.000Z",
      lastWriteAt: "2026-02-22T10:00:00.000Z",
    }];
    const sessionMetadataByKey = new Map<string, SessionMetadataV1>([
      [
        "codex:provider-codex",
        makeSessionMetadata({
          provider: "codex",
          providerSessionId: "provider-codex",
          sessionId: "kato-session-abcdef123456",
          updatedAt: "2026-02-22T10:00:00.000Z",
        }),
      ],
    ]);

    const statuses = toSessionStatuses(
      [
        makeSnapshotEntry({
          provider: "claude",
          sessionId: "provider-claude",
          updatedAt: "2026-02-22T09:58:00.000Z",
          metadata: {
            updatedAt: "2026-02-22T09:58:00.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T09:58:00.000Z",
            snippet: "older session",
          },
        }),
        makeSnapshotEntry({
          provider: "codex",
          sessionId: "provider-codex",
          updatedAt: "2026-02-22T10:00:00.000Z",
          metadata: {
            updatedAt: "2026-02-22T10:00:00.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:00.000Z",
            snippet: "fresh session",
          },
        }),
      ],
      activeRecordings,
      new Date("2026-02-22T10:00:10.000Z"),
      60_000,
      sessionMetadataByKey,
    );

    assertEquals(statuses.length, 2);
    assertEquals(statuses[0]?.provider, "codex");
    assertEquals(statuses[0]?.sessionId, "kato-session-abcdef123456");
    assertEquals(statuses[0]?.sessionShortId, "kato-ses");
    assertEquals(statuses[0]?.providerSessionId, "provider-codex");
    assertEquals(statuses[0]?.snippet, "fresh session");
    assertEquals(
      statuses[0]?.recordings?.[0]?.recordingId,
      "recording-abcdef123456",
    );
    assertEquals(statuses[0]?.recordings?.[0]?.workspaceAlias, "Docs");
    assertEquals(statuses[1]?.provider, "claude");
    assertEquals(statuses[1]?.stale, true);
  },
);
