import { assert, assertEquals } from "@std/assert";
import type { LogRecord } from "../apps/daemon/src/mod.ts";
import { StructuredLogger } from "../apps/daemon/src/mod.ts";
import type { SnapshotMemoryStats } from "../apps/daemon/src/orchestrator/ingestion_runtime.ts";
import {
  computeSnapshotEvictionDelta,
  hasSnapshotMemoryChanged,
  logMemoryTelemetry,
} from "../apps/daemon/src/orchestrator/runtime_memory_telemetry.ts";

class CaptureSink {
  records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

function makeSnapshotMemoryStats(
  overrides: Partial<SnapshotMemoryStats> = {},
): SnapshotMemoryStats {
  return {
    estimatedBytes: 0,
    sessionCount: 0,
    eventCount: 0,
    evictionsTotal: 0,
    bytesReclaimedTotal: 0,
    evictionsByReason: {},
    overBudget: false,
    ...overrides,
  };
}

Deno.test("computeSnapshotEvictionDelta reports only new evictions", () => {
  assertEquals(
    computeSnapshotEvictionDelta(
      makeSnapshotMemoryStats({
        evictionsTotal: 2,
        bytesReclaimedTotal: 100,
        evictionsByReason: { lru: 2 },
      }),
      makeSnapshotMemoryStats({
        evictionsTotal: 5,
        bytesReclaimedTotal: 180,
        evictionsByReason: { lru: 4, memory: 1 },
      }),
    ),
    {
      evictionsTotal: 3,
      bytesReclaimedTotal: 80,
      evictionsByReason: { lru: 2, memory: 1 },
    },
  );
});

Deno.test("hasSnapshotMemoryChanged ignores identical cloned stats", () => {
  const stats = makeSnapshotMemoryStats({
    estimatedBytes: 64,
    sessionCount: 2,
    eventCount: 5,
    evictionsByReason: { lru: 1 },
  });

  assertEquals(
    hasSnapshotMemoryChanged(stats, {
      ...stats,
      evictionsByReason: { lru: 1 },
    }),
    false,
  );
});

Deno.test("logMemoryTelemetry emits sample and eviction logs when memory changes", async () => {
  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  const previous = makeSnapshotMemoryStats({
    sessionCount: 1,
    evictionsTotal: 1,
    bytesReclaimedTotal: 100,
    evictionsByReason: { lru: 1 },
  });
  const current = makeSnapshotMemoryStats({
    estimatedBytes: 256,
    sessionCount: 2,
    eventCount: 4,
    evictionsTotal: 3,
    bytesReclaimedTotal: 180,
    evictionsByReason: { lru: 2, memory: 1 },
  });

  const returned = await logMemoryTelemetry({
    operationalLogger,
    daemonMaxMemoryBytes: 50 * 1024 * 1024,
    processMemory: {
      rss: 1000,
      heapTotal: 500,
      heapUsed: 300,
      external: 200,
    },
    snapshotMemory: current,
    previousSnapshotMemory: previous,
    phase: "heartbeat",
  });

  assertEquals(returned, current);
  assert(
    sink.records.some((record) =>
      record.event === "daemon.memory.sample" &&
      record.channel === "operational"
    ),
  );
  const evictionRecord = sink.records.find((record) =>
    record.event === "daemon.memory.evicted" &&
    record.channel === "operational"
  );
  assert(evictionRecord);
  assertEquals(evictionRecord.attributes?.["evictions"], 2);
  assertEquals(evictionRecord.attributes?.["bytesReclaimed"], 80);
});
