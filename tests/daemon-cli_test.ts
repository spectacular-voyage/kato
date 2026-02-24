import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { DaemonStatusSnapshot, RuntimeConfig } from "@kato/shared";
import {
  CliUsageError,
  createDefaultRuntimeFeatureFlags,
  DAEMON_APP_VERSION,
  type DaemonControlRequest,
  type DaemonControlRequestDraft,
  type DaemonControlRequestStoreLike,
  type DaemonProcessLauncherLike,
  type DaemonStatusSnapshotStoreLike,
  parseDaemonCliArgs,
  runDaemonCli,
  type RuntimeConfigStoreLike,
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
      configPath: `${runtimeDir}/config.json`,
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

function makeDefaultRuntimeConfig(runtimeDir: string): RuntimeConfig {
  return {
    schemaVersion: 1,
    runtimeDir,
    statusPath: `${runtimeDir}/status.json`,
    controlPath: `${runtimeDir}/control.json`,
    allowedWriteRoots: [runtimeDir],
    providerSessionRoots: {
      claude: ["/sessions/claude"],
      codex: ["/sessions/codex"],
    },
    featureFlags: createDefaultRuntimeFeatureFlags(),
  };
}

function makeInMemoryConfigStore(initial?: RuntimeConfig): {
  ensureCalls: { value: number };
  store: RuntimeConfigStoreLike;
} {
  let state = initial
    ? {
      ...initial,
      allowedWriteRoots: [...initial.allowedWriteRoots],
      providerSessionRoots: {
        claude: [...initial.providerSessionRoots.claude],
        codex: [...initial.providerSessionRoots.codex],
      },
      featureFlags: { ...initial.featureFlags },
    }
    : undefined;
  const ensureCalls = { value: 0 };

  return {
    ensureCalls,
    store: {
      load() {
        if (!state) {
          return Promise.reject(new Deno.errors.NotFound("missing config"));
        }
        return Promise.resolve({
          ...state,
          allowedWriteRoots: [...state.allowedWriteRoots],
          providerSessionRoots: {
            claude: [...state.providerSessionRoots.claude],
            codex: [...state.providerSessionRoots.codex],
          },
          featureFlags: { ...state.featureFlags },
        });
      },
      ensureInitialized(defaultConfig: RuntimeConfig) {
        ensureCalls.value += 1;
        if (!state) {
          state = {
            ...defaultConfig,
            allowedWriteRoots: [...defaultConfig.allowedWriteRoots],
            providerSessionRoots: {
              claude: [...defaultConfig.providerSessionRoots.claude],
              codex: [...defaultConfig.providerSessionRoots.codex],
            },
            featureFlags: { ...defaultConfig.featureFlags },
          };
          return Promise.resolve({
            created: true,
            config: {
              ...state,
              allowedWriteRoots: [...state.allowedWriteRoots],
              providerSessionRoots: {
                claude: [...state.providerSessionRoots.claude],
                codex: [...state.providerSessionRoots.codex],
              },
              featureFlags: { ...state.featureFlags },
            },
            path: `${state.runtimeDir}/config.json`,
          });
        }

        return Promise.resolve({
          created: false,
          config: {
            ...state,
            allowedWriteRoots: [...state.allowedWriteRoots],
            providerSessionRoots: {
              claude: [...state.providerSessionRoots.claude],
              codex: [...state.providerSessionRoots.codex],
            },
            featureFlags: { ...state.featureFlags },
          },
          path: `${state.runtimeDir}/config.json`,
        });
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

Deno.test("cli parser accepts init", () => {
  const parsed = parseDaemonCliArgs(["init"]);
  assertEquals(parsed.kind, "command");
  if (parsed.kind !== "command") {
    return;
  }

  assertEquals(parsed.command.name, "init");
});

Deno.test("cli parser accepts --version and -V", () => {
  const longFlag = parseDaemonCliArgs(["--version"]);
  assertEquals(longFlag.kind, "version");

  const shortFlag = parseDaemonCliArgs(["-V"]);
  assertEquals(shortFlag.kind, "version");
});

Deno.test("cli parser accepts restart", () => {
  const parsed = parseDaemonCliArgs(["restart"]);
  assertEquals(parsed.kind, "command");
  if (parsed.kind !== "command") {
    return;
  }

  assertEquals(parsed.command.name, "restart");
});

Deno.test("runDaemonCli prints version without loading config", async () => {
  const harness = makeRuntimeHarness(".kato/test-runtime");

  const code = await runDaemonCli(["--version"], {
    runtime: harness.runtime,
  });

  assertEquals(code, 0);
  assertEquals(harness.stderr.join(""), "");
  assertStringIncludes(harness.stdout.join(""), `kato ${DAEMON_APP_VERSION}`);
});

Deno.test("runDaemonCli help includes version and tagline", async () => {
  const harness = makeRuntimeHarness(".kato/test-runtime");

  const code = await runDaemonCli(["help"], {
    runtime: harness.runtime,
  });

  assertEquals(code, 0);
  assertEquals(harness.stderr.join(""), "");
  assertStringIncludes(harness.stdout.join(""), `kato ${DAEMON_APP_VERSION}`);
  assertStringIncludes(harness.stdout.join(""), "Own your AI conversations.");
  assertStringIncludes(
    harness.stdout.join(""),
    "Usage: kato <command> [options]",
  );
});

Deno.test("runDaemonCli help topic includes version and tagline", async () => {
  const harness = makeRuntimeHarness(".kato/test-runtime");

  const code = await runDaemonCli(["help", "start"], {
    runtime: harness.runtime,
  });

  assertEquals(code, 0);
  assertEquals(harness.stderr.join(""), "");
  assertStringIncludes(harness.stdout.join(""), `kato ${DAEMON_APP_VERSION}`);
  assertStringIncludes(harness.stdout.join(""), "Own your AI conversations.");
  assertStringIncludes(harness.stdout.join(""), "Usage: kato start");
});

Deno.test("runDaemonCli init creates runtime config when missing", async () => {
  const runtimeDir = ".kato/test-runtime";
  const harness = makeRuntimeHarness(runtimeDir);
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { ensureCalls, store: configStore } = makeInMemoryConfigStore();
  const statusStore = makeInMemoryStatusStore();
  const controlStore = makeInMemoryControlStore();

  const firstCode = await runDaemonCli(["init"], {
    runtime: harness.runtime,
    defaultRuntimeConfig,
    configStore,
    statusStore,
    controlStore: controlStore.store,
  });
  assertEquals(firstCode, 0);
  assertStringIncludes(
    harness.stdout.join(""),
    `created runtime config at ${runtimeDir}/config.json`,
  );
  assertEquals(ensureCalls.value, 1);

  const secondHarness = makeRuntimeHarness(runtimeDir);
  const secondCode = await runDaemonCli(["init"], {
    runtime: secondHarness.runtime,
    defaultRuntimeConfig,
    configStore,
    statusStore,
    controlStore: controlStore.store,
  });
  assertEquals(secondCode, 0);
  assertStringIncludes(secondHarness.stdout.join(""), "already exists");
  assertEquals(ensureCalls.value, 2);
});

Deno.test(
  "runDaemonCli start auto-initializes runtime config when missing",
  async () => {
    const runtimeDir = ".kato/test-runtime";
    const harness = makeRuntimeHarness(runtimeDir);
    const statusStore = makeInMemoryStatusStore();
    const controlStore = makeInMemoryControlStore();
    const daemonLauncher = makeDaemonLauncher(31337);
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { ensureCalls, store: configStore } = makeInMemoryConfigStore();

    const code = await runDaemonCli(["start"], {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
      daemonLauncher: daemonLauncher.launcher,
      autoInitOnStart: true,
    });

    assertEquals(code, 0);
    assertStringIncludes(
      harness.stdout.join(""),
      `initialized runtime config at ${runtimeDir}/config.json`,
    );
    assertStringIncludes(harness.stdout.join(""), "started in background");
    assertEquals(ensureCalls.value, 1);
  },
);

Deno.test(
  "runDaemonCli restart auto-initializes runtime config when missing",
  async () => {
    const runtimeDir = ".kato/test-runtime";
    const harness = makeRuntimeHarness(runtimeDir);
    const statusStore = makeInMemoryStatusStore();
    const controlStore = makeInMemoryControlStore();
    const daemonLauncher = makeDaemonLauncher(31337);
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { ensureCalls, store: configStore } = makeInMemoryConfigStore();

    const code = await runDaemonCli(["restart"], {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
      daemonLauncher: daemonLauncher.launcher,
      autoInitOnStart: true,
    });

    assertEquals(code, 0);
    assertStringIncludes(
      harness.stdout.join(""),
      `initialized runtime config at ${runtimeDir}/config.json`,
    );
    assertStringIncludes(harness.stdout.join(""), "started in background");
    assertEquals(ensureCalls.value, 1);
  },
);

Deno.test(
  "runDaemonCli fails closed when config is missing for non-start commands",
  async () => {
    const runtimeDir = ".kato/test-runtime";
    const harness = makeRuntimeHarness(runtimeDir);
    const statusStore = makeInMemoryStatusStore();
    const controlStore = makeInMemoryControlStore();
    const { store: configStore } = makeInMemoryConfigStore();

    const code = await runDaemonCli(["status"], {
      runtime: harness.runtime,
      configStore,
      statusStore,
      controlStore: controlStore.store,
    });

    assertEquals(code, 1);
    assertStringIncludes(harness.stderr.join(""), "Run `kato init` first");
  },
);

Deno.test(
  "runDaemonCli start fails when auto-init is disabled and config is missing",
  async () => {
    const runtimeDir = ".kato/test-runtime";
    const harness = makeRuntimeHarness(runtimeDir);
    const statusStore = makeInMemoryStatusStore();
    const controlStore = makeInMemoryControlStore();
    const { store: configStore } = makeInMemoryConfigStore();

    const code = await runDaemonCli(["start"], {
      runtime: harness.runtime,
      configStore,
      statusStore,
      controlStore: controlStore.store,
      autoInitOnStart: false,
    });

    assertEquals(code, 1);
    assertStringIncludes(harness.stderr.join(""), "Run `kato init` first");
  },
);

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
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);

  const startHarness = makeRuntimeHarness(runtimeDir);
  const startCode = await runDaemonCli(["start"], {
    runtime: startHarness.runtime,
    defaultRuntimeConfig,
    configStore,
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
    defaultRuntimeConfig,
    configStore,
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
    defaultRuntimeConfig,
    configStore,
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
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);

  const exportHarness = makeRuntimeHarness(runtimeDir);
  const exportCode = await runDaemonCli(
    ["export", "session-42", "--output", "exports/session-42.md"],
    {
      runtime: exportHarness.runtime,
      defaultRuntimeConfig,
      configStore,
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
    defaultRuntimeConfig,
    configStore,
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
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);

  const harness = makeRuntimeHarness(runtimeDir);
  const code = await runDaemonCli(
    ["export", "session-42", "--output", "../outside.md"],
    {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
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
  const runtimeDir = ".kato/test-runtime";
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);

  const harness = makeRuntimeHarness(runtimeDir);
  const code = await runDaemonCli(["stop"], {
    runtime: harness.runtime,
    defaultRuntimeConfig,
    configStore,
    statusStore,
    controlStore: controlStore.store,
  });

  assertEquals(code, 0);
  assertEquals(controlStore.requests.length, 0);
  assertStringIncludes(harness.stdout.join(""), "status was stale");
});

Deno.test("runDaemonCli restart starts daemon when not running", async () => {
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore();
  const daemonLauncher = makeDaemonLauncher(31337);
  const runtimeDir = ".kato/test-runtime";
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);

  const harness = makeRuntimeHarness(runtimeDir);
  const code = await runDaemonCli(["restart"], {
    runtime: harness.runtime,
    defaultRuntimeConfig,
    configStore,
    statusStore,
    controlStore: controlStore.store,
    daemonLauncher: daemonLauncher.launcher,
  });

  assertEquals(code, 0);
  assertEquals(controlStore.requests.length, 0);
  assertEquals(daemonLauncher.launchedCount.value, 1);
  assertStringIncludes(harness.stdout.join(""), "started in background");
});

Deno.test("runDaemonCli restart queues stop and then starts daemon when running", async () => {
  const runtimeDir = ".kato/test-runtime";
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);
  const daemonLauncher = makeDaemonLauncher(31337);

  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: true,
    daemonPid: 9999,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };
  let loadCount = 0;
  let stopQueued = false;

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      loadCount += 1;
      if (
        stopQueued &&
        loadCount >= 3 &&
        currentStatus.daemonRunning &&
        currentStatus.daemonPid === 9999
      ) {
        const { daemonPid: _ignoredDaemonPid, ...rest } = currentStatus;
        currentStatus = {
          ...rest,
          daemonRunning: false,
          generatedAt: "2026-02-22T10:00:01.000Z",
          heartbeatAt: "2026-02-22T10:00:01.000Z",
        };
      }

      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(next: DaemonStatusSnapshot) {
      currentStatus = {
        ...next,
        providers: [...next.providers],
        recordings: { ...next.recordings },
      };
      return Promise.resolve();
    },
  };

  const controlRequests: DaemonControlRequest[] = [];
  let requestCounter = 0;
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(
        controlRequests.map((request) => ({
          ...request,
          ...(request.payload ? { payload: { ...request.payload } } : {}),
        })),
      );
    },
    enqueue(draft: DaemonControlRequestDraft) {
      requestCounter += 1;
      const request: DaemonControlRequest = {
        requestId: `req-${requestCounter}`,
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: draft.command,
        ...(draft.payload ? { payload: { ...draft.payload } } : {}),
      };
      controlRequests.push(request);
      if (draft.command === "stop") {
        stopQueued = true;
      }
      return Promise.resolve({
        ...request,
        ...(request.payload ? { payload: { ...request.payload } } : {}),
      });
    },
    markProcessed(requestId: string) {
      const index = controlRequests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        controlRequests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const harness = makeRuntimeHarness(runtimeDir);
  const code = await runDaemonCli(["restart"], {
    runtime: harness.runtime,
    defaultRuntimeConfig,
    configStore,
    statusStore,
    controlStore,
    daemonLauncher: daemonLauncher.launcher,
  });

  assertEquals(code, 0);
  assertEquals(controlRequests.length, 1);
  assertEquals(controlRequests[0]?.command, "stop");
  assertEquals(daemonLauncher.launchedCount.value, 1);
  assertStringIncludes(harness.stdout.join(""), "stop request queued");
  assertStringIncludes(harness.stdout.join(""), "started in background");
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
