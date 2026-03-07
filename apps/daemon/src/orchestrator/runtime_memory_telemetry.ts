import type { MemoryProcessStats } from "@kato/shared";
import type { SnapshotMemoryStats } from "./ingestion_runtime.ts";

export interface RuntimeMemoryTelemetryLogger {
  debug(
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void>;
  info(
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void>;
}

export function emptySnapshotMemoryStats(): SnapshotMemoryStats {
  return {
    estimatedBytes: 0,
    sessionCount: 0,
    eventCount: 0,
    evictionsTotal: 0,
    bytesReclaimedTotal: 0,
    evictionsByReason: {},
    overBudget: false,
  };
}

export function cloneSnapshotMemoryStats(
  stats: SnapshotMemoryStats,
): SnapshotMemoryStats {
  return {
    estimatedBytes: stats.estimatedBytes,
    sessionCount: stats.sessionCount,
    eventCount: stats.eventCount,
    evictionsTotal: stats.evictionsTotal,
    bytesReclaimedTotal: stats.bytesReclaimedTotal,
    evictionsByReason: { ...stats.evictionsByReason },
    overBudget: stats.overBudget,
  };
}

export function hasSnapshotMemoryChanged(
  previous: SnapshotMemoryStats | undefined,
  current: SnapshotMemoryStats,
): boolean {
  if (!previous) {
    return true;
  }
  if (
    previous.estimatedBytes !== current.estimatedBytes ||
    previous.sessionCount !== current.sessionCount ||
    previous.eventCount !== current.eventCount ||
    previous.evictionsTotal !== current.evictionsTotal ||
    previous.bytesReclaimedTotal !== current.bytesReclaimedTotal ||
    previous.overBudget !== current.overBudget
  ) {
    return true;
  }

  const previousEntries = Object.entries(previous.evictionsByReason);
  const currentEntries = Object.entries(current.evictionsByReason);
  if (previousEntries.length !== currentEntries.length) {
    return true;
  }
  for (const [reason, value] of currentEntries) {
    if ((previous.evictionsByReason[reason] ?? 0) !== value) {
      return true;
    }
  }

  return false;
}

export function computeSnapshotEvictionDelta(
  previous: SnapshotMemoryStats | undefined,
  current: SnapshotMemoryStats,
): {
  evictionsTotal: number;
  bytesReclaimedTotal: number;
  evictionsByReason: Record<string, number>;
} {
  const previousEvictionsTotal = previous?.evictionsTotal ?? 0;
  const previousBytesReclaimedTotal = previous?.bytesReclaimedTotal ?? 0;
  const evictionsByReason: Record<string, number> = {};

  for (
    const [reason, count] of Object.entries(
      current.evictionsByReason,
    ) as Array<[string, number]>
  ) {
    const priorCount = previous?.evictionsByReason[reason] ?? 0;
    if (count > priorCount) {
      evictionsByReason[reason] = count - priorCount;
    }
  }

  return {
    evictionsTotal: Math.max(
      0,
      current.evictionsTotal - previousEvictionsTotal,
    ),
    bytesReclaimedTotal: Math.max(
      0,
      current.bytesReclaimedTotal - previousBytesReclaimedTotal,
    ),
    evictionsByReason,
  };
}

export async function logMemoryTelemetry(options: {
  operationalLogger: RuntimeMemoryTelemetryLogger;
  daemonMaxMemoryBytes: number;
  processMemory: MemoryProcessStats;
  snapshotMemory: SnapshotMemoryStats;
  previousSnapshotMemory?: SnapshotMemoryStats;
  phase: "heartbeat" | "shutdown";
  forceSampleLog?: boolean;
}): Promise<SnapshotMemoryStats> {
  const {
    operationalLogger,
    daemonMaxMemoryBytes,
    processMemory,
    snapshotMemory,
    previousSnapshotMemory,
    phase,
    forceSampleLog = false,
  } = options;

  if (
    forceSampleLog ||
    hasSnapshotMemoryChanged(previousSnapshotMemory, snapshotMemory)
  ) {
    await operationalLogger.debug(
      "daemon.memory.sample",
      "Daemon memory sample updated",
      {
        phase,
        daemonMaxMemoryBytes,
        process: processMemory,
        snapshots: snapshotMemory,
      },
    );
  }

  const evictionDelta = computeSnapshotEvictionDelta(
    previousSnapshotMemory,
    snapshotMemory,
  );
  if (evictionDelta.evictionsTotal > 0) {
    await operationalLogger.info(
      "daemon.memory.evicted",
      "Daemon snapshot store evicted sessions",
      {
        phase,
        evictions: evictionDelta.evictionsTotal,
        bytesReclaimed: evictionDelta.bytesReclaimedTotal,
        evictionsByReason: evictionDelta.evictionsByReason,
        snapshotSessionCount: snapshotMemory.sessionCount,
        snapshotEstimatedBytes: snapshotMemory.estimatedBytes,
      },
    );
  }

  return cloneSnapshotMemoryStats(snapshotMemory);
}
