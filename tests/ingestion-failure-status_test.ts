import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type {
  DaemonIngestionFailureStatus,
  DaemonStatusSnapshot,
} from "@kato/shared";
import {
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  type ProviderIngestionRunner,
  runDaemonRuntimeLoop,
} from "../apps/daemon/src/mod.ts";
import { PersistentSessionStateStore } from "../apps/runtime/src/mod.ts";
import { renderStatusText } from "../apps/cli/src/commands/status.ts";
import { loadSessionActivityRows } from "../apps/web/src/loaders/sessions.ts";
import { loadSummaryPageData } from "../apps/web/src/loaders/status.ts";
import { withTestTempDir } from "./test_temp.ts";

const FAILURE: DaemonIngestionFailureStatus = {
  provider: "codex",
  sessionId: "prov-failing",
  error: "failed to allocate string; buffer exceeds maximum length",
  firstFailedAt: "2026-11-02T19:21:49.000Z",
  lastFailedAt: "2026-11-08T21:47:07.000Z",
  consecutiveFailures: 12,
  nextRetryAt: "2026-11-08T22:02:07.000Z",
};

function baseSnapshot(): DaemonStatusSnapshot {
  return {
    schemaVersion: 2,
    generatedAt: "2026-11-08T21:47:10.000Z",
    heartbeatAt: "2026-11-08T21:47:10.000Z",
    daemonRunning: true,
    daemonPid: 4242,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
  };
}

Deno.test("runDaemonRuntimeLoop publishes runner ingestion failures in heartbeats and clears them on exit", async () => {
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
    provider: "codex",
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    poll: () =>
      Promise.resolve({
        provider: "codex",
        polledAt: new Date().toISOString(),
        sessionsUpdated: 0,
        eventsObserved: 0,
      }),
    getIngestionFailures: () => [FAILURE],
  };
  const deadline = Date.now() + 5_000;
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      const published = statusHistory.some((snapshot) =>
        (snapshot.ingestionFailures?.length ?? 0) > 0
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
    snapshot.ingestionFailures !== undefined
  );
  assertEquals(heartbeat?.ingestionFailures, [FAILURE]);
  const last = statusHistory[statusHistory.length - 1];
  assertEquals(last?.daemonRunning, false);
  assertEquals(last?.ingestionFailures, undefined);
});

Deno.test("web loaders surface ingestion failures on Summary and the matching Sessions row", async () => {
  await withTestTempDir("ingestion-failure-web-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    const statusPath = join(katoDir, "shared", "status.json");
    await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-11-08T21:00:00.000Z"),
      makeSessionId: () => "kato-sess-failing",
    });
    await store.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: FAILURE.sessionId,
      sourceFilePath: join(homeDir, "rollout.jsonl"),
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    const orphan = { ...FAILURE, sessionId: "prov-unknown" };
    await Deno.writeTextFile(
      statusPath,
      JSON.stringify({
        ...baseSnapshot(),
        ingestionFailures: [FAILURE, orphan, { provider: "codex" }],
      }),
    );
    const now = () => new Date("2026-11-08T21:47:12.000Z");

    const summary = await loadSummaryPageData({ now, katoDir });
    assertEquals(summary.ingestionFailures.length, 2);
    assertEquals(summary.ingestionFailures[0]?.sessionId, "kato-sess-failing");
    assertEquals(
      summary.ingestionFailures[0]?.providerSessionId,
      FAILURE.sessionId,
    );
    assertEquals(summary.ingestionFailures[0]?.consecutiveFailures, 12);
    assertEquals(summary.ingestionFailures[1]?.sessionId, undefined);
    assertEquals(
      summary.ingestionFailures[1]?.providerSessionId,
      "prov-unknown",
    );

    const rows = await loadSessionActivityRows({ now, katoDir });
    const row = rows.find((candidate) =>
      candidate.providerSessionId === FAILURE.sessionId
    );
    assertEquals(row?.ingestionFailure, {
      error: FAILURE.error,
      firstFailedAt: FAILURE.firstFailedAt,
      consecutiveFailures: FAILURE.consecutiveFailures,
      nextRetryAt: FAILURE.nextRetryAt,
    });
  });
});

Deno.test("renderStatusText lists failing sessions only when present", () => {
  const options = {
    showAll: true,
    now: new Date("2026-11-08T21:47:12.000Z"),
    stale: false,
  };
  const withFailures = renderStatusText(
    { ...baseSnapshot(), sessions: [], ingestionFailures: [FAILURE] },
    { ...options, terminalWidth: 200 },
  );
  assertStringIncludes(withFailures, "Ingestion Failing (1)");
  assertStringIncludes(withFailures, "codex:prov-failing");
  assertStringIncludes(withFailures, "12 attempts");
  assertStringIncludes(withFailures, "failed to allocate string");

  const without = renderStatusText(
    { ...baseSnapshot(), sessions: [] },
    options,
  );
  assertEquals(without.includes("Ingestion Failing"), false);
});
