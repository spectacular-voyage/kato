import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DaemonControlRequestFileStore,
  DaemonStatusSnapshotFileStore,
} from "../apps/daemon/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

async function withTempRuntimeDir(
  run: (runtimeDir: string) => Promise<void>,
): Promise<void> {
  await withTestTempDir("daemon-control-plane-", run);
}

Deno.test("DaemonStatusSnapshotFileStore persists and loads snapshots", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const statusPath = join(runtimeDir, "status.json");
    const store = new DaemonStatusSnapshotFileStore(
      statusPath,
      () => new Date("2026-02-22T12:00:00.000Z"),
    );

    const missing = await store.load();
    assertEquals(missing.schemaVersion, 1);
    assertEquals(missing.daemonRunning, false);
    assertEquals(missing.generatedAt, "2026-02-22T12:00:00.000Z");
    assertEquals(missing.heartbeatAt, "2026-02-22T12:00:00.000Z");

    const snapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T12:05:00.000Z",
      heartbeatAt: "2026-02-22T12:05:00.000Z",
      daemonRunning: true,
      daemonPid: 9876,
      providers: [{ provider: "claude", activeSessions: 2 }],
      recordings: { activeRecordings: 4, destinations: 1 },
    };
    await store.save(snapshot);

    const loaded = await store.load();
    assertEquals(loaded, snapshot);
  });
});

Deno.test("DaemonStatusSnapshotFileStore falls back on invalid JSON", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const statusPath = join(runtimeDir, "status.json");
    await Deno.writeTextFile(statusPath, "{not-json");

    const store = new DaemonStatusSnapshotFileStore(
      statusPath,
      () => new Date("2026-02-22T12:10:00.000Z"),
    );

    const fallback = await store.load();
    assertEquals(fallback.schemaVersion, 1);
    assertEquals(fallback.generatedAt, "2026-02-22T12:10:00.000Z");
    assertEquals(fallback.heartbeatAt, "2026-02-22T12:10:00.000Z");
    assertEquals(fallback.daemonRunning, false);
  });
});

Deno.test("DaemonControlRequestFileStore appends and lists requests", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    let nextId = 0;
    const store = new DaemonControlRequestFileStore(
      controlPath,
      () => new Date("2026-02-22T12:15:00.000Z"),
      () => {
        nextId += 1;
        return `req-${nextId}`;
      },
    );

    const startRequest = await store.enqueue({
      command: "start",
      payload: { requestedByPid: 1111 },
    });
    const stopRequest = await store.enqueue({
      command: "stop",
      payload: { requestedByPid: 2222 },
    });

    assertEquals(startRequest.requestId, "req-1");
    assertEquals(stopRequest.requestId, "req-2");
    assertEquals(startRequest.requestedAt, "2026-02-22T12:15:00.000Z");

    const listed = await store.list();
    assertEquals(listed.length, 2);
    assertEquals(listed[0]?.command, "start");
    assertEquals(listed[1]?.command, "stop");

    const raw = JSON.parse(await Deno.readTextFile(controlPath)) as {
      requests?: unknown[];
    };
    assertExists(raw.requests);
    assertEquals(raw.requests.length, 2);

    await store.markProcessed("req-1");
    const afterFirstProcess = await store.list();
    assertEquals(afterFirstProcess.length, 1);
    assertEquals(afterFirstProcess[0]?.requestId, "req-2");
  });
});

Deno.test("DaemonControlRequestFileStore fails closed on invalid queue files", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    await Deno.writeTextFile(
      controlPath,
      JSON.stringify({
        schemaVersion: 999,
        requests: [{ requestId: 1 }],
      }),
    );

    const store = new DaemonControlRequestFileStore(controlPath);
    await assertRejects(
      () => store.list(),
      Error,
      "unsupported schema",
    );
  });
});

Deno.test("DaemonControlRequestFileStore rejects unknown markProcessed request", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    const store = new DaemonControlRequestFileStore(controlPath);

    await store.enqueue({
      command: "start",
      payload: { requestedByPid: 1111 },
    });

    await assertRejects(
      () => store.markProcessed("missing-request-id"),
      Error,
      "not found",
    );
  });
});
