import { assertEquals, assertExists } from "@std/assert";
import type { DaemonStatusSnapshot } from "@kato/shared";
import {
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  runDaemonRuntimeLoop,
} from "../apps/daemon/src/mod.ts";

Deno.test("runDaemonRuntimeLoop processes stop requests and updates status", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-1",
    requestedAt: "2026-02-22T10:00:00.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertExists(statusHistory[0]);
  assertEquals(statusHistory[0]?.daemonRunning, true);
  assertEquals(statusHistory[0]?.daemonPid, 4242);

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last?.daemonRunning, false);
  assertEquals(last?.daemonPid, undefined);
  assertEquals(requests.length, 0);
});
