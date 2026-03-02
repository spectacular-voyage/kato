import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
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
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  DEFAULT_WORKSPACE_REGISTRY_FILENAME,
  makeDefaultSessionCursor,
  parseDaemonCliArgs,
  PersistentSessionStateStore,
  runDaemonCli,
  type RuntimeConfigStoreLike,
  type WritePathPolicyGateLike,
} from "../apps/daemon/src/mod.ts";
import { makeTestTempDir, removePathIfPresent } from "./test_temp.ts";

function makeRuntimeHarness(runtimeDir: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    runtime: {
      runtimeDir,
      configPath: `${runtimeDir}/kato-config.yaml`,
      statusPath: `${runtimeDir}/status.json`,
      controlPath: `${runtimeDir}/control.json`,
      cwdPath: runtimeDir,
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
      gemini: ["/sessions/gemini"],
    },
    featureFlags: createDefaultRuntimeFeatureFlags(),
    logging: {
      operationalLevel: "info",
      auditLevel: "info",
    },
    daemonMaxMemoryMb: 200,
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
        gemini: [...initial.providerSessionRoots.gemini],
      },
      featureFlags: { ...initial.featureFlags },
      logging: { ...initial.logging },
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
            gemini: [...state.providerSessionRoots.gemini],
          },
          featureFlags: { ...state.featureFlags },
          logging: { ...state.logging },
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
              gemini: [...defaultConfig.providerSessionRoots.gemini],
            },
            featureFlags: { ...defaultConfig.featureFlags },
            logging: { ...defaultConfig.logging },
          };
          return Promise.resolve({
            created: true,
            config: {
              ...state,
              allowedWriteRoots: [...state.allowedWriteRoots],
              providerSessionRoots: {
                claude: [...state.providerSessionRoots.claude],
                codex: [...state.providerSessionRoots.codex],
                gemini: [...state.providerSessionRoots.gemini],
              },
              featureFlags: { ...state.featureFlags },
              logging: { ...state.logging },
            },
            path: `${state.runtimeDir}/kato-config.yaml`,
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
              gemini: [...state.providerSessionRoots.gemini],
            },
            featureFlags: { ...state.featureFlags },
            logging: { ...state.logging },
          },
          path: `${state.runtimeDir}/kato-config.yaml`,
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
  onLaunch?: () => Promise<void> | void,
): {
  launchedCount: { value: number };
  launcher: DaemonProcessLauncherLike;
} {
  const launchedCount = { value: 0 };
  return {
    launchedCount,
    launcher: {
      async launchDetached() {
        launchedCount.value += 1;
        if (onLaunch) {
          await onLaunch();
        }
        return launchedPid;
      },
    },
  };
}

function makeStartupAckCallback(
  statusStore: DaemonStatusSnapshotStoreLike,
  daemonPid: number,
  heartbeatAt: string = "2026-02-22T10:00:00.000Z",
): () => Promise<void> {
  return async () => {
    const snapshot = await statusStore.load();
    await statusStore.save({
      ...snapshot,
      daemonRunning: true,
      daemonPid,
      generatedAt: heartbeatAt,
      heartbeatAt,
    });
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

Deno.test("cli parser accepts clean --logs", () => {
  const parsed = parseDaemonCliArgs(["clean", "--logs"]);
  assertEquals(parsed.kind, "command");
  if (parsed.kind !== "command") {
    throw new Error("expected command intent");
  }
  assertEquals(parsed.command.name, "clean");
  if (parsed.command.name !== "clean") {
    throw new Error("expected clean command");
  }
  assertEquals(parsed.command.all, true);
  assertEquals(parsed.command.dryRun, false);
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

Deno.test("cli parser accepts attach, attachments, and detach", () => {
  const attach = parseDaemonCliArgs([
    "attach",
    "abc12345",
    "--output",
    "notes/",
  ]);
  assertEquals(attach.kind, "command");
  if (attach.kind !== "command" || attach.command.name !== "attach") {
    throw new Error("expected attach command");
  }
  assertEquals(attach.command.sessionId, "abc12345");
  assertEquals(attach.command.outputPath, "notes/");

  const attachments = parseDaemonCliArgs(["attachments", "--all"]);
  assertEquals(attachments.kind, "command");
  if (
    attachments.kind !== "command" || attachments.command.name !== "attachments"
  ) {
    throw new Error("expected attachments command");
  }
  assertEquals(attachments.command.all, true);

  const detach = parseDaemonCliArgs(["detach", "abc12345"]);
  assertEquals(detach.kind, "command");
  if (detach.kind !== "command" || detach.command.name !== "detach") {
    throw new Error("expected detach command");
  }
  assertEquals(detach.command.sessionId, "abc12345");
});

Deno.test("cli parser accepts workspace commands", () => {
  const init = parseDaemonCliArgs(["workspace", "init", "nested/project"]);
  assertEquals(init.kind, "command");
  if (init.kind !== "command" || init.command.name !== "workspace-init") {
    throw new Error("expected workspace-init command");
  }
  assertEquals(init.command.dirPath, "nested/project");

  const register = parseDaemonCliArgs([
    "workspace",
    "register",
    "--alias",
    "My.Proj",
  ]);
  assertEquals(register.kind, "command");
  if (
    register.kind !== "command" ||
    register.command.name !== "workspace-register"
  ) {
    throw new Error("expected workspace-register command");
  }
  assertEquals(register.command.alias, "My.Proj");

  const list = parseDaemonCliArgs(["workspace", "list"]);
  assertEquals(list.kind, "command");
  if (list.kind !== "command" || list.command.name !== "workspace-list") {
    throw new Error("expected workspace-list command");
  }

  const unregister = parseDaemonCliArgs([
    "workspace",
    "unregister",
    "My.Proj",
  ]);
  assertEquals(unregister.kind, "command");
  if (
    unregister.kind !== "command" ||
    unregister.command.name !== "workspace-unregister"
  ) {
    throw new Error("expected workspace-unregister command");
  }
  assertEquals(unregister.command.selector, "My.Proj");
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
    `created runtime config at ${runtimeDir}/kato-config.yaml`,
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
  "runDaemonCli workspace commands manage registry without loading runtime config",
  async () => {
    const tempDir = await makeTestTempDir("daemon-cli-workspace-");
    try {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const workspaceDir = join(tempDir, "My.Proj");
      const configPath = join(
        workspaceDir,
        ".kato",
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      const registryPath = join(katoDir, DEFAULT_WORKSPACE_REGISTRY_FILENAME);
      await Deno.mkdir(workspaceDir, { recursive: true });

      const defaultRuntimeConfig: RuntimeConfig = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [workspaceDir, katoDir],
      };

      const initHarness = makeRuntimeHarness(runtimeDir);
      initHarness.runtime.cwdPath = workspaceDir;
      const initCode = await runDaemonCli(["workspace", "init"], {
        runtime: initHarness.runtime,
        defaultRuntimeConfig,
      });
      assertEquals(initCode, 0);
      assertStringIncludes(
        initHarness.stdout.join(""),
        `created workspace config at ${configPath}`,
      );
      assertStringIncludes(
        await Deno.readTextFile(configPath),
        "defaultOutputDir:",
      );

      const registerHarness = makeRuntimeHarness(runtimeDir);
      registerHarness.runtime.cwdPath = workspaceDir;
      const registerCode = await runDaemonCli(["workspace", "register"], {
        runtime: registerHarness.runtime,
        defaultRuntimeConfig,
      });
      assertEquals(registerCode, 0);
      assertStringIncludes(
        registerHarness.stdout.join(""),
        "workspace registered: My.Proj (",
      );
      assertStringIncludes(
        await Deno.readTextFile(registryPath),
        `"alias": "My.Proj"`,
      );
      const registeredRegistry = JSON.parse(
        await Deno.readTextFile(registryPath),
      ) as {
        workspaces?: Array<
          { workspaceId?: string; alias?: string; workspaceRoot?: string }
        >;
      };
      const registeredWorkspaceId = registeredRegistry.workspaces?.[0]
        ?.workspaceId;
      assertExists(registeredWorkspaceId);
      assertStringIncludes(
        await Deno.readTextFile(configPath),
        `workspaceId: ${registeredWorkspaceId}`,
      );

      const listHarness = makeRuntimeHarness(runtimeDir);
      const listCode = await runDaemonCli(["workspace", "list"], {
        runtime: listHarness.runtime,
        defaultRuntimeConfig,
      });
      assertEquals(listCode, 0);
      assertStringIncludes(listHarness.stdout.join(""), "My.Proj (");
      assertStringIncludes(listHarness.stdout.join(""), configPath);

      const movedWorkspaceDir = join(tempDir, "Moved.Proj");
      const movedConfigPath = join(
        movedWorkspaceDir,
        ".kato",
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.rename(workspaceDir, movedWorkspaceDir);
      assertExists(await Deno.stat(movedConfigPath));

      const reRegisterHarness = makeRuntimeHarness(runtimeDir);
      reRegisterHarness.runtime.cwdPath = movedWorkspaceDir;
      const reRegisterCode = await runDaemonCli(
        ["workspace", "register", "--alias", "Moved.Proj"],
        {
          runtime: reRegisterHarness.runtime,
          defaultRuntimeConfig,
        },
      );
      assertEquals(reRegisterCode, 0);
      assertStringIncludes(
        reRegisterHarness.stdout.join(""),
        "workspace registration updated: Moved.Proj (",
      );
      assertStringIncludes(
        reRegisterHarness.stdout.join(""),
        "restart required before alias/root/config-path changes are used by the running daemon",
      );
      const reRegisteredRegistry = JSON.parse(
        await Deno.readTextFile(registryPath),
      ) as {
        workspaces?: Array<
          { workspaceId?: string; alias?: string; workspaceRoot?: string }
        >;
      };
      assertEquals(reRegisteredRegistry.workspaces?.length, 1);
      assertEquals(
        reRegisteredRegistry.workspaces?.[0]?.workspaceId,
        registeredWorkspaceId,
      );
      assertEquals(reRegisteredRegistry.workspaces?.[0]?.alias, "Moved.Proj");
      assertEquals(
        reRegisteredRegistry.workspaces?.[0]?.workspaceRoot,
        movedWorkspaceDir,
      );

      const unregisterHarness = makeRuntimeHarness(runtimeDir);
      const unregisterCode = await runDaemonCli(
        ["workspace", "unregister", "Moved.Proj"],
        {
          runtime: unregisterHarness.runtime,
          defaultRuntimeConfig,
        },
      );
      assertEquals(unregisterCode, 0);
      assertStringIncludes(
        unregisterHarness.stdout.join(""),
        "workspace unregistered: Moved.Proj (",
      );

      const listAfterHarness = makeRuntimeHarness(runtimeDir);
      const listAfterCode = await runDaemonCli(["workspace", "list"], {
        runtime: listAfterHarness.runtime,
        defaultRuntimeConfig,
      });
      assertEquals(listAfterCode, 0);
      assertStringIncludes(
        listAfterHarness.stdout.join(""),
        "no registered workspaces",
      );
    } finally {
      await removePathIfPresent(tempDir);
    }
  },
);

Deno.test(
  "runDaemonCli workspace register warns when workspace root is outside current allowedWriteRoots",
  async () => {
    const tempDir = await makeTestTempDir("daemon-cli-workspace-warning-");
    try {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const workspaceDir = join(tempDir, "warn-me");
      await Deno.mkdir(workspaceDir, { recursive: true });

      const defaultRuntimeConfig: RuntimeConfig = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [katoDir],
      };

      const initHarness = makeRuntimeHarness(runtimeDir);
      initHarness.runtime.cwdPath = workspaceDir;
      assertEquals(
        await runDaemonCli(["workspace", "init"], {
          runtime: initHarness.runtime,
          defaultRuntimeConfig,
        }),
        0,
      );

      const registerHarness = makeRuntimeHarness(runtimeDir);
      registerHarness.runtime.cwdPath = workspaceDir;
      const registerCode = await runDaemonCli(["workspace", "register"], {
        runtime: registerHarness.runtime,
        defaultRuntimeConfig,
      });
      assertEquals(registerCode, 0);
      assertStringIncludes(
        registerHarness.stdout.join(""),
        "warning: the running daemon may still deny writes for this workspace until `kato restart` expands allowedWriteRoots",
      );
    } finally {
      await removePathIfPresent(tempDir);
    }
  },
);

Deno.test(
  "runDaemonCli workspace commands use the persisted runtime config when it exists",
  async () => {
    const tempDir = await makeTestTempDir("daemon-cli-workspace-config-");
    try {
      const runtimeDir = join(tempDir, "runtime");
      const workspaceDir = join(tempDir, "config-backed");
      const configuredKatoDir = join(tempDir, "configured-kato");
      const registryPath = join(
        configuredKatoDir,
        DEFAULT_WORKSPACE_REGISTRY_FILENAME,
      );
      await Deno.mkdir(workspaceDir, { recursive: true });

      const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
      const persistedRuntimeConfig: RuntimeConfig = {
        ...defaultRuntimeConfig,
        katoDir: configuredKatoDir,
        allowedWriteRoots: [workspaceDir, configuredKatoDir],
      };
      const { store: configStore } = makeInMemoryConfigStore(
        persistedRuntimeConfig,
      );

      const initHarness = makeRuntimeHarness(runtimeDir);
      initHarness.runtime.cwdPath = workspaceDir;
      assertEquals(
        await runDaemonCli(["workspace", "init"], {
          runtime: initHarness.runtime,
          defaultRuntimeConfig,
          configStore,
        }),
        0,
      );

      const registerHarness = makeRuntimeHarness(runtimeDir);
      registerHarness.runtime.cwdPath = workspaceDir;
      assertEquals(
        await runDaemonCli(["workspace", "register"], {
          runtime: registerHarness.runtime,
          defaultRuntimeConfig,
          configStore,
        }),
        0,
      );

      assertStringIncludes(
        await Deno.readTextFile(registryPath),
        `"alias": "config-backed"`,
      );

      await assertRejects(
        () =>
          Deno.stat(
            join(dirname(runtimeDir), DEFAULT_WORKSPACE_REGISTRY_FILENAME),
          ),
        Deno.errors.NotFound,
      );
    } finally {
      await removePathIfPresent(tempDir);
    }
  },
);

Deno.test(
  "runDaemonCli start auto-initializes runtime config when missing",
  async () => {
    const runtimeDir = ".kato/test-runtime";
    const harness = makeRuntimeHarness(runtimeDir);
    const statusStore = makeInMemoryStatusStore();
    const controlStore = makeInMemoryControlStore();
    const daemonLauncher = makeDaemonLauncher(
      31337,
      makeStartupAckCallback(statusStore, 31337),
    );
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
      `initialized runtime config at ${runtimeDir}/kato-config.yaml`,
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
    const daemonLauncher = makeDaemonLauncher(
      31337,
      makeStartupAckCallback(statusStore, 31337),
    );
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
      `initialized runtime config at ${runtimeDir}/kato-config.yaml`,
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

Deno.test(
  "runDaemonCli status preserves stale sessions when lastMessageAt is missing",
  async () => {
    const runtimeDir = ".kato/test-runtime";
    const harness = makeRuntimeHarness(runtimeDir);
    const statusStore = makeInMemoryStatusStore({
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: true,
      daemonPid: 4242,
      providers: [],
      recordings: {
        activeRecordings: 0,
        destinations: 0,
      },
      sessions: [
        {
          provider: "codex",
          sessionId: "missing-last-message",
          updatedAt: "2026-02-22T10:00:00.000Z",
          stale: true,
        },
      ],
    });
    const controlStore = makeInMemoryControlStore();
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );

    const code = await runDaemonCli(["status"], {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
    });

    assertEquals(code, 0);
    const output = harness.stdout.join("");
    assertStringIncludes(output, "sessions: 0 active, 1 stale");
    assertStringIncludes(output, "run with --all to show 1 stale");
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
  const daemonLauncher = makeDaemonLauncher(
    31337,
    makeStartupAckCallback(statusStore, 31337),
  );
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

Deno.test("runDaemonCli queues export and handles clean in CLI", async () => {
  const rootDir = await makeTestTempDir("daemon-cli-clean-");
  const runtimeDir = `${rootDir}/runtime`;

  try {
    await Deno.mkdir(runtimeDir, { recursive: true });
    const controlStore = makeInMemoryControlStore();
    const statusStore = makeInMemoryStatusStore();
    const allowPathPolicy = makePathPolicyGate("allow");
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );

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
    assertStringIncludes(
      exportHarness.stdout.join(""),
      "export request queued",
    );
    assertEquals(controlStore.requests[0]?.command, "export");
    assertEquals(
      controlStore.requests[0]?.payload?.["sessionId"],
      "session-42",
    );
    const exportsLogPath = `${dirname(runtimeDir)}/exports.jsonl`;
    const exportsLogRaw = await Deno.readTextFile(exportsLogPath);
    const queuedEntry = JSON.parse(exportsLogRaw.trim()) as {
      status: string;
      requestId: string;
      sessionId: string;
    };
    assertEquals(queuedEntry.status, "queued");
    assertEquals(queuedEntry.requestId, "req-1");
    assertEquals(queuedEntry.sessionId, "session-42");

    const logsDir = `${runtimeDir}/logs`;
    const operationalLogPath = `${logsDir}/operational.jsonl`;
    const auditLogPath = `${logsDir}/security-audit.jsonl`;
    await Deno.mkdir(logsDir, { recursive: true });
    await Deno.writeTextFile(operationalLogPath, '{"old":"operational"}\n');
    await Deno.writeTextFile(auditLogPath, '{"old":"audit"}\n');

    const cleanHarness = makeRuntimeHarness(runtimeDir);
    const cleanCode = await runDaemonCli(["clean", "--logs"], {
      runtime: cleanHarness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
      pathPolicyGate: allowPathPolicy,
    });
    assertEquals(cleanCode, 0);
    assertStringIncludes(cleanHarness.stdout.join(""), "clean completed");
    assertStringIncludes(cleanHarness.stdout.join(""), "logsFlushed=3");
    assertEquals(controlStore.requests.length, 1);
    assertEquals(await Deno.readTextFile(operationalLogPath), "");
    assertEquals(await Deno.readTextFile(auditLogPath), "");
    assertEquals(await Deno.readTextFile(exportsLogPath), "");
  } finally {
    await removePathIfPresent(rootDir);
  }
});

Deno.test("runDaemonCli clean --sessions removes old persisted session artifacts", async () => {
  const rootDir = await makeTestTempDir("daemon-cli-clean-sessions-");
  const runtimeDir = `${rootDir}/runtime`;

  try {
    await Deno.mkdir(runtimeDir, { recursive: true });
    const controlStore = makeInMemoryControlStore();
    const statusStore = makeInMemoryStatusStore();
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );
    const harness = makeRuntimeHarness(runtimeDir);

    const sessionsDir = `${rootDir}/sessions`;
    await Deno.mkdir(sessionsDir, { recursive: true });
    const oldMetaPath = `${sessionsDir}/old.meta.json`;
    const oldTwinPath = `${sessionsDir}/old.twin.jsonl`;
    const recentMetaPath = `${sessionsDir}/recent.meta.json`;
    const recentTwinPath = `${sessionsDir}/recent.twin.jsonl`;

    for (
      const path of [oldMetaPath, oldTwinPath, recentMetaPath, recentTwinPath]
    ) {
      await Deno.writeTextFile(path, "{}\n");
    }

    const oldTime = new Date("2026-02-01T00:00:00.000Z");
    const recentTime = new Date("2026-02-25T00:00:00.000Z");
    await Deno.utime(oldMetaPath, oldTime, oldTime);
    await Deno.utime(oldTwinPath, oldTime, oldTime);
    await Deno.utime(recentMetaPath, recentTime, recentTime);
    await Deno.utime(recentTwinPath, recentTime, recentTime);

    const code = await runDaemonCli(["clean", "--sessions", "7"], {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
    });

    assertEquals(code, 0);
    assertStringIncludes(harness.stdout.join(""), "clean completed");
    assertStringIncludes(harness.stdout.join(""), "sessionsDeleted=1");
    assertStringIncludes(harness.stdout.join(""), "sessionFilesDeleted=2");

    await assertRejects(
      () => Deno.stat(oldMetaPath),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(oldTwinPath),
      Deno.errors.NotFound,
    );
    await Deno.stat(recentMetaPath);
    await Deno.stat(recentTwinPath);
  } finally {
    await removePathIfPresent(rootDir);
  }
});

Deno.test("runDaemonCli clean --sessions dry-run reports candidate counts", async () => {
  const rootDir = await makeTestTempDir("daemon-cli-clean-sessions-dry-");
  const runtimeDir = `${rootDir}/runtime`;

  try {
    await Deno.mkdir(runtimeDir, { recursive: true });
    const controlStore = makeInMemoryControlStore();
    const statusStore = makeInMemoryStatusStore();
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );
    const harness = makeRuntimeHarness(runtimeDir);

    const sessionsDir = `${rootDir}/sessions`;
    await Deno.mkdir(sessionsDir, { recursive: true });
    const oldMetaPath = `${sessionsDir}/old.meta.json`;
    const oldTwinPath = `${sessionsDir}/old.twin.jsonl`;
    await Deno.writeTextFile(oldMetaPath, "{}\n");
    await Deno.writeTextFile(oldTwinPath, "{}\n");
    const oldTime = new Date("2026-02-01T00:00:00.000Z");
    await Deno.utime(oldMetaPath, oldTime, oldTime);
    await Deno.utime(oldTwinPath, oldTime, oldTime);

    const code = await runDaemonCli(
      ["clean", "--sessions", "7", "--dry-run"],
      {
        runtime: harness.runtime,
        defaultRuntimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      },
    );

    assertEquals(code, 0);
    assertStringIncludes(harness.stdout.join(""), "sessionsToDelete=1");
    assertStringIncludes(harness.stdout.join(""), "sessionFilesToDelete=2");
    await Deno.stat(oldMetaPath);
    await Deno.stat(oldTwinPath);
  } finally {
    await removePathIfPresent(rootDir);
  }
});

Deno.test("runDaemonCli clean --sessions refuses while daemon is running", async () => {
  const runtimeDir = ".kato/test-runtime";
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore({
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: true,
    daemonPid: 1234,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  });
  const harness = makeRuntimeHarness(runtimeDir);

  const code = await runDaemonCli(["clean", "--sessions", "7"], {
    runtime: harness.runtime,
    defaultRuntimeConfig,
    configStore,
    statusStore,
    controlStore: controlStore.store,
  });

  assertEquals(code, 1);
  assertStringIncludes(
    harness.stderr.join(""),
    "Refusing clean --sessions while daemon is running",
  );
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
  const daemonLauncher = makeDaemonLauncher(
    31337,
    makeStartupAckCallback(statusStore, 31337),
  );
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
  const daemonLauncher = makeDaemonLauncher(31337, () => {
    currentStatus = {
      ...currentStatus,
      daemonRunning: true,
      daemonPid: 31337,
      generatedAt: "2026-02-22T10:00:02.000Z",
      heartbeatAt: "2026-02-22T10:00:02.000Z",
    };
  });

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

Deno.test(
  "runDaemonCli queues attach and detach requests while attachments reads persisted state",
  async () => {
    const tempDir = await makeTestTempDir("daemon-cli-attach-");
    try {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const workspaceDir = join(tempDir, "workspace");
      const workspaceConfigDir = join(workspaceDir, ".kato");
      const notesDir = join(workspaceDir, "notes");
      await Deno.mkdir(workspaceConfigDir, { recursive: true });
      await Deno.mkdir(notesDir, { recursive: true });
      await Deno.writeTextFile(
        join(workspaceConfigDir, "kato-config.yaml"),
        [
          "defaultOutputDir: notes",
          'filenameTemplate: "{provider}-{sessionShortId}.md"',
          "featureFlags:",
          "  writerIncludeCommentary: false",
        ].join("\n") + "\n",
      );

      const runtimeConfig: RuntimeConfig = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [workspaceDir, katoDir],
      };
      const { store: configStore } = makeInMemoryConfigStore(runtimeConfig);
      const statusStore = makeInMemoryStatusStore();
      const controlStore = makeInMemoryControlStore();
      const pathPolicyGate: WritePathPolicyGateLike = {
        evaluateWritePath(targetPath: string) {
          return Promise.resolve({
            decision: "allow",
            targetPath,
            reason: "allowed-for-test",
            canonicalTargetPath: targetPath,
          });
        },
      };

      const sessionStateStore = new PersistentSessionStateStore({ katoDir });
      const created = await sessionStateStore.getOrCreateSessionMetadata({
        provider: "codex",
        providerSessionId: "provider-session-1",
        sourceFilePath: join(tempDir, "provider-session-1.jsonl"),
        initialCursor: makeDefaultSessionCursor("codex"),
      });
      const selector = created.sessionId.slice(0, 8);

      const attachHarness = makeRuntimeHarness(runtimeDir);
      attachHarness.runtime.cwdPath = workspaceDir;
      const attachCode = await runDaemonCli(
        ["attach", selector, "--output", "notes/"],
        {
          runtime: attachHarness.runtime,
          defaultRuntimeConfig: runtimeConfig,
          configStore,
          statusStore,
          controlStore: controlStore.store,
          pathPolicyGate,
        },
      );

      assertEquals(attachCode, 0);
      assertStringIncludes(
        attachHarness.stdout.join(""),
        "attach request queued: session=codex/",
      );

      assertEquals(controlStore.requests.length, 1);
      assertEquals(controlStore.requests[0]?.command, "attach");
      assertEquals(
        controlStore.requests[0]?.payload?.["sessionId"],
        created.sessionId,
      );
      assertEquals(
        controlStore.requests[0]?.payload?.["resolvedOutputPath"],
        join(notesDir, `codex-${created.sessionId.slice(0, 8)}.md`),
      );

      const afterAttachQueue =
        (await sessionStateStore.listSessionMetadata())[0];
      assertExists(afterAttachQueue);
      assertEquals(afterAttachQueue.workspaceAttachment, undefined);

      const simulatedAttached = structuredClone(afterAttachQueue);
      simulatedAttached.workspaceAttachment = {
        attachedAt: "2026-02-22T10:00:00.000Z",
        sourceConfigPath: join(workspaceConfigDir, "kato-config.yaml"),
        workspaceRoot: workspaceDir,
        resolvedDefaultOutputDir: notesDir,
        filenameTemplate: "{provider}-{sessionShortId}.md",
        writerFeatureFlags: {
          writerIncludeCommentary: false,
          writerIncludeThinking: true,
          writerIncludeToolCalls: true,
          writerItalicizeUserMessages: false,
        },
      };
      simulatedAttached.primaryRecordingDestination = join(
        notesDir,
        `codex-${created.sessionId.slice(0, 8)}.md`,
      );
      await sessionStateStore.saveSessionMetadata(simulatedAttached, {
        touchUpdatedAt: true,
      });

      const listHarness = makeRuntimeHarness(runtimeDir);
      const listCode = await runDaemonCli(["attachments"], {
        runtime: listHarness.runtime,
        defaultRuntimeConfig: runtimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      });
      assertEquals(listCode, 0);
      assertStringIncludes(listHarness.stdout.join(""), "[attached]");
      assertStringIncludes(listHarness.stdout.join(""), workspaceDir);

      const detachHarness = makeRuntimeHarness(runtimeDir);
      const detachCode = await runDaemonCli(["detach", selector], {
        runtime: detachHarness.runtime,
        defaultRuntimeConfig: runtimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      });
      assertEquals(detachCode, 0);
      assertStringIncludes(
        detachHarness.stdout.join(""),
        "detach request queued: session=codex/",
      );

      assertEquals(controlStore.requests.length, 2);
      assertEquals(controlStore.requests[1]?.command, "detach");
      assertEquals(
        controlStore.requests[1]?.payload?.["sessionId"],
        created.sessionId,
      );

      const simulatedDetached = structuredClone(
        (await sessionStateStore.listSessionMetadata())[0],
      );
      assertExists(simulatedDetached);
      delete simulatedDetached.workspaceAttachment;
      await sessionStateStore.saveSessionMetadata(simulatedDetached, {
        touchUpdatedAt: true,
      });

      const listAllHarness = makeRuntimeHarness(runtimeDir);
      const listAllCode = await runDaemonCli(["attachments", "--all"], {
        runtime: listAllHarness.runtime,
        defaultRuntimeConfig: runtimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      });
      assertEquals(listAllCode, 0);
      assertStringIncludes(listAllHarness.stdout.join(""), "[default]");
    } finally {
      await removePathIfPresent(tempDir);
    }
  },
);
