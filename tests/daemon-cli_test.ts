import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { DaemonStatusSnapshot } from "@kato/shared";
import {
  CliUsageError,
  type DaemonControlRequest,
  type DaemonControlRequestDraft,
  type DaemonControlRequestStoreLike,
  type DaemonProcessLauncherLike,
  type DaemonStatusSnapshotStoreLike,
  parseDaemonCliArgs,
  runDaemonCli,
  type WritePathPolicyGateLike,
} from "../apps/daemon/src/mod.ts";

function makeRuntimeHarness(runtimeDir: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    runtime: {
      runtimeDir,
      statusPath: `${runtimeDir}/status.json`,
      controlPath: `${runtimeDir}/control.json`,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      writeStdout: (text: string) => {
        stdout.push(text);
      },
      writeStderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function makeInMemoryStatusStore(
  initial: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  },
): DaemonStatusSnapshotStoreLike {
  let state = {
    ...initial,
    providers: [...initial.providers],
    recordings: { ...initial.recordings },
  };
  return {
    load() {
      return Promise.resolve({
        ...state,
        providers: [...state.providers],
        recordings: { ...state.recordings },
      });
    },
    save(next: DaemonStatusSnapshot) {
      state = {
        ...next,
        providers: [...next.providers],
        recordings: { ...next.recordings },
      };
      return Promise.resolve();
    },
  };
}

function makeInMemoryControlStore(): {
  requests: DaemonControlRequest[];
  store: DaemonControlRequestStoreLike;
} {
  const requests: DaemonControlRequest[] = [];
  let requestCounter = 0;

  return {
    requests,
    store: {
      list() {
        return Promise.resolve(
          requests.map((request) => ({
            ...request,
            ...(request.payload ? { payload: { ...request.payload } } : {}),
          })),
        );
      },
      enqueue(draft: DaemonControlRequestDraft) {
        requestCounter += 1;
        const next: DaemonControlRequest = {
          requestId: `req-${requestCounter}`,
          requestedAt: "2026-02-22T10:00:00.000Z",
          command: draft.command,
          ...(draft.payload ? { payload: { ...draft.payload } } : {}),
        };
        requests.push(next);
        return Promise.resolve({
          ...next,
          ...(next.payload ? { payload: { ...next.payload } } : {}),
        });
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
    },
  };
}

function makePathPolicyGate(
  decision: "allow" | "deny",
): WritePathPolicyGateLike {
  return {
    evaluateWritePath(targetPath: string) {
      return Promise.resolve({
        decision,
        targetPath,
        reason: decision === "allow" ? "allowed-for-test" : "denied-for-test",
        canonicalTargetPath: decision === "allow"
          ? `/canonical/${targetPath}`
          : undefined,
      });
    },
  };
}

function makeDaemonLauncher(
  launchedPid: number,
): {
  launchedCount: { value: number };
  launcher: DaemonProcessLauncherLike;
} {
  const launchedCount = { value: 0 };
  return {
    launchedCount,
    launcher: {
      launchDetached() {
        launchedCount.value += 1;
        return Promise.resolve(launchedPid);
      },
    },
  };
}

Deno.test("cli parser rejects unknown command", () => {
  assertThrows(
    () => parseDaemonCliArgs(["wat"]),
    CliUsageError,
    "Unknown command",
  );
});

Deno.test("cli parser rejects unknown flag", () => {
  assertThrows(
    () => parseDaemonCliArgs(["start", "--wat"]),
    CliUsageError,
    "Unknown flag",
  );
});

Deno.test("cli parser enforces clean action flags", () => {
  assertThrows(
    () => parseDaemonCliArgs(["clean"]),
    CliUsageError,
    "requires one of --all",
  );
});

Deno.test("cli parser accepts status --json", () => {
  const parsed = parseDaemonCliArgs(["status", "--json"]);
  assertEquals(parsed.kind, "command");
  if (parsed.kind !== "command") {
    return;
  }

  assertEquals(parsed.command.name, "status");
  if (parsed.command.name !== "status") {
    return;
  }

  assertEquals(parsed.command.asJson, true);
});

Deno.test("runDaemonCli uses control queue and status snapshot stores", async () => {
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore({
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:05:00.000Z",
    heartbeatAt: "2026-02-22T10:05:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 3,
      destinations: 2,
    },
  });
  const daemonLauncher = makeDaemonLauncher(31337);
  const runtimeDir = ".kato/test-runtime";

  const startHarness = makeRuntimeHarness(runtimeDir);
  const startCode = await runDaemonCli(["start"], {
    runtime: startHarness.runtime,
    statusStore,
    controlStore: controlStore.store,
    daemonLauncher: daemonLauncher.launcher,
  });
  assertEquals(startCode, 0);
  assertStringIncludes(startHarness.stdout.join(""), "started in background");
  assertEquals(daemonLauncher.launchedCount.value, 1);
  assertEquals(controlStore.requests.length, 0);

  const statusHarness = makeRuntimeHarness(runtimeDir);
  const statusCode = await runDaemonCli(["status", "--json"], {
    runtime: statusHarness.runtime,
    statusStore,
    controlStore: controlStore.store,
  });
  assertEquals(statusCode, 0);

  const statusPayload = JSON.parse(statusHarness.stdout.join("")) as {
    schemaVersion: number;
    daemonRunning: boolean;
    heartbeatAt: string;
    daemonPid?: number;
    recordings: { activeRecordings: number };
  };
  assertEquals(statusPayload.schemaVersion, 1);
  assertEquals(statusPayload.daemonRunning, true);
  assertEquals(statusPayload.daemonPid, 31337);
  assertEquals(statusPayload.heartbeatAt, "2026-02-22T10:00:00.000Z");
  assertEquals(statusPayload.recordings.activeRecordings, 3);

  const stopHarness = makeRuntimeHarness(runtimeDir);
  const stopCode = await runDaemonCli(["stop"], {
    runtime: stopHarness.runtime,
    statusStore,
    controlStore: controlStore.store,
  });
  assertEquals(stopCode, 0);
  assertStringIncludes(stopHarness.stdout.join(""), "stop request queued");
  assertEquals(controlStore.requests[0]?.command, "stop");
});

Deno.test("runDaemonCli queues export and clean one-off operations", async () => {
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore();
  const runtimeDir = ".kato/test-runtime";
  const allowPathPolicy = makePathPolicyGate("allow");

  const exportHarness = makeRuntimeHarness(runtimeDir);
  const exportCode = await runDaemonCli(
    ["export", "session-42", "--output", "exports/session-42.md"],
    {
      runtime: exportHarness.runtime,
      statusStore,
      controlStore: controlStore.store,
      pathPolicyGate: allowPathPolicy,
    },
  );
  assertEquals(exportCode, 0);
  assertStringIncludes(exportHarness.stdout.join(""), "export request queued");
  assertEquals(controlStore.requests[0]?.command, "export");
  assertEquals(
    controlStore.requests[0]?.payload?.["sessionId"],
    "session-42",
  );

  const cleanHarness = makeRuntimeHarness(runtimeDir);
  const cleanCode = await runDaemonCli([
    "clean",
    "--recordings",
    "14",
    "--dry-run",
  ], {
    runtime: cleanHarness.runtime,
    statusStore,
    controlStore: controlStore.store,
    pathPolicyGate: allowPathPolicy,
  });
  assertEquals(cleanCode, 0);
  assertStringIncludes(cleanHarness.stdout.join(""), "clean request queued");
  assertEquals(controlStore.requests[1]?.command, "clean");
  assertEquals(controlStore.requests[1]?.payload?.["recordingsDays"], 14);
  assertEquals(controlStore.requests[1]?.payload?.["dryRun"], true);
});

Deno.test("runDaemonCli denies export when path policy rejects output path", async () => {
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore();
  const runtimeDir = ".kato/test-runtime";
  const denyPathPolicy = makePathPolicyGate("deny");

  const harness = makeRuntimeHarness(runtimeDir);
  const code = await runDaemonCli(
    ["export", "session-42", "--output", "../outside.md"],
    {
      runtime: harness.runtime,
      statusStore,
      controlStore: controlStore.store,
      pathPolicyGate: denyPathPolicy,
    },
  );

  assertEquals(code, 1);
  assertEquals(controlStore.requests.length, 0);
  assertStringIncludes(harness.stderr.join(""), "Export path denied by policy");
});

Deno.test("runDaemonCli stop resets stale running status without queueing", async () => {
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore({
    schemaVersion: 1,
    generatedAt: "2026-02-22T09:00:00.000Z",
    heartbeatAt: "2026-02-22T09:00:00.000Z",
    daemonRunning: true,
    daemonPid: 9999,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  });

  const harness = makeRuntimeHarness(".kato/test-runtime");
  const code = await runDaemonCli(["stop"], {
    runtime: harness.runtime,
    statusStore,
    controlStore: controlStore.store,
  });

  assertEquals(code, 0);
  assertEquals(controlStore.requests.length, 0);
  assertStringIncludes(harness.stdout.join(""), "status was stale");
});

Deno.test("runDaemonCli returns usage error code for unknown flag", async () => {
  const harness = makeRuntimeHarness(".kato/test-runtime");
  const code = await runDaemonCli(["start", "--bad-flag"], {
    runtime: harness.runtime,
    statusStore: makeInMemoryStatusStore(),
    controlStore: makeInMemoryControlStore().store,
  });

  assertEquals(code, 2);
  assertStringIncludes(harness.stderr.join(""), "Unknown flag");
});
