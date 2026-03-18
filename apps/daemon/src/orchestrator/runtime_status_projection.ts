import type {
  DaemonSessionStatus,
  ProviderStatus,
  SessionMetadataV1,
} from "@kato/shared";
import { projectSessionStatus, sortSessionsByRecency } from "@kato/shared";
import type { SessionSnapshotMetadataEntry } from "./ingestion_runtime.ts";
import type { ActiveRecording } from "../writer/mod.ts";

function readTimeMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function makeSessionProcessingKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

function readWorkspaceOutputInitialStartedAt(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
): string {
  for (let i = 0; i < output.recordingCycles.length; i += 1) {
    const cycle = output.recordingCycles[i];
    if (cycle?.startedAt) {
      return cycle.startedAt;
    }
  }
  return output.createdAt ?? "";
}

function readWorkspaceOutputLatestStartedAt(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
): string | undefined {
  for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
    const cycle = output.recordingCycles[i];
    if (cycle?.startedAt) {
      return cycle.startedAt;
    }
  }
  return undefined;
}

function readWorkspaceOutputLastWriteAt(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
): string | undefined {
  const activeCycleId = output.activeRecordingCycleId;
  if (activeCycleId) {
    for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
      const cycle = output.recordingCycles[i];
      if (cycle?.recordingCycleId === activeCycleId && cycle.lastWriteAt) {
        return cycle.lastWriteAt;
      }
    }
  }
  for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
    const cycle = output.recordingCycles[i];
    if (cycle?.lastWriteAt) {
      return cycle.lastWriteAt;
    }
  }
  return undefined;
}

export function toActiveRecordingsFromMetadata(
  entries: SessionMetadataV1[],
): ActiveRecording[] {
  const recordings: ActiveRecording[] = [];
  for (const metadata of entries) {
    for (const output of metadata.workspaceOutputs ?? []) {
      if (output.desiredState !== "on") {
        continue;
      }
      const startedAt = readWorkspaceOutputInitialStartedAt(output) ||
        metadata.updatedAt;
      const restartedAt = readWorkspaceOutputLatestStartedAt(output);
      recordings.push({
        recordingId: output.activeRecordingCycleId ?? output.workspaceId,
        provider: metadata.provider,
        sessionId: metadata.providerSessionId,
        workspaceAlias: output.workspaceAliasSnapshot,
        outputPath: output.currentResolvedPath,
        startedAt,
        ...(restartedAt && restartedAt !== startedAt ? { restartedAt } : {}),
        lastWriteAt: readWorkspaceOutputLastWriteAt(output) ??
          metadata.updatedAt,
      });
    }
  }
  return recordings;
}

export function summarizeRecordingStatus(
  activeRecordings: ActiveRecording[],
  sessions: DaemonSessionStatus[] | undefined,
): { activeRecordings: number; destinations: number } {
  if (!sessions || activeRecordings.length === 0) {
    return { activeRecordings: 0, destinations: 0 };
  }
  const activeSessionKeys = new Set(
    sessions
      .filter((session) => !session.stale)
      .map((session) =>
        makeSessionProcessingKey(
          session.provider,
          session.providerSessionId ?? session.sessionId,
        )
      ),
  );
  const active = activeRecordings.filter((recording) =>
    activeSessionKeys.has(
      makeSessionProcessingKey(recording.provider, recording.sessionId),
    )
  );
  return {
    activeRecordings: active.length,
    destinations: new Set(
      active.map((recording) => recording.outputPath),
    ).size,
  };
}

export function toProviderStatuses(
  sessionSnapshots: SessionSnapshotMetadataEntry[],
  now: Date,
  staleAfterMs: number,
): ProviderStatus[] {
  const nowMs = now.getTime();
  const byProvider = new Map<
    string,
    { activeSessions: number; lastEventAtMs?: number; lastEventAt?: string }
  >();

  for (const snapshot of sessionSnapshots) {
    const provider = snapshot.provider.trim();
    if (!provider) {
      continue;
    }

    const updatedAtMs = readTimeMs(snapshot.metadata.updatedAt);
    if (updatedAtMs === undefined) {
      continue;
    }
    if (nowMs - updatedAtMs > staleAfterMs) {
      continue;
    }

    const current = byProvider.get(provider) ?? { activeSessions: 0 };
    current.activeSessions += 1;

    const lastEventAt = snapshot.metadata.lastEventAt;
    const lastEventAtMs = readTimeMs(lastEventAt);
    if (
      lastEventAt &&
      lastEventAtMs !== undefined &&
      (current.lastEventAtMs === undefined ||
        lastEventAtMs > current.lastEventAtMs)
    ) {
      current.lastEventAtMs = lastEventAtMs;
      current.lastEventAt = lastEventAt;
    }

    byProvider.set(provider, current);
  }

  return Array.from(byProvider.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, status]) => ({
      provider,
      activeSessions: status.activeSessions,
      ...(status.lastEventAt ? { lastEventAt: status.lastEventAt } : {}),
    }));
}

export function toSessionStatuses(
  sessionSnapshots: SessionSnapshotMetadataEntry[],
  activeRecordings: ActiveRecording[],
  now: Date,
  staleAfterMs: number,
  sessionMetadataByKey?: Map<string, SessionMetadataV1>,
): DaemonSessionStatus[] {
  const recordingsByKey = new Map<string, ActiveRecording[]>();
  for (const recording of activeRecordings) {
    const key = makeSessionProcessingKey(
      recording.provider,
      recording.sessionId,
    );
    const existing = recordingsByKey.get(key);
    if (existing) {
      existing.push(recording);
    } else {
      recordingsByKey.set(key, [recording]);
    }
  }

  const statuses = sessionSnapshots.map((snapshot) => {
    const metadata = sessionMetadataByKey?.get(
      `${snapshot.provider}:${snapshot.sessionId}`,
    );
    const recordings = recordingsByKey.get(
      makeSessionProcessingKey(snapshot.provider, snapshot.sessionId),
    );
    return projectSessionStatus({
      session: {
        provider: snapshot.provider,
        sessionId: metadata?.sessionId ?? snapshot.sessionId,
        ...(metadata ? { sessionShortId: metadata.sessionId.slice(0, 8) } : {}),
        ...(metadata ? { providerSessionId: metadata.providerSessionId } : {}),
        updatedAt: snapshot.metadata.updatedAt,
        lastEventAt: snapshot.metadata.lastEventAt,
        fileModifiedAtMs: snapshot.metadata.fileModifiedAtMs,
        snippet: snapshot.metadata.snippet,
      },
      recordings: recordings?.map((recording) => ({
        provider: recording.provider,
        sessionId: recording.sessionId,
        ...(recording.recordingId
          ? { recordingId: recording.recordingId }
          : {}),
        ...(recording.recordingId
          ? { recordingShortId: recording.recordingId.slice(0, 8) }
          : {}),
        ...(recording.workspaceAlias
          ? { workspaceAlias: recording.workspaceAlias }
          : {}),
        outputPath: recording.outputPath,
        startedAt: recording.startedAt,
        lastWriteAt: recording.lastWriteAt,
      })),
      now,
      staleAfterMs,
    });
  });

  return sortSessionsByRecency(statuses);
}
