import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  createDefaultStatusSnapshot,
  DaemonControlRequestFileStore,
  DaemonStatusSnapshotFileStore,
  isStatusSnapshotStale,
  resolveDefaultControlPath,
  resolveDefaultRuntimeDir,
  resolveDefaultStatusPath,
} from "../apps/daemon/src/mod.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withIsolatedEnvironment,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

async function withTempRuntimeDir(
  run: (runtimeDir: string) => Promise<void>,
): Promise<void> {
  await withTestTempDir("daemon-control-plane-", run);
}

function snapshotControlPlaneOverrideEnv(): {
  statusPath: string | undefined;
  controlPath: string | undefined;
} {
  return {
    statusPath: Deno.env.get("KATO_DAEMON_STATUS_PATH"),
    controlPath: Deno.env.get("KATO_DAEMON_CONTROL_PATH"),
  };
}

function restoreControlPlaneOverrideEnv(snapshot: {
  statusPath: string | undefined;
  controlPath: string | undefined;
}): void {
  if (snapshot.statusPath === undefined) {
    Deno.env.delete("KATO_DAEMON_STATUS_PATH");
  } else {
    Deno.env.set("KATO_DAEMON_STATUS_PATH", snapshot.statusPath);
  }
  if (snapshot.controlPath === undefined) {
    Deno.env.delete("KATO_DAEMON_CONTROL_PATH");
  } else {
    Deno.env.set("KATO_DAEMON_CONTROL_PATH", snapshot.controlPath);
  }
}

Deno.test("resolveDefaultRuntimeDir uses ~/.kato/daemon when home is present", async () => {
  await withIsolatedEnvironment(async () => {
    const snapshot = snapshotRuntimeEnv();
    await withTestTempDir("daemon-control-home-", async (rootDir) => {
      const homeDir = join(rootDir, "home");
      await Deno.mkdir(homeDir, { recursive: true });
      try {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });
        assertEquals(
          resolveDefaultRuntimeDir(),
          join(homeDir, ".kato", "daemon"),
        );
      } finally {
        restoreRuntimeEnv(snapshot);
      }
    });
  });
});

Deno.test("resolveDefaultRuntimeDir uses USERPROFILE when HOME is unset", async () => {
  if (Deno.build.os !== "windows") {
    return;
  }
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: undefined,
        USERPROFILE: "C:\\Users\\WindowsUser",
        KATO_RUNTIME_DIR: undefined,
      });
      assertEquals(
        resolveDefaultRuntimeDir(),
        "C:\\Users\\WindowsUser\\.kato\\daemon",
      );
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("resolveDefaultRuntimeDir rejects relative KATO_RUNTIME_DIR", async () => {
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: undefined,
        USERPROFILE: undefined,
        KATO_RUNTIME_DIR: ".kato/daemon",
      });
      assertThrows(
        () => resolveDefaultRuntimeDir(),
        Error,
        "must resolve to an absolute path",
      );
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("resolveDefaultRuntimeDir accepts absolute KATO_RUNTIME_DIR", async () => {
  await withIsolatedEnvironment(async () => {
    const snapshot = snapshotRuntimeEnv();
    await withTestTempDir("daemon-control-runtime-", async (rootDir) => {
      const runtimeDir = join(rootDir, "runtime");
      await Deno.mkdir(runtimeDir, { recursive: true });
      try {
        setRuntimeEnv({
          KATO_RUNTIME_DIR: runtimeDir,
        });
        assertEquals(resolveDefaultRuntimeDir(), runtimeDir);
      } finally {
        restoreRuntimeEnv(snapshot);
      }
    });
  });
});

Deno.test("resolveDefaultRuntimeDir expands ~-prefixed KATO_RUNTIME_DIR", async () => {
  await withIsolatedEnvironment(async () => {
    const snapshot = snapshotRuntimeEnv();
    await withTestTempDir("daemon-control-home-", async (rootDir) => {
      const homeDir = join(rootDir, "home");
      await Deno.mkdir(homeDir, { recursive: true });
      try {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: "~/.kato/custom-daemon",
        });
        assertEquals(
          resolveDefaultRuntimeDir(),
          join(homeDir, ".kato", "custom-daemon"),
        );
      } finally {
        restoreRuntimeEnv(snapshot);
      }
    });
  });
});

Deno.test("resolveDefaultRuntimeDir expands ~\\-prefixed KATO_RUNTIME_DIR", async () => {
  if (Deno.build.os !== "windows") {
    return;
  }
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: undefined,
        USERPROFILE: "C:\\Users\\WindowsUser",
        KATO_RUNTIME_DIR: "~\\.kato\\custom-daemon",
      });
      assertEquals(
        resolveDefaultRuntimeDir(),
        "C:\\Users\\WindowsUser\\.kato\\custom-daemon",
      );
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("resolveDefaultRuntimeDir fails when home and override are unavailable", async () => {
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotRuntimeEnv();
    try {
      setRuntimeEnv({
        HOME: undefined,
        USERPROFILE: undefined,
        KATO_RUNTIME_DIR: undefined,
      });
      assertThrows(
        () => resolveDefaultRuntimeDir(),
        Error,
        "HOME/USERPROFILE is not set",
      );
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
});

Deno.test("createDefaultStatusSnapshot initializes stopped daemon defaults", () => {
  const snapshot = createDefaultStatusSnapshot(
    new Date("2026-02-22T12:00:00.000Z"),
  );

  assertEquals(snapshot, {
    schemaVersion: 2,
    generatedAt: "2026-02-22T12:00:00.000Z",
    heartbeatAt: "2026-02-22T12:00:00.000Z",
    daemonRunning: false,
    daemonVersion: undefined,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  });
});

Deno.test("isStatusSnapshotStale handles stopped, fresh, stale, and invalid heartbeats", () => {
  const now = new Date("2026-02-22T12:00:11.000Z");

  assertEquals(
    isStatusSnapshotStale({
      ...createDefaultStatusSnapshot(
        new Date("2026-02-22T12:00:00.000Z"),
      ),
      daemonRunning: false,
      heartbeatAt: "invalid",
    }, now),
    false,
  );

  assertEquals(
    isStatusSnapshotStale({
      ...createDefaultStatusSnapshot(
        new Date("2026-02-22T12:00:00.000Z"),
      ),
      daemonRunning: true,
      heartbeatAt: "2026-02-22T12:00:01.000Z",
    }, now),
    false,
  );

  assertEquals(
    isStatusSnapshotStale({
      ...createDefaultStatusSnapshot(
        new Date("2026-02-22T12:00:00.000Z"),
      ),
      daemonRunning: true,
      heartbeatAt: "2026-02-22T12:00:00.000Z",
    }, new Date("2026-02-22T12:00:12.000Z")),
    true,
  );

  assertEquals(
    isStatusSnapshotStale({
      ...createDefaultStatusSnapshot(
        new Date("2026-02-22T12:00:00.000Z"),
      ),
      daemonRunning: true,
      heartbeatAt: "invalid",
    }, now),
    true,
  );
});

Deno.test("resolveDefaultStatusPath and resolveDefaultControlPath use katoDir defaults", async () => {
  await withTempRuntimeDir((runtimeDir) => {
    const katoDir = join(runtimeDir, ".kato");

    assertEquals(
      resolveDefaultStatusPath(katoDir),
      join(katoDir, "shared", "status.json"),
    );
    assertEquals(
      resolveDefaultControlPath(katoDir),
      join(katoDir, "shared", "ipc", "daemon-control.json"),
    );
    return Promise.resolve();
  });
});

Deno.test("resolveDefaultStatusPath and resolveDefaultControlPath honor env overrides", async () => {
  await withIsolatedEnvironment(async () => {
    const runtimeSnapshot = snapshotRuntimeEnv();
    const overrideSnapshot = snapshotControlPlaneOverrideEnv();
    await withTestTempDir("daemon-control-path-overrides-", async (rootDir) => {
      const homeDir = join(rootDir, "home");
      await Deno.mkdir(homeDir, { recursive: true });
      try {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });
        Deno.env.set("KATO_DAEMON_STATUS_PATH", "~/.kato/custom-status.json");
        Deno.env.set(
          "KATO_DAEMON_CONTROL_PATH",
          "~/.kato/custom-ipc/daemon-control.json",
        );

        assertEquals(
          resolveDefaultStatusPath(join(rootDir, ".ignored")),
          join(homeDir, ".kato", "custom-status.json"),
        );
        assertEquals(
          resolveDefaultControlPath(join(rootDir, ".ignored")),
          join(homeDir, ".kato", "custom-ipc", "daemon-control.json"),
        );
      } finally {
        restoreControlPlaneOverrideEnv(overrideSnapshot);
        restoreRuntimeEnv(runtimeSnapshot);
      }
    });
  });
});

Deno.test("DaemonStatusSnapshotFileStore persists and loads snapshots", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const statusPath = join(runtimeDir, "status.json");
    const store = new DaemonStatusSnapshotFileStore(
      statusPath,
      () => new Date("2026-02-22T12:00:00.000Z"),
    );

    const missing = await store.load();
    assertEquals(missing.schemaVersion, 2);
    assertEquals(missing.daemonRunning, false);
    assertEquals(missing.generatedAt, "2026-02-22T12:00:00.000Z");
    assertEquals(missing.heartbeatAt, "2026-02-22T12:00:00.000Z");

    const snapshot = {
      schemaVersion: 2,
      generatedAt: "2026-02-22T12:05:00.000Z",
      heartbeatAt: "2026-02-22T12:05:00.000Z",
      daemonRunning: true,
      daemonPid: 9876,
      daemonVersion: "1.2.3",
      providers: [{
        provider: "claude",
        activeSessions: 2,
        lastEventAt: "2026-02-22T12:04:00.000Z",
      }],
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
    assertEquals(fallback.schemaVersion, 2);
    assertEquals(fallback.generatedAt, "2026-02-22T12:10:00.000Z");
    assertEquals(fallback.heartbeatAt, "2026-02-22T12:10:00.000Z");
    assertEquals(fallback.daemonRunning, false);
  });
});

Deno.test("DaemonStatusSnapshotFileStore falls back on unsupported snapshot shapes", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const statusPath = join(runtimeDir, "status.json");
    await Deno.writeTextFile(
      statusPath,
      JSON.stringify({
        schemaVersion: 2,
        generatedAt: "2026-02-22T12:10:00.000Z",
        heartbeatAt: "2026-02-22T12:10:00.000Z",
        daemonRunning: true,
        daemonPid: 1234,
        daemonVersion: 42,
        providers: [{ provider: "claude", activeSessions: -1 }],
        recordings: { activeRecordings: 1, destinations: 1 },
      }),
    );

    const store = new DaemonStatusSnapshotFileStore(
      statusPath,
      () => new Date("2026-02-22T12:11:00.000Z"),
    );

    const fallback = await store.load();
    assertEquals(fallback.schemaVersion, 2);
    assertEquals(fallback.generatedAt, "2026-02-22T12:11:00.000Z");
    assertEquals(fallback.heartbeatAt, "2026-02-22T12:11:00.000Z");
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
    const exportRequest = await store.enqueue({
      command: "export",
      payload: { sessionId: "session-1" },
    });
    const cleanRequest = await store.enqueue({
      command: "clean",
      payload: { all: true },
    });

    assertEquals(startRequest.requestId, "req-1");
    assertEquals(stopRequest.requestId, "req-2");
    assertEquals(exportRequest.requestId, "req-3");
    assertEquals(cleanRequest.requestId, "req-4");
    assertEquals(startRequest.requestedAt, "2026-02-22T12:15:00.000Z");

    const listed = await store.list();
    assertEquals(listed.length, 4);
    assertEquals(listed[0]?.command, "start");
    assertEquals(listed[1]?.command, "stop");
    assertEquals(listed[2]?.command, "export");
    assertEquals(listed[3]?.command, "clean");

    const raw = JSON.parse(await Deno.readTextFile(controlPath)) as {
      requests?: unknown[];
    };
    assertExists(raw.requests);
    assertEquals(raw.requests.length, 4);

    await store.markProcessed("req-2");
    const afterFirstProcess = await store.list();
    assertEquals(afterFirstProcess.length, 2);
    assertEquals(afterFirstProcess[0]?.requestId, "req-3");
  });
});

Deno.test("DaemonControlRequestFileStore clones payloads and persists lastProcessedRequestId", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    const store = new DaemonControlRequestFileStore(
      controlPath,
      () => new Date("2026-02-22T12:16:00.000Z"),
      () => "req-1",
    );

    const draftPayload = { requestedByPid: 1111 };
    const enqueued = await store.enqueue({
      command: "start",
      payload: draftPayload,
    });
    draftPayload.requestedByPid = 2222;
    if (!enqueued.payload) {
      throw new Error("expected payload on enqueued request");
    }
    enqueued.payload["requestedByPid"] = 3333;

    const listed = await store.list();
    assertEquals(listed.length, 1);
    assertEquals(listed[0]?.payload?.["requestedByPid"], 1111);

    if (!listed[0]?.payload) {
      throw new Error("expected payload on listed request");
    }
    listed[0].payload["requestedByPid"] = 4444;

    const listedAgain = await store.list();
    assertEquals(listedAgain[0]?.payload?.["requestedByPid"], 1111);

    await store.markProcessed("req-1");
    const raw = JSON.parse(await Deno.readTextFile(controlPath)) as {
      requests?: unknown[];
      lastProcessedRequestId?: string;
    };
    assertEquals(raw.requests, []);
    assertEquals(raw.lastProcessedRequestId, "req-1");
  });
});

Deno.test("DaemonControlRequestFileStore rejects malformed JSON queue files", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    await Deno.writeTextFile(controlPath, "{not-json");

    const store = new DaemonControlRequestFileStore(controlPath);
    await assertRejects(
      () => store.list(),
      Error,
      "invalid JSON",
    );
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

Deno.test("DaemonControlRequestFileStore fails closed on invalid lastProcessedRequestId shape", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    await Deno.writeTextFile(
      controlPath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [],
        lastProcessedRequestId: 123,
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

Deno.test("DaemonControlRequestFileStore fails closed on unknown commands", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    await Deno.writeTextFile(
      controlPath,
      JSON.stringify({
        schemaVersion: 1,
        requests: [
          {
            requestId: "req-1",
            requestedAt: "2026-02-22T12:15:00.000Z",
            command: "start",
          },
          {
            requestId: "req-2",
            requestedAt: "2026-02-22T12:15:00.000Z",
            command: "attach",
          },
        ],
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

Deno.test("DaemonControlRequestFileStore enforces the maximum queue length", async () => {
  await withTempRuntimeDir(async (runtimeDir) => {
    const controlPath = join(runtimeDir, "control.json");
    await Deno.writeTextFile(
      controlPath,
      JSON.stringify({
        schemaVersion: 1,
        requests: Array.from({ length: 10_000 }, (_, index) => ({
          requestId: `req-${index + 1}`,
          requestedAt: "2026-02-22T12:15:00.000Z",
          command: "start",
        })),
      }),
    );

    const store = new DaemonControlRequestFileStore(controlPath);
    await assertRejects(
      () => store.enqueue({ command: "stop" }),
      Error,
      "exceeds limit",
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
