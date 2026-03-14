import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import type {
  DaemonStatusSnapshot,
  ExportFeatureFlags,
  MarkdownFrontmatterConfig,
  RuntimeConfig as DaemonRuntimeConfig,
  UserConfig,
} from "@kato/shared";
import {
  createDefaultDaemonFeatureFlags,
  createDefaultExportFeatureFlags,
  createDefaultRuntimeMarkdownFrontmatterConfig,
  createDefaultUserConfig,
  type DaemonControlRequest,
  type DaemonControlRequestDraft,
  type DaemonControlRequestStoreLike,
  type DaemonProcessLauncherLike,
  type DaemonStatusSnapshotStoreLike,
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  resolveDefaultWorkspaceRegistryPath,
  resolveDefaultWorkspaceTemplateConfigPath,
  type RuntimeConfigStoreLike,
  UserConfigFileStore,
  type UserConfigStoreLike,
  type WritePathPolicyGateLike,
} from "../apps/daemon/src/mod.ts";
import {
  createDefaultWebConfig,
  createDefaultWebServerStatus,
  PersistentSessionStateStore,
} from "../apps/runtime/src/mod.ts";
import {
  CliUsageError,
  parseDaemonCliArgs,
  runDaemonCli,
  type RunDaemonCliOptions,
} from "../apps/cli/src/mod.ts";
import { getStatusRecentErrorKey } from "../apps/cli/src/commands/status.ts";
import {
  loadSuppressedRecentErrorKeys,
  resolveStatusErrorCursorPath,
  saveSuppressedRecentErrorKeys,
} from "../apps/cli/src/commands/status_error_cursor.ts";
import { CLI_APP_VERSION } from "../apps/cli/src/version.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { resolveTestTempPath, withTestTempDir } from "./test_temp.ts";

const DAEMON_CLI_ACTIVE_OUTPUT_PATH = resolveTestTempPath(
  "daemon-cli",
  "active.md",
);
const DAEMON_CLI_STALE_OUTPUT_PATH = resolveTestTempPath(
  "daemon-cli",
  "stale.md",
);

type DaemonCliRuntimeConfigFixture = DaemonRuntimeConfig & {
  statusPath: string;
  controlPath: string;
  allowedWriteRoots: string[];
  exportTimezone?: string;
  exportMarkdownFrontmatter: MarkdownFrontmatterConfig;
  exportFeatureFlags: ExportFeatureFlags;
};

function makeRuntimeHarness(runtimeDir: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    runtime: {
      runtimeDir,
      configPath: `${runtimeDir}/kato-daemon-config.yaml`,
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

type RunDaemonCliHarnessOptions =
  & Omit<
    RunDaemonCliOptions,
    "runtime"
  >
  & {
    cwdPath?: string;
  };

async function runDaemonCliWithHarness(
  args: string[],
  runtimeDir: string,
  options: RunDaemonCliHarnessOptions,
): Promise<{ code: number; harness: ReturnType<typeof makeRuntimeHarness> }> {
  const { cwdPath, ...cliOptions } = options;
  const harness = makeRuntimeHarness(runtimeDir);
  if (cwdPath) {
    harness.runtime.cwdPath = cwdPath;
  }
  const code = await runDaemonCli(args, {
    runtime: harness.runtime,
    ...cliOptions,
  });
  return { code, harness };
}

function makeDefaultRuntimeConfig(
  runtimeDir: string,
): DaemonCliRuntimeConfigFixture {
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
    daemonFeatureFlags: createDefaultDaemonFeatureFlags(),
    exportMarkdownFrontmatter: createDefaultRuntimeMarkdownFrontmatterConfig(),
    exportFeatureFlags: createDefaultExportFeatureFlags(),
    logging: {
      operationalLevel: "info",
      auditLevel: "info",
    },
    daemonMaxMemoryMb: 200,
  };
}

function makeInMemoryConfigStore(initial?: DaemonCliRuntimeConfigFixture): {
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
      daemonFeatureFlags: { ...initial.daemonFeatureFlags },
      exportMarkdownFrontmatter: { ...initial.exportMarkdownFrontmatter },
      exportFeatureFlags: { ...initial.exportFeatureFlags },
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
          daemonFeatureFlags: { ...state.daemonFeatureFlags },
          exportMarkdownFrontmatter: { ...state.exportMarkdownFrontmatter },
          exportFeatureFlags: { ...state.exportFeatureFlags },
          logging: { ...state.logging },
        });
      },
      ensureInitialized(defaultConfig: DaemonCliRuntimeConfigFixture) {
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
            daemonFeatureFlags: { ...defaultConfig.daemonFeatureFlags },
            exportMarkdownFrontmatter: {
              ...defaultConfig.exportMarkdownFrontmatter,
            },
            exportFeatureFlags: { ...defaultConfig.exportFeatureFlags },
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
              daemonFeatureFlags: { ...state.daemonFeatureFlags },
              exportMarkdownFrontmatter: { ...state.exportMarkdownFrontmatter },
              exportFeatureFlags: { ...state.exportFeatureFlags },
              logging: { ...state.logging },
            },
            path: `${state.runtimeDir}/kato-daemon-config.yaml`,
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
            daemonFeatureFlags: { ...state.daemonFeatureFlags },
            exportMarkdownFrontmatter: { ...state.exportMarkdownFrontmatter },
            exportFeatureFlags: { ...state.exportFeatureFlags },
            logging: { ...state.logging },
          },
          path: `${state.runtimeDir}/kato-daemon-config.yaml`,
        });
      },
    },
  };
}

function makeInMemoryUserConfigStore(
  initial?: UserConfig,
  path = ".test-tmp/kato-user-config.yaml",
): {
  ensureCalls: { value: number };
  saveCalls: { value: number };
  store: UserConfigStoreLike;
  snapshot(): UserConfig;
} {
  let state: UserConfig | undefined = initial
    ? {
      schemaVersion: initial.schemaVersion,
      participants: {
        defaultUsername: initial.participants.defaultUsername,
        workspaceUsernames: { ...initial.participants.workspaceUsernames },
        excludeMeFromParticipantList:
          initial.participants.excludeMeFromParticipantList,
      },
    }
    : undefined;
  const ensureCalls = { value: 0 };
  const saveCalls = { value: 0 };

  return {
    ensureCalls,
    saveCalls,
    snapshot() {
      if (!state) {
        return createDefaultUserConfig();
      }
      return {
        schemaVersion: state.schemaVersion,
        participants: {
          defaultUsername: state.participants.defaultUsername,
          workspaceUsernames: { ...state.participants.workspaceUsernames },
          excludeMeFromParticipantList:
            state.participants.excludeMeFromParticipantList,
        },
      };
    },
    store: {
      load() {
        if (!state) {
          return Promise.reject(
            new Deno.errors.NotFound("missing user config"),
          );
        }
        return Promise.resolve({
          schemaVersion: state.schemaVersion,
          participants: {
            defaultUsername: state.participants.defaultUsername,
            workspaceUsernames: { ...state.participants.workspaceUsernames },
            excludeMeFromParticipantList:
              state.participants.excludeMeFromParticipantList,
          },
        });
      },
      ensureInitialized(defaultConfig = createDefaultUserConfig()) {
        ensureCalls.value += 1;
        if (!state) {
          state = {
            schemaVersion: defaultConfig.schemaVersion,
            participants: {
              defaultUsername: defaultConfig.participants.defaultUsername,
              workspaceUsernames: {
                ...defaultConfig.participants.workspaceUsernames,
              },
              excludeMeFromParticipantList:
                defaultConfig.participants.excludeMeFromParticipantList,
            },
          };
          return Promise.resolve({
            created: true,
            config: {
              schemaVersion: state.schemaVersion,
              participants: {
                defaultUsername: state.participants.defaultUsername,
                workspaceUsernames: {
                  ...state.participants.workspaceUsernames,
                },
                excludeMeFromParticipantList:
                  state.participants.excludeMeFromParticipantList,
              },
            },
            path,
          });
        }
        return Promise.resolve({
          created: false,
          config: {
            schemaVersion: state.schemaVersion,
            participants: {
              defaultUsername: state.participants.defaultUsername,
              workspaceUsernames: { ...state.participants.workspaceUsernames },
              excludeMeFromParticipantList:
                state.participants.excludeMeFromParticipantList,
            },
          },
          path,
        });
      },
      save(config: UserConfig) {
        saveCalls.value += 1;
        state = {
          schemaVersion: config.schemaVersion,
          participants: {
            defaultUsername: config.participants.defaultUsername,
            workspaceUsernames: { ...config.participants.workspaceUsernames },
            excludeMeFromParticipantList:
              config.participants.excludeMeFromParticipantList,
          },
        };
        return Promise.resolve();
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

function makeInMemoryWebStatusStore(
  initial = createDefaultWebServerStatus(new Date("2026-02-22T10:00:00.000Z")),
) {
  let state = { ...initial };
  return {
    load() {
      return Promise.resolve({ ...state });
    },
    save(next: typeof initial) {
      state = { ...next };
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

async function withMockedDateNow<T>(
  nowValues: number[],
  run: () => Promise<T>,
): Promise<T> {
  if (!nowValues || nowValues.length === 0) {
    throw new Error(
      "withMockedDateNow requires nowValues to include at least one value for sequence and Date.now fallback",
    );
  }
  const originalDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
  const sequence = [...nowValues];
  const fallback = nowValues[nowValues.length - 1] ?? 0;
  Object.defineProperty(Date, "now", {
    configurable: true,
    value: () => sequence.shift() ?? fallback,
  });
  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(Date, "now", originalDescriptor);
    }
  }
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

Deno.test("cli parser rejects removed attach-era commands", () => {
  assertThrows(() => parseDaemonCliArgs(["attach", "abc12345"]), CliUsageError);
  assertThrows(() => parseDaemonCliArgs(["attachments"]), CliUsageError);
  assertThrows(() => parseDaemonCliArgs(["detach", "abc12345"]), CliUsageError);
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
  ]);
  assertEquals(register.kind, "command");
  if (
    register.kind !== "command" ||
    register.command.name !== "workspace-register"
  ) {
    throw new Error("expected workspace-register command");
  }
  assertEquals(register.command.alias, undefined);
  const registerWithDir = parseDaemonCliArgs([
    "workspace",
    "register",
    "nested/project",
    "--alias",
    "Nested.Proj",
  ]);
  assertEquals(registerWithDir.kind, "command");
  if (
    registerWithDir.kind !== "command" ||
    registerWithDir.command.name !== "workspace-register"
  ) {
    throw new Error("expected workspace-register command with explicit dir");
  }
  assertEquals(registerWithDir.command.alias, "Nested.Proj");
  assertEquals(registerWithDir.command.dirPath, "nested/project");

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

Deno.test("cli parser preserves Windows-style workspace register path input", () => {
  const parsed = parseDaemonCliArgs([
    "workspace",
    "register",
    "C:\\Users\\tester\\proj\\",
    "--alias",
    "Win.Proj",
  ]);
  assertEquals(parsed.kind, "command");
  if (
    parsed.kind !== "command" || parsed.command.name !== "workspace-register"
  ) {
    throw new Error("expected workspace-register command");
  }
  assertEquals(parsed.command.dirPath, "C:\\Users\\tester\\proj\\");
  assertEquals(parsed.command.alias, "Win.Proj");
});

Deno.test("cli parser allows workspace register without alias", () => {
  const parsed = parseDaemonCliArgs(["workspace", "register"]);
  assertEquals(parsed.kind, "command");
  if (
    parsed.kind !== "command" || parsed.command.name !== "workspace-register"
  ) {
    throw new Error("expected workspace-register command");
  }
  assertEquals(parsed.command.alias, undefined);
});

Deno.test("cli parser accepts user commands", () => {
  const init = parseDaemonCliArgs(["user", "init"]);
  assertEquals(init.kind, "command");
  if (init.kind !== "command" || init.command.name !== "user-init") {
    throw new Error("expected user-init command");
  }

  const mapSet = parseDaemonCliArgs([
    "user",
    "map",
    "set",
    "My.Proj",
    "Dj Radon",
  ]);
  assertEquals(mapSet.kind, "command");
  if (mapSet.kind !== "command" || mapSet.command.name !== "user-map-set") {
    throw new Error("expected user-map-set command");
  }
  assertEquals(mapSet.command.selector, "My.Proj");
  assertEquals(mapSet.command.username, "Dj Radon");

  const mapList = parseDaemonCliArgs(["user", "map", "list", "--json"]);
  assertEquals(mapList.kind, "command");
  if (mapList.kind !== "command" || mapList.command.name !== "user-map-list") {
    throw new Error("expected user-map-list command");
  }
  assertEquals(mapList.command.asJson, true);

  const excludeMe = parseDaemonCliArgs(["user", "exclude-me", "false"]);
  assertEquals(excludeMe.kind, "command");
  if (
    excludeMe.kind !== "command" || excludeMe.command.name !== "user-exclude-me"
  ) {
    throw new Error("expected user-exclude-me command");
  }
  assertEquals(excludeMe.command.value, false);
});

Deno.test("cli parser treats top-level user help flags as help", () => {
  const longHelp = parseDaemonCliArgs(["user", "--help"]);
  assertEquals(longHelp, { kind: "help", topic: "user" });

  const shortHelp = parseDaemonCliArgs(["user", "-h"]);
  assertEquals(shortHelp, { kind: "help", topic: "user" });
});

Deno.test("runDaemonCli prints version without loading config", async () => {
  const harness = makeRuntimeHarness(".kato/test-runtime");

  const code = await runDaemonCli(["--version"], {
    runtime: harness.runtime,
  });

  assertEquals(code, 0);
  assertEquals(harness.stderr.join(""), "");
  assertStringIncludes(harness.stdout.join(""), `kato ${CLI_APP_VERSION}`);
});

Deno.test("runDaemonCli help includes version and tagline", async () => {
  const harness = makeRuntimeHarness(".kato/test-runtime");

  const code = await runDaemonCli(["help"], {
    runtime: harness.runtime,
  });

  assertEquals(code, 0);
  assertEquals(harness.stderr.join(""), "");
  assertStringIncludes(harness.stdout.join(""), `kato ${CLI_APP_VERSION}`);
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
  assertStringIncludes(harness.stdout.join(""), `kato ${CLI_APP_VERSION}`);
  assertStringIncludes(harness.stdout.join(""), "Own your AI conversations.");
  assertStringIncludes(harness.stdout.join(""), "Usage: kato start");
});

Deno.test("runDaemonCli init creates both global config files when missing", async () => {
  await withTestTempDir("daemon-cli-init-", async (runtimeDir) => {
    const harness = makeRuntimeHarness(runtimeDir);
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { ensureCalls, store: configStore } = makeInMemoryConfigStore();
    const {
      ensureCalls: userEnsureCalls,
      store: userConfigStore,
    } = makeInMemoryUserConfigStore(
      undefined,
      `${runtimeDir}/kato-user-config.yaml`,
    );
    const statusStore = makeInMemoryStatusStore();
    const controlStore = makeInMemoryControlStore();

    const firstCode = await runDaemonCli(["init"], {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      userConfigStore,
      statusStore,
      controlStore: controlStore.store,
    });
    assertEquals(firstCode, 0);
    assertStringIncludes(
      harness.stdout.join(""),
      `created runtime config at ${runtimeDir}/kato-daemon-config.yaml`,
    );
    assertStringIncludes(
      harness.stdout.join(""),
      resolveDefaultWorkspaceTemplateConfigPath(dirname(runtimeDir)),
    );
    assertStringIncludes(
      harness.stdout.join(""),
      `created user config at ${runtimeDir}/kato-user-config.yaml`,
    );
    assertEquals(ensureCalls.value, 1);
    assertEquals(userEnsureCalls.value, 1);

    const secondHarness = makeRuntimeHarness(runtimeDir);
    const secondCode = await runDaemonCli(["init"], {
      runtime: secondHarness.runtime,
      defaultRuntimeConfig,
      configStore,
      userConfigStore,
      statusStore,
      controlStore: controlStore.store,
    });
    assertEquals(secondCode, 0);
    assertStringIncludes(secondHarness.stdout.join(""), "already exists");
    assertEquals(ensureCalls.value, 2);
    assertEquals(userEnsureCalls.value, 2);
  });
});

Deno.test(
  "runDaemonCli init defaults allowedWriteRoots to an empty list",
  async () => {
    await withTestTempDir(
      "daemon-cli-init-empty-roots-",
      async (runtimeDir) => {
        const harness = makeRuntimeHarness(runtimeDir);
        const userConfigStore = new UserConfigFileStore(
          join(runtimeDir, "kato-user-config.yaml"),
        );
        const code = await runDaemonCli(["init"], {
          runtime: harness.runtime,
          userConfigStore,
        });
        assertEquals(code, 0);
        const runtimeConfig = await Deno.readTextFile(
          join(runtimeDir, "kato-daemon-config.yaml"),
        );
        assertEquals(runtimeConfig.includes("allowedWriteRoots:"), false);
        const sharedConfig = await Deno.readTextFile(
          join(dirname(runtimeDir), "shared", "kato-shared-config.yaml"),
        );
        assertStringIncludes(sharedConfig, "allowedWriteRoots: []");
      },
    );
  },
);

Deno.test(
  "runDaemonCli workspace commands manage registry without loading runtime config",
  async () => {
    await withTestTempDir("daemon-cli-workspace-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const workspaceDir = join(tempDir, "My.Proj");
      const configPath = join(
        workspaceDir,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
      await Deno.mkdir(workspaceDir, { recursive: true });

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [workspaceDir, katoDir],
      };

      const { code: initCode, harness: initHarness } =
        await runDaemonCliWithHarness(["workspace", "init"], runtimeDir, {
          cwdPath: workspaceDir,
          defaultRuntimeConfig,
        });
      assertEquals(initCode, 0);
      assertStringIncludes(
        initHarness.stdout.join(""),
        `created workspace config at ${configPath}`,
      );
      const initializedConfig = await Deno.readTextFile(configPath);
      const initializedWorkspaceIdMatch = initializedConfig.match(
        /^workspaceId:\s+([^\n]+)$/m,
      );
      assertExists(initializedWorkspaceIdMatch);
      const initializedWorkspaceId = initializedWorkspaceIdMatch[1];
      assertExists(initializedWorkspaceId);
      assertStringIncludes(
        initializedConfig,
        'defaultOutputDir: "."',
      );
      assertStringIncludes(
        initializedConfig,
        "writerIncludeToolResults: false",
      );
      assertStringIncludes(
        initializedConfig,
        "writerIncludeDecisionPrompt: true",
      );
      assertStringIncludes(
        initializedConfig,
        "includeSessionIds: false",
      );
      assertStringIncludes(
        initializedConfig,
        "includeWorkspaceIds: false",
      );
      assertStringIncludes(
        initializedConfig,
        "includeRecordingIds: false",
      );

      const { code: registerCode, harness: registerHarness } =
        await runDaemonCliWithHarness(
          [
            "workspace",
            "register",
            "--alias",
            "My.Proj",
            "--no-restart",
          ],
          runtimeDir,
          {
            cwdPath: workspaceDir,
            defaultRuntimeConfig,
          },
        );
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
      assertEquals(registeredWorkspaceId, initializedWorkspaceId);
      assertStringIncludes(
        await Deno.readTextFile(configPath),
        `workspaceId: ${registeredWorkspaceId}`,
      );

      const { code: listCode, harness: listHarness } =
        await runDaemonCliWithHarness(["workspace", "list"], runtimeDir, {
          defaultRuntimeConfig,
        });
      assertEquals(listCode, 0);
      assertStringIncludes(listHarness.stdout.join(""), "My.Proj (");
      assertStringIncludes(listHarness.stdout.join(""), configPath);

      const movedWorkspaceDir = join(tempDir, "Moved.Proj");
      const movedConfigPath = join(
        movedWorkspaceDir,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.rename(workspaceDir, movedWorkspaceDir);
      assertExists(await Deno.stat(movedConfigPath));

      const { code: reRegisterCode, harness: reRegisterHarness } =
        await runDaemonCliWithHarness(
          ["workspace", "register", "--alias", "Moved.Proj", "--no-restart"],
          runtimeDir,
          {
            cwdPath: movedWorkspaceDir,
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

      const { code: unregisterCode, harness: unregisterHarness } =
        await runDaemonCliWithHarness(
          ["workspace", "unregister", "Moved.Proj"],
          runtimeDir,
          { defaultRuntimeConfig },
        );
      assertEquals(unregisterCode, 0);
      assertStringIncludes(
        unregisterHarness.stdout.join(""),
        "workspace unregistered: Moved.Proj (",
      );

      const { code: listAfterCode, harness: listAfterHarness } =
        await runDaemonCliWithHarness(["workspace", "list"], runtimeDir, {
          defaultRuntimeConfig,
        });
      assertEquals(listAfterCode, 0);
      assertStringIncludes(
        listAfterHarness.stdout.join(""),
        "no registered workspaces",
      );
    });
  },
);

Deno.test(
  "runDaemonCli workspace register accepts an explicit target directory",
  async () => {
    await withTestTempDir("daemon-cli-workspace-explicit-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const workspaceDir = join(tempDir, "explicit-target");
      const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
      await Deno.mkdir(workspaceDir, { recursive: true });

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [tempDir, katoDir],
      };

      assertEquals(
        (
          await runDaemonCliWithHarness(
            ["workspace", "init", "explicit-target"],
            runtimeDir,
            {
              cwdPath: tempDir,
              defaultRuntimeConfig,
            },
          )
        ).code,
        0,
      );

      assertEquals(
        (
          await runDaemonCliWithHarness(
            [
              "workspace",
              "register",
              "explicit-target",
              "--alias",
              "Explicit.Target",
              "--no-restart",
            ],
            runtimeDir,
            {
              cwdPath: tempDir,
              defaultRuntimeConfig,
            },
          )
        ).code,
        0,
      );

      assertStringIncludes(
        await Deno.readTextFile(registryPath),
        `"alias": "Explicit.Target"`,
      );
      const registry = JSON.parse(await Deno.readTextFile(registryPath)) as {
        workspaces?: Array<{ workspaceRoot?: string }>;
      };
      assertEquals(registry.workspaces?.[0]?.workspaceRoot, workspaceDir);
    });
  },
);

Deno.test(
  "runDaemonCli workspace register defaults alias to the workspace folder name",
  async () => {
    await withTestTempDir(
      "daemon-cli-workspace-default-alias-",
      async (tempDir) => {
        const runtimeDir = join(tempDir, "runtime");
        const katoDir = join(tempDir, ".kato");
        const workspaceDir = join(tempDir, "default-alias-workspace");
        const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
        await Deno.mkdir(workspaceDir, { recursive: true });

        const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
          ...makeDefaultRuntimeConfig(runtimeDir),
          katoDir,
          allowedWriteRoots: [tempDir, katoDir],
        };

        assertEquals(
          (
            await runDaemonCliWithHarness(
              ["workspace", "init"],
              runtimeDir,
              {
                cwdPath: workspaceDir,
                defaultRuntimeConfig,
              },
            )
          ).code,
          0,
        );

        const { code: registerCode, harness: registerHarness } =
          await runDaemonCliWithHarness(
            ["workspace", "register", "--no-restart"],
            runtimeDir,
            {
              cwdPath: workspaceDir,
              defaultRuntimeConfig,
            },
          );
        assertEquals(registerCode, 0);
        assertStringIncludes(
          registerHarness.stdout.join(""),
          "workspace registered: default-alias-workspace (",
        );
        assertStringIncludes(
          await Deno.readTextFile(registryPath),
          `"alias": "default-alias-workspace"`,
        );
      },
    );
  },
);

Deno.test(
  "runDaemonCli status reports workspace validity with mappings",
  async () => {
    await withTestTempDir("daemon-cli-status-workspaces-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const validWorkspaceDir = join(tempDir, "Valid.Proj");
      const invalidWorkspaceDir = join(tempDir, "Invalid.Proj");
      const validConfigPath = join(
        validWorkspaceDir,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      const invalidConfigPath = join(
        invalidWorkspaceDir,
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      const validWorkspaceId = crypto.randomUUID();
      const invalidWorkspaceId = crypto.randomUUID();
      const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);

      await Deno.mkdir(runtimeDir, { recursive: true });
      await Deno.mkdir(dirname(registryPath), { recursive: true });
      await Deno.mkdir(validWorkspaceDir, { recursive: true });
      await Deno.mkdir(invalidWorkspaceDir, { recursive: true });

      await Deno.writeTextFile(
        validConfigPath,
        [
          `workspaceId: ${validWorkspaceId}`,
          'defaultOutputDir: "."',
        ].join("\n") + "\n",
      );
      await Deno.writeTextFile(
        invalidConfigPath,
        [
          `workspaceId: ${invalidWorkspaceId}`,
          "featureFlags:",
          "  writerIncludeCommentary: true",
        ].join("\n") + "\n",
      );

      await Deno.writeTextFile(
        registryPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            updatedAt: "2026-03-02T10:00:00.000Z",
            workspaces: [
              {
                workspaceId: validWorkspaceId,
                alias: "Valid.Proj",
                workspaceRoot: validWorkspaceDir,
                configPath: validConfigPath,
                registeredAt: "2026-03-02T10:00:00.000Z",
              },
              {
                workspaceId: invalidWorkspaceId,
                alias: "Invalid.Proj",
                workspaceRoot: invalidWorkspaceDir,
                configPath: invalidConfigPath,
                registeredAt: "2026-03-02T10:00:00.000Z",
              },
            ],
          },
          null,
          2,
        ) + "\n",
      );

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [tempDir, katoDir],
      };
      const { store: configStore } = makeInMemoryConfigStore(
        defaultRuntimeConfig,
      );
      const statusStore = makeInMemoryStatusStore({
        schemaVersion: 1,
        generatedAt: "2026-03-02T10:00:00.000Z",
        heartbeatAt: "2026-03-02T10:00:00.000Z",
        daemonRunning: true,
        daemonPid: 4242,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
        sessions: [],
      });
      const controlStore = makeInMemoryControlStore();
      const harness = makeRuntimeHarness(runtimeDir);

      const code = await runDaemonCli(["status"], {
        runtime: harness.runtime,
        defaultRuntimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      });

      assertEquals(code, 0);
      const output = harness.stdout.join("");
      assertStringIncludes(output, "twins: 0 current, 0 behind, 0 no twin");
      assertEquals(output.includes("workspaces: 1 active, 1 invalid"), false);
      assertStringIncludes(output, "Workspaces (1 active, 1 invalid)");
      assertStringIncludes(
        output,
        `● Valid.Proj -> ${validWorkspaceId} (valid)`,
      );
      assertStringIncludes(
        output,
        `○ Invalid.Proj -> ${invalidWorkspaceId} (invalid:`,
      );
    });
  },
);

Deno.test(
  "runDaemonCli status --json filters stale sessions unless --all is set",
  async () => {
    await withTestTempDir("daemon-cli-status-json-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      await Deno.mkdir(runtimeDir, { recursive: true });

      const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
      const { store: configStore } = makeInMemoryConfigStore(
        defaultRuntimeConfig,
      );
      const statusStore = makeInMemoryStatusStore({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: true,
        daemonPid: 4242,
        providers: [],
        recordings: {
          activeRecordings: 1,
          destinations: 1,
        },
        sessions: [
          {
            provider: "codex",
            sessionId: "sess-active",
            sessionShortId: "active",
            snippet: "fresh session",
            updatedAt: "2026-02-22T09:59:00.000Z",
            lastEventAt: "2026-02-22T09:59:00.000Z",
            stale: false,
            recordings: [{
              outputPath: DAEMON_CLI_ACTIVE_OUTPUT_PATH,
              startedAt: "2026-02-22T09:30:00.000Z",
              lastWriteAt: "2026-02-22T09:59:00.000Z",
            }],
          },
          {
            provider: "claude",
            sessionId: "sess-stale",
            sessionShortId: "stale",
            snippet: "stale session",
            updatedAt: "2026-02-20T10:00:00.000Z",
            lastEventAt: "2026-02-20T10:00:00.000Z",
            stale: false,
            recordings: [{
              outputPath: DAEMON_CLI_STALE_OUTPUT_PATH,
              startedAt: "2026-02-20T09:30:00.000Z",
              lastWriteAt: "2026-02-20T10:00:00.000Z",
            }],
          },
        ],
      });
      const controlStore = makeInMemoryControlStore();

      const jsonHarness = makeRuntimeHarness(runtimeDir);
      const jsonCode = await runDaemonCli(["status", "--json"], {
        runtime: jsonHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      });

      assertEquals(jsonCode, 0);
      const filtered = JSON.parse(
        jsonHarness.stdout.join(""),
      ) as DaemonStatusSnapshot & {
        web?: { configured: boolean; state: string };
      };
      assertEquals(filtered.sessions?.map((session) => session.sessionId), [
        "sess-active",
      ]);
      assertEquals(
        (filtered.recordings as { inactiveRecordings?: number })
          .inactiveRecordings,
        1,
      );
      assertEquals(filtered.web?.configured, false);
      assertEquals(filtered.web?.state, "unconfigured");

      const allHarness = makeRuntimeHarness(runtimeDir);
      const allCode = await runDaemonCli(["status", "--json", "--all"], {
        runtime: allHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      });

      assertEquals(allCode, 0);
      const unfiltered = JSON.parse(
        allHarness.stdout.join(""),
      ) as DaemonStatusSnapshot & {
        web?: { configured: boolean; state: string };
      };
      assertEquals(unfiltered.sessions?.map((session) => session.sessionId), [
        "sess-active",
        "sess-stale",
      ]);
      assertEquals(
        (unfiltered.recordings as { inactiveRecordings?: number })
          .inactiveRecordings,
        1,
      );
      assertEquals(unfiltered.web?.configured, false);
      assertEquals(unfiltered.web?.state, "unconfigured");
    });
  },
);

Deno.test(
  "runDaemonCli status reports Kato Web runstate and recent web errors",
  async () => {
    await withTestTempDir("daemon-cli-status-web-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const webLogsDir = join(katoDir, "web", "logs");
      const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
      await Deno.mkdir(runtimeDir, { recursive: true });
      await Deno.mkdir(webLogsDir, { recursive: true });
      await Deno.mkdir(dirname(registryPath), { recursive: true });
      await Deno.writeTextFile(
        registryPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            updatedAt: "2026-03-02T10:00:00.000Z",
            workspaces: [],
          },
          null,
          2,
        ) + "\n",
      );
      await Deno.writeTextFile(
        join(webLogsDir, "operational.jsonl"),
        `${
          JSON.stringify({
            timestamp: "2026-03-02T10:01:00.000Z",
            level: "error",
            channel: "operational",
            event: "web.settings.mutation.failed",
            message: "invalid username",
          })
        }\n`,
      );

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [tempDir, katoDir],
      };
      const { store: configStore } = makeInMemoryConfigStore(
        defaultRuntimeConfig,
      );
      const statusStore = makeInMemoryStatusStore({
        schemaVersion: 1,
        generatedAt: "2026-03-02T10:02:00.000Z",
        heartbeatAt: "2026-03-02T10:02:00.000Z",
        daemonRunning: true,
        daemonPid: 4242,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
        sessions: [],
      });
      const controlStore = makeInMemoryControlStore();
      const webStatusStore = makeInMemoryWebStatusStore({
        ...createDefaultWebServerStatus(new Date("2026-03-02T10:02:00.000Z")),
        running: true,
        hostname: "127.0.0.1",
        port: 3173,
        pid: Deno.pid,
        startedAt: "2026-03-02T10:00:00.000Z",
        heartbeatAt: "2026-03-02T10:02:00.000Z",
        url: "http://127.0.0.1:3173/",
      });
      const webConfig = createDefaultWebConfig({
        hostname: "127.0.0.1",
        port: 3173,
      });
      const webConfigStore = {
        getPath() {
          return join(katoDir, "web", "kato-web-config.yaml");
        },
        load() {
          return Promise.resolve(webConfig);
        },
        ensureInitialized(defaultConfig = webConfig) {
          return Promise.resolve({
            created: false,
            config: defaultConfig,
            path: this.getPath(),
          });
        },
      };

      const harness = makeRuntimeHarness(runtimeDir);
      const code = await runDaemonCli(["status"], {
        runtime: harness.runtime,
        defaultRuntimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
        webConfigStore,
        webStatusStore,
      });

      assertEquals(code, 0);
      const output = harness.stdout.join("");
      assert(
        new RegExp(
          `kato web \\(v${
            CLI_APP_VERSION.replaceAll(".", "\\.")
          }\\): (running|stale status) \\(http://127\\.0\\.0\\.1:3173/`,
        ).test(output),
      );
      assertStringIncludes(
        output,
        "ERROR web operational web.settings.mutation.failed",
      );
      assertStringIncludes(output, "invalid username");
    });
  },
);

Deno.test(
  "runDaemonCli status reads recent log errors and reconciles the suppression cursor",
  async () => {
    await withTestTempDir("daemon-cli-status-errors-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const logsDir = join(runtimeDir, "logs");
      const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
      await Deno.mkdir(logsDir, { recursive: true });
      await Deno.mkdir(dirname(registryPath), { recursive: true });
      await Deno.writeTextFile(
        registryPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            updatedAt: "2026-03-02T10:00:00.000Z",
            workspaces: [],
          },
          null,
          2,
        ) + "\n",
      );

      const suppressedError = {
        timestamp: "2026-03-02T10:00:00.000Z",
        level: "error" as const,
        channel: "operational" as const,
        event: "daemon.disk_full",
        message: "disk full",
        source: "log" as const,
      };
      const visibleError = {
        timestamp: "2026-03-02T10:01:00.000Z",
        level: "warn" as const,
        channel: "security-audit" as const,
        event: "audit.backlog",
        message: "needs review",
        source: "log" as const,
      };
      await Deno.writeTextFile(
        join(logsDir, "operational.jsonl"),
        [
          JSON.stringify(suppressedError),
          JSON.stringify({
            timestamp: "2026-03-02T09:58:00.000Z",
            level: "info",
            channel: "operational",
            event: "daemon.ok",
            message: "ignored",
          }),
          "{not-json}",
        ].join("\n") + "\n",
      );
      await Deno.writeTextFile(
        join(logsDir, "security-audit.jsonl"),
        `${JSON.stringify(visibleError)}\n`,
      );

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [tempDir, katoDir],
      };
      const { store: configStore } = makeInMemoryConfigStore(
        defaultRuntimeConfig,
      );
      const statusStore = makeInMemoryStatusStore({
        schemaVersion: 1,
        generatedAt: "2026-03-02T10:02:00.000Z",
        heartbeatAt: "2026-03-02T10:02:00.000Z",
        daemonRunning: true,
        daemonPid: 4242,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
        sessions: [],
      });
      const controlStore = makeInMemoryControlStore();
      const cursorPath = resolveStatusErrorCursorPath(runtimeDir);
      const currentSuppressedKey = getStatusRecentErrorKey(suppressedError);
      await saveSuppressedRecentErrorKeys(
        cursorPath,
        new Set([currentSuppressedKey, "stale|suppressed|key"]),
        new Date("2026-03-02T10:01:30.000Z"),
      );

      const harness = makeRuntimeHarness(runtimeDir);
      const code = await runDaemonCli(["status"], {
        runtime: harness.runtime,
        defaultRuntimeConfig,
        configStore,
        statusStore,
        controlStore: controlStore.store,
      });

      assertEquals(code, 0);
      const output = harness.stdout.join("");
      assertStringIncludes(output, "Recent Errors (1)");
      assertStringIncludes(output, "WARN audit audit.backlog");
      assertStringIncludes(output, "needs review");
      assertEquals(output.includes("daemon.disk_full"), false);
      assertEquals(output.includes("disk full"), false);

      const persistedKeys = await loadSuppressedRecentErrorKeys(cursorPath);
      assertEquals([...persistedKeys], [currentSuppressedKey]);
    });
  },
);

Deno.test(
  "runDaemonCli workspace init fails when the config path exists as a non-file",
  async () => {
    await withTestTempDir(
      "daemon-cli-workspace-init-nonfile-",
      async (tempDir) => {
        const runtimeDir = join(tempDir, "runtime");
        const katoDir = join(tempDir, ".kato");
        const workspaceDir = join(tempDir, "nonfile-config");
        const configPath = join(
          workspaceDir,
          DEFAULT_WORKSPACE_CONFIG_FILENAME,
        );
        await Deno.mkdir(configPath, { recursive: true });

        const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
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

        assertEquals(initCode, 1);
        assertStringIncludes(
          initHarness.stderr.join(""),
          `Command failed: Config path exists and is not a file: ${configPath}`,
        );
      },
    );
  },
);

Deno.test(
  "runDaemonCli workspace register rejects aliases that collide with existing workspaceIds",
  async () => {
    await withTestTempDir("daemon-cli-workspace-alias-id-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const firstWorkspaceDir = join(tempDir, "workspace-one");
      const secondWorkspaceDir = join(tempDir, "workspace-two");
      const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
      await Deno.mkdir(firstWorkspaceDir, { recursive: true });
      await Deno.mkdir(secondWorkspaceDir, { recursive: true });

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [tempDir, katoDir],
      };

      const firstInitHarness = makeRuntimeHarness(runtimeDir);
      firstInitHarness.runtime.cwdPath = firstWorkspaceDir;
      assertEquals(
        await runDaemonCli(["workspace", "init"], {
          runtime: firstInitHarness.runtime,
          defaultRuntimeConfig,
        }),
        0,
      );

      const firstRegisterHarness = makeRuntimeHarness(runtimeDir);
      firstRegisterHarness.runtime.cwdPath = firstWorkspaceDir;
      assertEquals(
        await runDaemonCli([
          "workspace",
          "register",
          "--alias",
          "workspace-one",
          "--no-restart",
        ], {
          runtime: firstRegisterHarness.runtime,
          defaultRuntimeConfig,
        }),
        0,
      );

      const firstRegistry = JSON.parse(
        await Deno.readTextFile(registryPath),
      ) as {
        workspaces?: Array<{ workspaceId?: string }>;
      };
      const firstWorkspaceId = firstRegistry.workspaces?.[0]?.workspaceId;
      assertExists(firstWorkspaceId);

      const secondInitHarness = makeRuntimeHarness(runtimeDir);
      secondInitHarness.runtime.cwdPath = secondWorkspaceDir;
      assertEquals(
        await runDaemonCli(["workspace", "init"], {
          runtime: secondInitHarness.runtime,
          defaultRuntimeConfig,
        }),
        0,
      );

      const secondRegisterHarness = makeRuntimeHarness(runtimeDir);
      secondRegisterHarness.runtime.cwdPath = secondWorkspaceDir;
      const secondRegisterCode = await runDaemonCli([
        "workspace",
        "register",
        "--alias",
        firstWorkspaceId,
      ], {
        runtime: secondRegisterHarness.runtime,
        defaultRuntimeConfig,
      });

      assertEquals(secondRegisterCode, 1);
      assertStringIncludes(
        secondRegisterHarness.stderr.join(""),
        `Command failed: Workspace alias already registered: ${firstWorkspaceId}`,
      );
    });
  },
);

Deno.test(
  "runDaemonCli workspace register ignores legacy .kato workspace config paths",
  async () => {
    await withTestTempDir("daemon-cli-workspace-missing-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const workspaceDir = join(tempDir, "missing-config");
      const legacyConfigPath = join(
        workspaceDir,
        ".kato",
        DEFAULT_WORKSPACE_CONFIG_FILENAME,
      );
      await Deno.mkdir(workspaceDir, { recursive: true });
      await Deno.mkdir(dirname(legacyConfigPath), { recursive: true });
      await Deno.writeTextFile(legacyConfigPath, 'defaultOutputDir: "."\n');

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [workspaceDir, katoDir],
      };

      const registerHarness = makeRuntimeHarness(runtimeDir);
      registerHarness.runtime.cwdPath = workspaceDir;
      const exitCode = await runDaemonCli([
        "workspace",
        "register",
        ".",
        "--alias",
        "missing-config",
      ], {
        runtime: registerHarness.runtime,
        defaultRuntimeConfig,
      });

      assertEquals(exitCode, 1);
      assertStringIncludes(
        registerHarness.stderr.join(""),
        `Command failed: No workspace config found at ${
          join(workspaceDir, DEFAULT_WORKSPACE_CONFIG_FILENAME)
        }. Run \`kato workspace init .\` first.`,
      );
    });
  },
);

Deno.test(
  "runDaemonCli workspace register restarts by default when workspace root is outside current allowedWriteRoots",
  async () => {
    await withTestTempDir("daemon-cli-workspace-warning-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      const workspaceDir = join(tempDir, "warn-me");
      await Deno.mkdir(workspaceDir, { recursive: true });

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
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

      const statusStore = makeInMemoryStatusStore();
      const controlStore = makeInMemoryControlStore();
      const daemonLauncher = makeDaemonLauncher(
        31337,
        makeStartupAckCallback(statusStore, 31337),
      );
      const registerHarness = makeRuntimeHarness(runtimeDir);
      registerHarness.runtime.cwdPath = workspaceDir;
      const registerCode = await runDaemonCli([
        "workspace",
        "register",
        "--alias",
        "warn-me",
      ], {
        runtime: registerHarness.runtime,
        defaultRuntimeConfig,
        statusStore,
        controlStore: controlStore.store,
        daemonLauncher: daemonLauncher.launcher,
      });
      assertEquals(registerCode, 0);
      assertEquals(daemonLauncher.launchedCount.value, 1);
      assertEquals(controlStore.requests.length, 0);
      assertStringIncludes(
        registerHarness.stdout.join(""),
        "updated shared config: added workspace root to allowedWriteRoots",
      );
      assertStringIncludes(
        registerHarness.stdout.join(""),
        "restarting daemon to reload shared allowedWriteRoots",
      );
      assertStringIncludes(
        registerHarness.stdout.join(""),
        "kato daemon started in background (pid: 31337).",
      );
      const sharedConfigPath = join(
        katoDir,
        "shared",
        "kato-shared-config.yaml",
      );
      assertStringIncludes(
        await Deno.readTextFile(sharedConfigPath),
        workspaceDir,
      );
    });
  },
);

Deno.test(
  "runDaemonCli workspace register --no-restart skips the default daemon restart",
  async () => {
    await withTestTempDir(
      "daemon-cli-workspace-no-restart-",
      async (tempDir) => {
        const runtimeDir = join(tempDir, "runtime");
        const katoDir = join(tempDir, ".kato");
        const workspaceDir = join(tempDir, "warn-me");
        await Deno.mkdir(workspaceDir, { recursive: true });

        const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
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

        const statusStore = makeInMemoryStatusStore();
        const controlStore = makeInMemoryControlStore();
        const daemonLauncher = makeDaemonLauncher(
          31337,
          makeStartupAckCallback(statusStore, 31337),
        );
        const registerHarness = makeRuntimeHarness(runtimeDir);
        registerHarness.runtime.cwdPath = workspaceDir;
        const registerCode = await runDaemonCli([
          "workspace",
          "register",
          "--alias",
          "warn-me",
          "--no-restart",
        ], {
          runtime: registerHarness.runtime,
          defaultRuntimeConfig,
          statusStore,
          controlStore: controlStore.store,
          daemonLauncher: daemonLauncher.launcher,
        });
        assertEquals(registerCode, 0);
        assertEquals(daemonLauncher.launchedCount.value, 0);
        assertEquals(controlStore.requests.length, 0);
        assertStringIncludes(
          registerHarness.stdout.join(""),
          "updated shared config: added workspace root to allowedWriteRoots",
        );
        assertStringIncludes(
          registerHarness.stdout.join(""),
          "skipped daemon restart (--no-restart); daemon processes launched before this registration may still deny writes for this workspace until `kato restart` reloads shared allowedWriteRoots",
        );
      },
    );
  },
);

Deno.test(
  "runDaemonCli workspace register preserves registration when the automatic restart fails",
  async () => {
    await withTestTempDir(
      "daemon-cli-workspace-restart-failure-",
      async (tempDir) => {
        const runtimeDir = join(tempDir, "runtime");
        const katoDir = join(tempDir, ".kato");
        const workspaceDir = join(tempDir, "warn-me");
        await Deno.mkdir(workspaceDir, { recursive: true });

        const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
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

        const statusStore = makeInMemoryStatusStore();
        const controlStore = makeInMemoryControlStore();
        const daemonLauncher = makeDaemonLauncher(
          31337,
          () => {
            throw new Error("daemon launch failed");
          },
        );
        const registerHarness = makeRuntimeHarness(runtimeDir);
        registerHarness.runtime.cwdPath = workspaceDir;
        const registerCode = await runDaemonCli([
          "workspace",
          "register",
          "--alias",
          "warn-me",
        ], {
          runtime: registerHarness.runtime,
          defaultRuntimeConfig,
          statusStore,
          controlStore: controlStore.store,
          daemonLauncher: daemonLauncher.launcher,
        });

        assertEquals(registerCode, 1);
        assertEquals(daemonLauncher.launchedCount.value, 1);
        assertStringIncludes(
          registerHarness.stdout.join(""),
          "workspace registered: warn-me (",
        );
        assertStringIncludes(
          registerHarness.stdout.join(""),
          "restarting daemon to reload shared allowedWriteRoots",
        );
        assertStringIncludes(
          registerHarness.stderr.join(""),
          "Command failed: Workspace registered successfully but automatic restart failed: daemon launch failed",
        );

        const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
        assertStringIncludes(
          await Deno.readTextFile(registryPath),
          '"alias": "warn-me"',
        );
        const sharedConfigPath = join(
          katoDir,
          "shared",
          "kato-shared-config.yaml",
        );
        assertStringIncludes(
          await Deno.readTextFile(sharedConfigPath),
          workspaceDir,
        );
      },
    );
  },
);

Deno.test(
  "runDaemonCli workspace commands use the persisted runtime config when it exists",
  async () => {
    await withTestTempDir("daemon-cli-workspace-config-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const workspaceDir = join(tempDir, "config-backed");
      const configuredKatoDir = join(tempDir, "configured-kato");
      const registryPath = join(
        configuredKatoDir,
        "shared",
        "workspace-registry.json",
      );
      await Deno.mkdir(workspaceDir, { recursive: true });

      const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
      const persistedRuntimeConfig: DaemonCliRuntimeConfigFixture = {
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
        await runDaemonCli([
          "workspace",
          "register",
          "--alias",
          "config-backed",
          "--no-restart",
        ], {
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
      assertStringIncludes(
        await Deno.readTextFile(
          join(configuredKatoDir, "shared", "kato-shared-config.yaml"),
        ),
        workspaceDir,
      );
      assertExists(
        await Deno.stat(join(configuredKatoDir, "cli", "kato-cli-config.yaml")),
      );

      await assertRejects(
        () =>
          Deno.stat(
            resolveDefaultWorkspaceRegistryPath(dirname(runtimeDir)),
          ),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () =>
          Deno.stat(
            join(dirname(runtimeDir), "shared", "kato-shared-config.yaml"),
          ),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () =>
          Deno.stat(join(dirname(runtimeDir), "cli", "kato-cli-config.yaml")),
        Deno.errors.NotFound,
      );
    });
  },
);

Deno.test(
  "runDaemonCli user init creates user config and is idempotent",
  async () => {
    await withTestTempDir("daemon-cli-user-init-", async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const harness = makeRuntimeHarness(runtimeDir);
      const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
      const { store: configStore } = makeInMemoryConfigStore();
      const {
        ensureCalls: userEnsureCalls,
        store: userConfigStore,
      } = makeInMemoryUserConfigStore(
        undefined,
        `${runtimeDir}/kato-user-config.yaml`,
      );
      const statusStore = makeInMemoryStatusStore();
      const controlStore = makeInMemoryControlStore();

      const firstCode = await runDaemonCli(["user", "init"], {
        runtime: harness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
      });
      assertEquals(firstCode, 0);
      assertStringIncludes(
        harness.stdout.join(""),
        `created user config at ${runtimeDir}/kato-user-config.yaml`,
      );
      assertEquals(userEnsureCalls.value, 1);

      const secondHarness = makeRuntimeHarness(runtimeDir);
      const secondCode = await runDaemonCli(["user", "init"], {
        runtime: secondHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
      });
      assertEquals(secondCode, 0);
      assertStringIncludes(
        secondHarness.stdout.join(""),
        `user config already exists at ${runtimeDir}/kato-user-config.yaml`,
      );
      assertEquals(userEnsureCalls.value, 2);
    });
  },
);

Deno.test("runDaemonCli user commands manage user participant settings", async () => {
  await withTestTempDir("daemon-cli-user-commands-", async (tempDir) => {
    const runtimeDir = join(tempDir, "runtime");
    const katoDir = join(tempDir, ".kato");
    const registryPath = resolveDefaultWorkspaceRegistryPath(katoDir);
    await Deno.mkdir(runtimeDir, { recursive: true });
    await Deno.mkdir(dirname(registryPath), { recursive: true });

    const workspaceOneId = crypto.randomUUID();
    const workspaceTwoId = crypto.randomUUID();
    await Deno.writeTextFile(
      registryPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: "2026-03-03T10:00:00.000Z",
          workspaces: [
            {
              workspaceId: workspaceOneId,
              alias: "My.Proj",
              workspaceRoot: join(tempDir, "My.Proj"),
              configPath: join(
                tempDir,
                "My.Proj",
                DEFAULT_WORKSPACE_CONFIG_FILENAME,
              ),
              registeredAt: "2026-03-03T10:00:00.000Z",
            },
            {
              workspaceId: workspaceTwoId,
              alias: "Another.Proj",
              workspaceRoot: join(tempDir, "Another.Proj"),
              configPath: join(
                tempDir,
                "Another.Proj",
                DEFAULT_WORKSPACE_CONFIG_FILENAME,
              ),
              registeredAt: "2026-03-03T10:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );

    const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
      ...makeDefaultRuntimeConfig(runtimeDir),
      katoDir,
      allowedWriteRoots: [tempDir, katoDir],
    };
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );
    const {
      store: userConfigStore,
      snapshot,
    } = makeInMemoryUserConfigStore();
    const statusStore = makeInMemoryStatusStore();
    const controlStore = makeInMemoryControlStore();

    const mapSetHarness = makeRuntimeHarness(runtimeDir);
    assertEquals(
      await runDaemonCli(
        ["user", "map", "set", "My.Proj", "Dj Radon"],
        {
          runtime: mapSetHarness.runtime,
          defaultRuntimeConfig,
          configStore,
          userConfigStore,
          statusStore,
          controlStore: controlStore.store,
        },
      ),
      0,
    );
    assertStringIncludes(
      mapSetHarness.stdout.join(""),
      `user mapping set: My.Proj (${workspaceOneId}) -> Dj Radon`,
    );

    const secondMapSetHarness = makeRuntimeHarness(runtimeDir);
    assertEquals(
      await runDaemonCli(
        ["user", "map", "set", workspaceTwoId, "another-user"],
        {
          runtime: secondMapSetHarness.runtime,
          defaultRuntimeConfig,
          configStore,
          userConfigStore,
          statusStore,
          controlStore: controlStore.store,
        },
      ),
      0,
    );

    const defaultSetHarness = makeRuntimeHarness(runtimeDir);
    assertEquals(
      await runDaemonCli(["user", "default", "set", "Case Sensitive.User"], {
        runtime: defaultSetHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
      }),
      0,
    );
    assertEquals(
      snapshot().participants.defaultUsername,
      "Case Sensitive.User",
    );

    const excludeHarness = makeRuntimeHarness(runtimeDir);
    assertEquals(
      await runDaemonCli(["user", "exclude-me", "false"], {
        runtime: excludeHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
      }),
      0,
    );
    assertEquals(snapshot().participants.excludeMeFromParticipantList, false);

    const jsonListHarness = makeRuntimeHarness(runtimeDir);
    assertEquals(
      await runDaemonCli(["user", "map", "list", "--json"], {
        runtime: jsonListHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
      }),
      0,
    );
    const listPayload = JSON.parse(jsonListHarness.stdout.join("")) as {
      schemaVersion: number;
      mappings: Array<{
        workspaceId: string;
        workspaceAlias: string;
        username: string;
      }>;
    };
    assertEquals(listPayload.schemaVersion, 1);
    assertEquals(listPayload.mappings, [
      {
        workspaceId: workspaceTwoId,
        workspaceAlias: "Another.Proj",
        username: "another-user",
      },
      {
        workspaceId: workspaceOneId,
        workspaceAlias: "My.Proj",
        username: "Dj Radon",
      },
    ]);

    const mapDeleteHarness = makeRuntimeHarness(runtimeDir);
    assertEquals(
      await runDaemonCli(["user", "map", "delete", workspaceOneId], {
        runtime: mapDeleteHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
      }),
      0,
    );
    assertEquals(
      Object.hasOwn(snapshot().participants.workspaceUsernames, workspaceOneId),
      false,
    );

    const defaultClearHarness = makeRuntimeHarness(runtimeDir);
    assertEquals(
      await runDaemonCli(["user", "default", "clear"], {
        runtime: defaultClearHarness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
      }),
      0,
    );
    assertEquals(snapshot().participants.defaultUsername, "");
  });
});

Deno.test("runDaemonCli user map set fails unknown selector while delete supports stale workspace ids", async () => {
  await withTestTempDir(
    "daemon-cli-user-unknown-workspace-",
    async (tempDir) => {
      const runtimeDir = join(tempDir, "runtime");
      const katoDir = join(tempDir, ".kato");
      await Deno.mkdir(runtimeDir, { recursive: true });
      await Deno.mkdir(katoDir, { recursive: true });
      const staleWorkspaceId = "missing-workspace";
      const initialUserConfig = createDefaultUserConfig({
        workspaceUsernames: {
          [staleWorkspaceId]: "alice",
        },
      });

      const defaultRuntimeConfig: DaemonCliRuntimeConfigFixture = {
        ...makeDefaultRuntimeConfig(runtimeDir),
        katoDir,
        allowedWriteRoots: [tempDir, katoDir],
      };
      const { store: configStore } = makeInMemoryConfigStore(
        defaultRuntimeConfig,
      );
      const { store: userConfigStore, snapshot } = makeInMemoryUserConfigStore(
        initialUserConfig,
      );
      const statusStore = makeInMemoryStatusStore();
      const controlStore = makeInMemoryControlStore();

      const setHarness = makeRuntimeHarness(runtimeDir);
      const setCode = await runDaemonCli(
        ["user", "map", "set", "missing-workspace", "alice"],
        {
          runtime: setHarness.runtime,
          defaultRuntimeConfig,
          configStore,
          userConfigStore,
          statusStore,
          controlStore: controlStore.store,
        },
      );
      assertEquals(setCode, 1);
      assertStringIncludes(setHarness.stderr.join(""), "Workspace not found");

      const deleteHarness = makeRuntimeHarness(runtimeDir);
      const deleteCode = await runDaemonCli(
        ["user", "map", "delete", staleWorkspaceId],
        {
          runtime: deleteHarness.runtime,
          defaultRuntimeConfig,
          configStore,
          userConfigStore,
          statusStore,
          controlStore: controlStore.store,
        },
      );
      assertEquals(deleteCode, 0);
      assertStringIncludes(
        deleteHarness.stdout.join(""),
        `user mapping deleted: ${staleWorkspaceId} (${staleWorkspaceId})`,
      );
      assertEquals(
        Object.hasOwn(
          snapshot().participants.workspaceUsernames,
          staleWorkspaceId,
        ),
        false,
      );

      const missingDeleteHarness = makeRuntimeHarness(runtimeDir);
      const missingDeleteCode = await runDaemonCli(
        ["user", "map", "delete", staleWorkspaceId],
        {
          runtime: missingDeleteHarness.runtime,
          defaultRuntimeConfig,
          configStore,
          userConfigStore,
          statusStore,
          controlStore: controlStore.store,
        },
      );
      assertEquals(missingDeleteCode, 0);
      assertStringIncludes(
        missingDeleteHarness.stdout.join(""),
        `user mapping already absent: ${staleWorkspaceId} (${staleWorkspaceId})`,
      );
    },
  );
});

Deno.test(
  "runDaemonCli start auto-initializes runtime config when missing",
  async () => {
    await withTestTempDir("daemon-cli-start-auto-init-", async (runtimeDir) => {
      const harness = makeRuntimeHarness(runtimeDir);
      const statusStore = makeInMemoryStatusStore();
      const controlStore = makeInMemoryControlStore();
      const daemonLauncher = makeDaemonLauncher(
        31337,
        makeStartupAckCallback(statusStore, 31337),
      );
      const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
      const { ensureCalls, store: configStore } = makeInMemoryConfigStore();
      const {
        ensureCalls: userEnsureCalls,
        store: userConfigStore,
      } = makeInMemoryUserConfigStore(
        undefined,
        `${runtimeDir}/kato-user-config.yaml`,
      );

      const code = await runDaemonCli(["start"], {
        runtime: harness.runtime,
        defaultRuntimeConfig,
        configStore,
        userConfigStore,
        statusStore,
        controlStore: controlStore.store,
        daemonLauncher: daemonLauncher.launcher,
        autoInitOnStart: true,
      });

      assertEquals(code, 0);
      assertStringIncludes(
        harness.stdout.join(""),
        `initialized runtime config at ${runtimeDir}/kato-daemon-config.yaml`,
      );
      assertStringIncludes(
        harness.stdout.join(""),
        `initialized user config at ${runtimeDir}/kato-user-config.yaml`,
      );
      assertStringIncludes(harness.stdout.join(""), "started in background");
      assertEquals(ensureCalls.value, 1);
      assertEquals(userEnsureCalls.value, 1);
    });
  },
);

Deno.test(
  "runDaemonCli start fails when startup acknowledgement times out",
  async () => {
    const runtimeDir = ".kato/test-runtime";
    const harness = makeRuntimeHarness(runtimeDir);
    const statusStore = makeInMemoryStatusStore({
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: {
        activeRecordings: 0,
        destinations: 0,
      },
    });
    const controlStore = makeInMemoryControlStore();
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );
    const daemonLauncher = makeDaemonLauncher(31337);

    const code = await withMockedDateNow(
      [0, 20_000],
      () =>
        runDaemonCli(["start"], {
          runtime: harness.runtime,
          defaultRuntimeConfig,
          configStore,
          statusStore,
          controlStore: controlStore.store,
          daemonLauncher: daemonLauncher.launcher,
        }),
    );

    assertEquals(code, 1);
    assertStringIncludes(
      harness.stderr.join(""),
      "Timed out waiting for daemon startup acknowledgement",
    );
  },
);

Deno.test(
  "runDaemonCli restart auto-initializes runtime config when missing",
  async () => {
    await withTestTempDir(
      "daemon-cli-restart-auto-init-",
      async (runtimeDir) => {
        const harness = makeRuntimeHarness(runtimeDir);
        const statusStore = makeInMemoryStatusStore();
        const controlStore = makeInMemoryControlStore();
        const daemonLauncher = makeDaemonLauncher(
          31337,
          makeStartupAckCallback(statusStore, 31337),
        );
        const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
        const { ensureCalls, store: configStore } = makeInMemoryConfigStore();
        const {
          ensureCalls: userEnsureCalls,
          store: userConfigStore,
        } = makeInMemoryUserConfigStore(
          undefined,
          `${runtimeDir}/kato-user-config.yaml`,
        );

        const code = await runDaemonCli(["restart"], {
          runtime: harness.runtime,
          defaultRuntimeConfig,
          configStore,
          userConfigStore,
          statusStore,
          controlStore: controlStore.store,
          daemonLauncher: daemonLauncher.launcher,
          autoInitOnStart: true,
        });

        assertEquals(code, 0);
        assertStringIncludes(
          harness.stdout.join(""),
          `initialized runtime config at ${runtimeDir}/kato-daemon-config.yaml`,
        );
        assertStringIncludes(
          harness.stdout.join(""),
          `initialized user config at ${runtimeDir}/kato-user-config.yaml`,
        );
        assertStringIncludes(harness.stdout.join(""), "started in background");
        assertEquals(ensureCalls.value, 1);
        assertEquals(userEnsureCalls.value, 1);
      },
    );
  },
);

Deno.test(
  "runDaemonCli start auto-initializes global config and warns when local .kato exists",
  async () => {
    await withLockedEnvironment(async () => {
      const snapshot = snapshotRuntimeEnv();
      await withTestTempDir(
        "daemon-cli-start-global-root-",
        async (rootDir) => {
          const homeDir = join(rootDir, "home");
          const projectDir = join(rootDir, "project");
          const runtimeDir = join(homeDir, ".kato", "daemon");
          const localKatoDir = join(projectDir, ".kato");
          try {
            setRuntimeEnv({
              HOME: homeDir,
              USERPROFILE: undefined,
              KATO_RUNTIME_DIR: undefined,
            });
            await Deno.mkdir(localKatoDir, { recursive: true });
            const harness = makeRuntimeHarness(runtimeDir);
            harness.runtime.cwdPath = projectDir;
            const statusStore = makeInMemoryStatusStore();
            const controlStore = makeInMemoryControlStore();
            const daemonLauncher = makeDaemonLauncher(
              31337,
              makeStartupAckCallback(statusStore, 31337),
            );
            const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
            const { store: configStore } = makeInMemoryConfigStore();
            const { store: userConfigStore } = makeInMemoryUserConfigStore(
              undefined,
              `${runtimeDir}/kato-user-config.yaml`,
            );

            const code = await runDaemonCli(["start"], {
              runtime: harness.runtime,
              defaultRuntimeConfig,
              configStore,
              userConfigStore,
              statusStore,
              controlStore: controlStore.store,
              daemonLauncher: daemonLauncher.launcher,
              autoInitOnStart: true,
            });

            assertEquals(code, 0);
            const output = harness.stdout.join("");
            assertStringIncludes(
              output,
              `initialized runtime config at ${runtimeDir}/kato-daemon-config.yaml`,
            );
            assertStringIncludes(output, "warning: detected local state");
            assertStringIncludes(output, localKatoDir);
            assertStringIncludes(
              output,
              `using global runtime root ${join(homeDir, ".kato")}`,
            );
          } finally {
            restoreRuntimeEnv(snapshot);
          }
        },
      );
    });
  },
);

Deno.test(
  "runDaemonCli init/start/restart warn when local .kato exists but global root is active",
  async () => {
    await withLockedEnvironment(async () => {
      const snapshot = snapshotRuntimeEnv();
      await withTestTempDir(
        "daemon-cli-global-root-warning-",
        async (rootDir) => {
          const homeDir = join(rootDir, "home");
          const projectDir = join(rootDir, "project");
          const runtimeDir = join(homeDir, ".kato", "daemon");
          const localKatoDir = join(projectDir, ".kato");
          try {
            setRuntimeEnv({
              HOME: homeDir,
              USERPROFILE: undefined,
              KATO_RUNTIME_DIR: undefined,
            });
            await Deno.mkdir(localKatoDir, { recursive: true });
            const commands: Array<"init" | "start" | "restart"> = [
              "init",
              "start",
              "restart",
            ];
            for (const command of commands) {
              const harness = makeRuntimeHarness(runtimeDir);
              harness.runtime.cwdPath = projectDir;
              const statusStore = makeInMemoryStatusStore();
              const controlStore = makeInMemoryControlStore();
              const daemonLauncher = makeDaemonLauncher(
                31337,
                makeStartupAckCallback(statusStore, 31337),
              );
              const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
              const { store: configStore } = makeInMemoryConfigStore();
              const { store: userConfigStore } = makeInMemoryUserConfigStore(
                undefined,
                `${runtimeDir}/kato-user-config.yaml`,
              );
              const code = await runDaemonCli([command], {
                runtime: harness.runtime,
                defaultRuntimeConfig,
                configStore,
                userConfigStore,
                statusStore,
                controlStore: controlStore.store,
                daemonLauncher: daemonLauncher.launcher,
                autoInitOnStart: true,
              });

              assertEquals(code, 0);
              const output = harness.stdout.join("");
              assertStringIncludes(output, "warning: detected local state");
              assertStringIncludes(output, localKatoDir);
            }
          } finally {
            restoreRuntimeEnv(snapshot);
          }
        },
      );
    });
  },
);

Deno.test(
  "runDaemonCli fails early when KATO_RUNTIME_DIR is relative",
  async () => {
    await withLockedEnvironment(async () => {
      const snapshot = snapshotRuntimeEnv();
      const stderr: string[] = [];
      try {
        setRuntimeEnv({
          KATO_RUNTIME_DIR: ".kato/daemon",
        });
        const code = await runDaemonCli(["start"], {
          runtime: {
            writeStderr(text: string) {
              stderr.push(text);
            },
          },
        });
        assertEquals(code, 1);
        assertStringIncludes(
          stderr.join(""),
          "KATO_RUNTIME_DIR must resolve to an absolute path",
        );
      } finally {
        restoreRuntimeEnv(snapshot);
      }
    });
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
  "runDaemonCli status preserves stale sessions when lastEventAt is missing",
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
    assertStringIncludes(output, "sessions: 0 active, 1 idle");
    assertStringIncludes(output, "run with --all to show 1 idle");
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
    recordings: { activeRecordings: number; inactiveRecordings?: number };
  };
  assertEquals(statusPayload.schemaVersion, 1);
  assertEquals(statusPayload.daemonRunning, true);
  assertEquals(statusPayload.daemonPid, 31337);
  assertEquals(statusPayload.heartbeatAt, "2026-02-22T10:00:00.000Z");
  assertEquals(statusPayload.recordings.activeRecordings, 3);
  assertEquals(statusPayload.recordings.inactiveRecordings, 0);

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
  await withTestTempDir("daemon-cli-clean-", async (rootDir) => {
    const runtimeDir = `${rootDir}/runtime`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const controlStore = makeInMemoryControlStore();
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
    });
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
    const webLogsDir = `${dirname(runtimeDir)}/web/logs`;
    const webOperationalLogPath = `${webLogsDir}/operational.jsonl`;
    const webAuditLogPath = `${webLogsDir}/security-audit.jsonl`;
    await Deno.mkdir(logsDir, { recursive: true });
    await Deno.mkdir(webLogsDir, { recursive: true });
    await Deno.writeTextFile(operationalLogPath, '{"old":"operational"}\n');
    await Deno.writeTextFile(auditLogPath, '{"old":"audit"}\n');
    await Deno.writeTextFile(webOperationalLogPath, '{"old":"web-op"}\n');
    await Deno.writeTextFile(webAuditLogPath, '{"old":"web-audit"}\n');

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
    assertStringIncludes(cleanHarness.stdout.join(""), "logsFlushed=5");
    assertEquals(controlStore.requests.length, 1);
    assertEquals(await Deno.readTextFile(operationalLogPath), "");
    assertEquals(await Deno.readTextFile(auditLogPath), "");
    assertEquals(await Deno.readTextFile(webOperationalLogPath), "");
    assertEquals(await Deno.readTextFile(webAuditLogPath), "");
    assertEquals(await Deno.readTextFile(exportsLogPath), "");
  });
});

async function createCliTwinCleanupFixture(options: {
  rootDir: string;
  sessionId: string;
  providerSessionId: string;
  sourceName: string;
  twinTime: string;
}) {
  const sourceDir = `${options.rootDir}/sources`;
  await Deno.mkdir(sourceDir, { recursive: true });
  const sourceFilePath = `${sourceDir}/${options.sourceName}.jsonl`;
  await Deno.writeTextFile(sourceFilePath, "{}\n");

  const store = new PersistentSessionStateStore({
    katoDir: options.rootDir,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    makeSessionId: () => options.sessionId,
  });
  const metadata = await store.getOrCreateSessionMetadata({
    provider: "codex",
    providerSessionId: options.providerSessionId,
    sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  metadata.nextTwinSeq = 2;
  metadata.recentFingerprints = ["fingerprint-1"];
  metadata.ingestionActivatedAt = "2026-02-10T00:00:00.000Z";
  await store.saveSessionMetadata(metadata);
  await Deno.writeTextFile(metadata.twinPath, '{"event":"twin"}\n');
  const twinTime = new Date(options.twinTime);
  await Deno.utime(metadata.twinPath, twinTime, twinTime);
  const indexEntry = (await store.loadDaemonControlIndex()).sessions.find((
    entry,
  ) => entry.sessionId === metadata.sessionId);

  return {
    metadataPath: indexEntry?.metadataPath ?? "",
    twinPath: metadata.twinPath,
    sessionId: metadata.sessionId,
  };
}

Deno.test("runDaemonCli clean --twins removes old twin files and preserves metadata by default", async () => {
  await withTestTempDir("daemon-cli-clean-twins-", async (rootDir) => {
    const runtimeDir = `${rootDir}/runtime`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const controlStore = makeInMemoryControlStore();
    const statusStore = makeInMemoryStatusStore();
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );
    const harness = makeRuntimeHarness(runtimeDir);

    const oldSession = await createCliTwinCleanupFixture({
      rootDir,
      sessionId: "cli-clean-old",
      providerSessionId: "cli-clean-old",
      sourceName: "cli-clean-old",
      twinTime: "2026-02-01T00:00:00.000Z",
    });
    const recentSession = await createCliTwinCleanupFixture({
      rootDir,
      sessionId: "cli-clean-recent",
      providerSessionId: "cli-clean-recent",
      sourceName: "cli-clean-recent",
      twinTime: "2026-02-25T00:00:00.000Z",
    });

    const code = await runDaemonCli(["clean", "--twins", "7"], {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
    });

    assertEquals(code, 0);
    assertStringIncludes(harness.stdout.join(""), "clean completed");
    assertStringIncludes(harness.stdout.join(""), "twinsDeleted=1");
    assertStringIncludes(harness.stdout.join(""), "twinFilesDeleted=1");

    await Deno.stat(oldSession.metadataPath);
    await assertRejects(
      () => Deno.stat(oldSession.twinPath),
      Deno.errors.NotFound,
    );
    await Deno.stat(recentSession.metadataPath);
    await Deno.stat(recentSession.twinPath);

    const store = new PersistentSessionStateStore({ katoDir: rootDir });
    const reloaded = (await store.listSessionMetadata()).find((entry) =>
      entry.sessionId === oldSession.sessionId
    );
    assertEquals(reloaded?.nextTwinSeq, 1);
    assertEquals(reloaded?.recentFingerprints, []);
    assertEquals(reloaded?.ingestionActivatedAt, undefined);
  });
});

Deno.test("runDaemonCli clean --twins --delete-metadata removes matched metadata files", async () => {
  await withTestTempDir(
    "daemon-cli-clean-twins-delete-meta-",
    async (rootDir) => {
      const runtimeDir = `${rootDir}/runtime`;
      await Deno.mkdir(runtimeDir, { recursive: true });
      const controlStore = makeInMemoryControlStore();
      const statusStore = makeInMemoryStatusStore();
      const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
      const { store: configStore } = makeInMemoryConfigStore(
        defaultRuntimeConfig,
      );
      const harness = makeRuntimeHarness(runtimeDir);

      const oldSession = await createCliTwinCleanupFixture({
        rootDir,
        sessionId: "cli-clean-delete-meta",
        providerSessionId: "cli-clean-delete-meta",
        sourceName: "cli-clean-delete-meta",
        twinTime: "2026-02-01T00:00:00.000Z",
      });

      const code = await runDaemonCli(
        ["clean", "--twins", "7", "--delete-metadata"],
        {
          runtime: harness.runtime,
          defaultRuntimeConfig,
          configStore,
          statusStore,
          controlStore: controlStore.store,
        },
      );

      assertEquals(code, 0);
      assertStringIncludes(harness.stdout.join(""), "deleteMetadata=true");
      assertStringIncludes(harness.stdout.join(""), "metadataFilesDeleted=1");
      await assertRejects(
        () => Deno.stat(oldSession.metadataPath),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.stat(oldSession.twinPath),
        Deno.errors.NotFound,
      );
    },
  );
});

Deno.test("runDaemonCli clean --twins dry-run reports candidate counts", async () => {
  await withTestTempDir(
    "daemon-cli-clean-twins-dry-",
    async (rootDir) => {
      const runtimeDir = `${rootDir}/runtime`;
      await Deno.mkdir(runtimeDir, { recursive: true });
      const controlStore = makeInMemoryControlStore();
      const statusStore = makeInMemoryStatusStore();
      const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
      const { store: configStore } = makeInMemoryConfigStore(
        defaultRuntimeConfig,
      );
      const harness = makeRuntimeHarness(runtimeDir);

      const oldSession = await createCliTwinCleanupFixture({
        rootDir,
        sessionId: "cli-clean-dry-run",
        providerSessionId: "cli-clean-dry-run",
        sourceName: "cli-clean-dry-run",
        twinTime: "2026-02-01T00:00:00.000Z",
      });

      const code = await runDaemonCli(
        ["clean", "--twins", "7", "--delete-metadata", "--dry-run"],
        {
          runtime: harness.runtime,
          defaultRuntimeConfig,
          configStore,
          statusStore,
          controlStore: controlStore.store,
        },
      );

      assertEquals(code, 0);
      assertStringIncludes(harness.stdout.join(""), "twinsToDelete=1");
      assertStringIncludes(harness.stdout.join(""), "twinFilesToDelete=1");
      assertStringIncludes(harness.stdout.join(""), "metadataFilesToDelete=1");
      await Deno.stat(oldSession.metadataPath);
      await Deno.stat(oldSession.twinPath);
    },
  );
});

Deno.test("runDaemonCli clean --twins allows cleanup while daemon is running", async () => {
  await withTestTempDir("daemon-cli-clean-running-", async (rootDir) => {
    const runtimeDir = `${rootDir}/runtime`;
    await Deno.mkdir(runtimeDir, { recursive: true });
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
    const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
    const { store: configStore } = makeInMemoryConfigStore(
      defaultRuntimeConfig,
    );
    const harness = makeRuntimeHarness(runtimeDir);

    const oldSession = await createCliTwinCleanupFixture({
      rootDir,
      sessionId: "cli-clean-running",
      providerSessionId: "cli-clean-running",
      sourceName: "cli-clean-running",
      twinTime: "2026-02-01T00:00:00.000Z",
    });

    const code = await runDaemonCli(["clean", "--twins", "7"], {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
    });

    assertEquals(code, 0);
    assertStringIncludes(harness.stdout.join(""), "twinsDeleted=1");
    await Deno.stat(oldSession.metadataPath);
    await assertRejects(
      () => Deno.stat(oldSession.twinPath),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("runDaemonCli export fails when daemon is not running", async () => {
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore({
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  });
  const runtimeDir = ".kato/test-runtime";
  const allowPathPolicy = makePathPolicyGate("allow");
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);

  const harness = makeRuntimeHarness(runtimeDir);
  const code = await runDaemonCli(
    ["export", "session-42", "--output", "exports/session-42.md"],
    {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
      pathPolicyGate: allowPathPolicy,
    },
  );

  assertEquals(code, 1);
  assertEquals(controlStore.requests.length, 0);
  assertStringIncludes(
    harness.stderr.join(""),
    "Export requires a running daemon with a fresh heartbeat",
  );
});

Deno.test("runDaemonCli export fails when daemon heartbeat is stale", async () => {
  const controlStore = makeInMemoryControlStore();
  const statusStore = makeInMemoryStatusStore({
    schemaVersion: 1,
    generatedAt: "2026-02-22T09:00:00.000Z",
    heartbeatAt: "2026-02-22T09:00:00.000Z",
    daemonRunning: true,
    daemonPid: 4242,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  });
  const runtimeDir = ".kato/test-runtime";
  const allowPathPolicy = makePathPolicyGate("allow");
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);

  const harness = makeRuntimeHarness(runtimeDir);
  const code = await runDaemonCli(
    ["export", "session-42", "--output", "exports/session-42.md"],
    {
      runtime: harness.runtime,
      defaultRuntimeConfig,
      configStore,
      statusStore,
      controlStore: controlStore.store,
      pathPolicyGate: allowPathPolicy,
    },
  );

  assertEquals(code, 1);
  assertEquals(controlStore.requests.length, 0);
  assertStringIncludes(
    harness.stderr.join(""),
    "Export requires a running daemon with a fresh heartbeat",
  );
});

Deno.test("runDaemonCli denies export when path policy rejects output path", async () => {
  const controlStore = makeInMemoryControlStore();
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
  });
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

Deno.test("runDaemonCli restart fails when stop does not complete before timeout", async () => {
  const runtimeDir = ".kato/test-runtime";
  const defaultRuntimeConfig = makeDefaultRuntimeConfig(runtimeDir);
  const { store: configStore } = makeInMemoryConfigStore(defaultRuntimeConfig);
  const harness = makeRuntimeHarness(runtimeDir);
  const daemonLauncher = makeDaemonLauncher(31337);

  const currentStatus: DaemonStatusSnapshot = {
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

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(_next: DaemonStatusSnapshot) {
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
      return Promise.resolve({
        ...request,
        ...(request.payload ? { payload: { ...request.payload } } : {}),
      });
    },
    markProcessed(_requestId: string) {
      return Promise.resolve();
    },
  };

  const code = await withMockedDateNow(
    [0, 0, 20_000],
    () =>
      runDaemonCli(["restart"], {
        runtime: harness.runtime,
        defaultRuntimeConfig,
        configStore,
        statusStore,
        controlStore,
        daemonLauncher: daemonLauncher.launcher,
      }),
  );

  assertEquals(code, 1);
  assertEquals(controlRequests.length, 1);
  assertEquals(controlRequests[0]?.command, "stop");
  assertEquals(daemonLauncher.launchedCount.value, 0);
  assertStringIncludes(
    harness.stderr.join(""),
    "Timed out waiting for daemon to stop before restart",
  );
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

Deno.test("runDaemonCli returns usage error for removed attach-era commands", async () => {
  const harness = makeRuntimeHarness(".kato/test-runtime");
  const code = await runDaemonCli(["attach", "abc12345"], {
    runtime: harness.runtime,
    statusStore: makeInMemoryStatusStore(),
    controlStore: makeInMemoryControlStore().store,
  });

  assertEquals(code, 2);
  assertStringIncludes(harness.stderr.join(""), "Unknown command: attach");
});
