import { assertEquals, assertStringIncludes } from "@std/assert";
import type {
  DaemonStatusSnapshot,
  DaemonWatchDegradedStatus,
} from "@kato/shared";
import {
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  type ProviderIngestionRunner,
  runDaemonRuntimeLoop,
} from "../apps/daemon/src/mod.ts";
import { readWatchDegraded } from "../apps/runtime/src/mod.ts";
import { renderStatusText } from "../apps/cli/src/commands/status.ts";

const DEGRADED: DaemonWatchDegradedStatus = {
  provider: "claude",
  reason: "missed-changes",
  roots: ["/mnt/share/claude/projects"],
  since: "2026-11-10T21:00:00.000Z",
  missedChanges: 3,
};

function baseSnapshot(): DaemonStatusSnapshot {
  return {
    schemaVersion: 2,
    generatedAt: "2026-11-10T21:00:05.000Z",
    heartbeatAt: "2026-11-10T21:00:05.000Z",
    daemonRunning: true,
    daemonPid: 4242,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
  };
}

Deno.test("runDaemonRuntimeLoop publishes degraded watch roots and clears them on exit", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let current = baseSnapshot();
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load: () => Promise.resolve(structuredClone(current)),
    save(snapshot) {
      current = structuredClone(snapshot);
      statusHistory.push(structuredClone(snapshot));
      return Promise.resolve();
    },
  };
  const runner: ProviderIngestionRunner = {
    provider: "claude",
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    poll: () =>
      Promise.resolve({
        provider: "claude",
        polledAt: new Date().toISOString(),
        sessionsUpdated: 0,
        eventsObserved: 0,
      }),
    getWatchDegraded: () => [DEGRADED],
  };
  const deadline = Date.now() + 5_000;
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      const published = statusHistory.some((snapshot) =>
        (snapshot.watchDegraded?.length ?? 0) > 0
      );
      return Promise.resolve(
        published || Date.now() > deadline
          ? [{
            requestId: "stop-1",
            requestedAt: new Date().toISOString(),
            command: "stop" as const,
          }]
          : [],
      );
    },
    enqueue() {
      throw new Error("enqueue should not be called");
    },
    markProcessed: () => Promise.resolve(),
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    ingestionRunners: [runner],
    now: () => new Date(),
    pid: 4242,
    heartbeatIntervalMs: 20,
    pollIntervalMs: 5,
  });

  const heartbeat = statusHistory.find((snapshot) =>
    snapshot.watchDegraded !== undefined
  );
  assertEquals(heartbeat?.watchDegraded, [DEGRADED]);
  const last = statusHistory[statusHistory.length - 1];
  assertEquals(last?.daemonRunning, false);
  assertEquals(last?.watchDegraded, undefined);
});

Deno.test("readWatchDegraded keeps only well-formed entries", () => {
  const snapshot = {
    watchDegraded: [
      DEGRADED,
      { provider: "codex", reason: "watcher-down", roots: [], since: "x" },
      { provider: "codex", reason: "unknown", roots: [], since: "x" },
      { provider: "codex", reason: "watcher-down", roots: [1], since: "x" },
      "not an entry",
    ],
  } as unknown as Pick<DaemonStatusSnapshot, "watchDegraded">;
  assertEquals(readWatchDegraded(snapshot).map((entry) => entry.reason), [
    "missed-changes",
    "watcher-down",
  ]);
  assertEquals(readWatchDegraded({}), []);
});

Deno.test("renderStatusText lists degraded watch roots only when present", () => {
  const options = {
    showAll: true,
    now: new Date("2026-11-10T21:00:07.000Z"),
    stale: false,
  };
  const degraded = renderStatusText(
    {
      ...baseSnapshot(),
      sessions: [],
      watchDegraded: [DEGRADED, {
        provider: "codex",
        reason: "watcher-down",
        roots: ["/home/user/.codex/sessions"],
        since: "2026-11-10T20:59:00.000Z",
      }],
    },
    { ...options, terminalWidth: 200 },
  );
  assertStringIncludes(degraded, "Watcher Degraded (2)");
  assertStringIncludes(degraded, "claude · missed 3 changes · 1 root");
  assertStringIncludes(degraded, "/mnt/share/claude/projects");
  assertStringIncludes(degraded, "codex · watcher down, restarting");

  const healthy = renderStatusText(
    { ...baseSnapshot(), sessions: [] },
    options,
  );
  assertEquals(healthy.includes("Watcher Degraded"), false);
});
