import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_KATO_WEB_PORT } from "@kato/shared";
import { resolveWebInitPassword } from "../apps/cli/src/commands/web.ts";
import { parseDaemonCliArgs } from "../apps/cli/src/parser.ts";
import { runDaemonCli } from "../apps/cli/src/router.ts";
import type {
  DaemonCliRuntime,
  DaemonCliWebInitPasswordRuntime,
} from "../apps/cli/src/types.ts";
import type { RuntimeConfig, SharedBehaviorConfig } from "@kato/shared";
import {
  createInitializedWebConfig,
  isProcessAlive,
  terminateProcess,
  WebConfigFileStore,
  type WebProcessLauncherLike,
  WebServerStatusFileStore,
} from "../apps/runtime/src/mod.ts";
import { withIsolatedEnvironment } from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

function makeRuntimeHarness(
  runtimeDir: string,
  options: {
    webInitPassword?: DaemonCliWebInitPasswordRuntime;
  } = {},
): {
  runtime: DaemonCliRuntime;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    runtime: {
      runtimeDir,
      configPath: join(runtimeDir, "kato-daemon-config.yaml"),
      statusPath: join(runtimeDir, "status.json"),
      controlPath: join(runtimeDir, "daemon-control.json"),
      cwdPath: runtimeDir,
      isStdinTerminal: () => false,
      ...(options.webInitPassword
        ? { webInitPassword: options.webInitPassword }
        : {}),
      now: () => new Date("2026-03-07T20:00:00.000Z"),
      pid: Deno.pid,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

function spawnLongRunningProcess(): Deno.ChildProcess {
  if (Deno.build.os === "windows") {
    return new Deno.Command("powershell.exe", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Start-Sleep -Seconds 3600",
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
  }

  return new Deno.Command("sleep", {
    args: ["3600"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
}

function makeDefaultRuntimeConfig(
  runtimeDir: string,
  katoDir: string,
): RuntimeConfig {
  return {
    schemaVersion: 1,
    runtimeDir,
    katoDir,
    providerSessionRoots: { claude: [], codex: [], gemini: [] },
    cleanSessionStatesOnShutdown: false,
    daemonFeatureFlags: {
      daemonExportEnabled: true,
      captureIncludeSystemEvents: false,
    },
    logging: { operationalLevel: "info", auditLevel: "info" },
    daemonMaxMemoryMb: 512,
  };
}

function makeDefaultSharedConfig(): SharedBehaviorConfig {
  return {
    schemaVersion: 1,
    allowedWriteRoots: [],
    exportMarkdownFrontmatter: {
      includeFrontmatterInMarkdownRecordings: true,
      includeUpdatedInFrontmatter: true,
      addParticipantUsernameToFrontmatter: false,
      addParticipantUsernameToHeadings: false,
      includeSessionIds: true,
      includeWorkspaceIds: true,
      includeRecordingIds: true,
      includeConversationEventKinds: true,
    },
    exportFeatureFlags: {
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
      writerIncludeToolCalls: true,
      writerIncludeToolResults: false,
      writerIncludeDecisionPrompt: true,
      writerIncludeDecisionOptions: true,
      writerIncludeDecisionSelection: true,
      writerItalicizeUserMessages: false,
    },
  };
}

Deno.test("cli parser parses web subcommands", () => {
  const init = parseDaemonCliArgs([
    "web",
    "init",
    "--username",
    "dj",
    "--password-stdin",
    "--host",
    "127.0.0.1",
    "--port",
    "3173",
  ]);
  assertEquals(init.kind, "command");
  if (init.kind !== "command" || init.command.name !== "web-init") {
    throw new Error("expected web-init command");
  }
  assertEquals(init.command.hostname, "127.0.0.1");
  assertEquals(init.command.port, 3173);
  assertEquals(init.command.username, "dj");
  assertEquals(init.command.passwordFromStdin, true);

  const status = parseDaemonCliArgs(["web", "status", "--json"]);
  assertEquals(status.kind, "command");
  if (status.kind !== "command" || status.command.name !== "web-status") {
    throw new Error("expected web-status command");
  }
  assertEquals(status.command.asJson, true);

  const restart = parseDaemonCliArgs(["web", "restart"]);
  assertEquals(restart.kind, "command");
  if (restart.kind !== "command" || restart.command.name !== "web-restart") {
    throw new Error("expected web-restart command");
  }

  assertThrows(() => parseDaemonCliArgs(["web", "init", "--port", "0"]));
});

Deno.test("resolveWebInitPassword prefers --password-stdin over env or prompt", async () => {
  const calls: string[] = [];
  const password = await resolveWebInitPassword(
    { passwordFromStdin: true },
    {
      readPasswordFromStdin: () => {
        calls.push("stdin");
        return Promise.resolve("stdin-pass");
      },
      readPasswordFromEnv: () => {
        calls.push("env");
        return "env-pass";
      },
      isInteractiveTerminal: () => {
        calls.push("tty");
        return true;
      },
      promptForPassword: () => {
        calls.push("prompt");
        return Promise.resolve("prompt-pass");
      },
    },
  );

  assertEquals(password, "stdin-pass");
  assertEquals(calls, ["stdin"]);
});

Deno.test("resolveWebInitPassword prefers env before interactive prompt", async () => {
  const calls: string[] = [];
  const password = await resolveWebInitPassword(
    {},
    {
      readPasswordFromEnv: () => {
        calls.push("env");
        return "env-pass";
      },
      isInteractiveTerminal: () => {
        calls.push("tty");
        return true;
      },
      promptForPassword: () => {
        calls.push("prompt");
        return Promise.resolve("prompt-pass");
      },
    },
  );

  assertEquals(password, "env-pass");
  assertEquals(calls, ["env"]);
});

Deno.test("resolveWebInitPassword falls back to interactive prompt on a TTY", async () => {
  const calls: string[] = [];
  const password = await resolveWebInitPassword(
    {},
    {
      readPasswordFromEnv: () => {
        calls.push("env");
        return undefined;
      },
      isInteractiveTerminal: () => {
        calls.push("tty");
        return true;
      },
      promptForPassword: () => {
        calls.push("prompt");
        return Promise.resolve("prompt-pass");
      },
    },
  );

  assertEquals(password, "prompt-pass");
  assertEquals(calls, ["env", "tty", "prompt"]);
});

Deno.test("resolveWebInitPassword fails closed without a password source or TTY", async () => {
  await assertRejects(
    () =>
      resolveWebInitPassword(
        {},
        {
          readPasswordFromEnv: () => undefined,
          isInteractiveTerminal: () => false,
          promptForPassword: () => Promise.resolve("prompt-pass"),
        },
      ),
    Error,
    "Web init requires KATO_WEB_PASSWORD, --password-stdin, or an interactive terminal prompt.",
  );
});

Deno.test("resolveWebInitPassword reads KATO_WEB_PASSWORD from process env when no override is injected", async () => {
  await withIsolatedEnvironment(async () => {
    const previous = Deno.env.get("KATO_WEB_PASSWORD");
    try {
      Deno.env.set("KATO_WEB_PASSWORD", "env-pass");
      const password = await resolveWebInitPassword(
        {},
        { isInteractiveTerminal: () => false },
      );
      assertEquals(password, "env-pass");
    } finally {
      if (previous === undefined) {
        Deno.env.delete("KATO_WEB_PASSWORD");
      } else {
        Deno.env.set("KATO_WEB_PASSWORD", previous);
      }
    }
  });
});

Deno.test("runDaemonCli web start fails closed until web init runs", async () => {
  await withTestTempDir("web-cli-unconfigured-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    const harness = makeRuntimeHarness(runtimeDir);

    const code = await runDaemonCli(["web", "start"], {
      runtime: harness.runtime,
      defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
      defaultSharedConfig: makeDefaultSharedConfig(),
    });

    assertEquals(code, 1);
    assertStringIncludes(
      harness.stderr.join(""),
      "Run `kato web init` before `kato web start`.",
    );
  });
});

Deno.test("runDaemonCli web init fails closed when no password source is configured", async () => {
  await withTestTempDir("web-cli-missing-password-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    const harness = makeRuntimeHarness(runtimeDir, {
      webInitPassword: {
        readPasswordFromEnv: () => undefined,
      },
    });

    const code = await runDaemonCli(
      ["web", "init", "--username", "dj"],
      {
        runtime: harness.runtime,
        defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
        defaultSharedConfig: makeDefaultSharedConfig(),
      },
    );

    assertEquals(code, 1);
    assertStringIncludes(
      harness.stderr.join(""),
      "Web init requires KATO_WEB_PASSWORD, --password-stdin, or an interactive terminal prompt.",
    );
  });
});

Deno.test("runDaemonCli web init defaults to the standard web port", async () => {
  await withTestTempDir("web-cli-default-port-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    const webConfigStore = new WebConfigFileStore(
      join(rootDir, "web", "kato-web-config.yaml"),
    );
    const webStatusStore = new WebServerStatusFileStore(
      join(rootDir, "web", "kato-web-status.json"),
      () => new Date("2026-03-07T20:00:00.000Z"),
    );
    const harness = makeRuntimeHarness(runtimeDir, {
      webInitPassword: {
        readPasswordFromEnv: () => "secret-pass",
      },
    });

    const code = await runDaemonCli(
      [
        "web",
        "init",
        "--username",
        "dj",
      ],
      {
        runtime: harness.runtime,
        defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
        defaultSharedConfig: makeDefaultSharedConfig(),
        webConfigStore,
        webStatusStore,
      },
    );

    assertEquals(code, 0);
    const savedConfig = await webConfigStore.load();
    assertEquals(savedConfig.port, DEFAULT_KATO_WEB_PORT);
    assertNotEquals(savedConfig.auth.passwordHash, "secret-pass");
    assertEquals(
      (harness.stdout.join("") + harness.stderr.join("")).includes(
        "secret-pass",
      ),
      false,
    );
  });
});

Deno.test("runDaemonCli web init short-circuits existing config before requiring a password source", async () => {
  await withTestTempDir("web-cli-existing-config-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    const webConfigStore = new WebConfigFileStore(
      join(rootDir, "web", "kato-web-config.yaml"),
    );
    await webConfigStore.ensureInitialized(
      await createInitializedWebConfig({
        hostname: "127.0.0.1",
        port: 3187,
        username: "existing-user",
        password: "existing-pass",
      }),
    );
    const harness = makeRuntimeHarness(runtimeDir);

    const code = await runDaemonCli(
      ["web", "init", "--username", "new-user"],
      {
        runtime: harness.runtime,
        defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
        defaultSharedConfig: makeDefaultSharedConfig(),
        webConfigStore,
      },
    );

    assertEquals(code, 0);
    assertStringIncludes(
      harness.stdout.join(""),
      "web config already exists at",
    );
    const savedConfig = await webConfigStore.load();
    assertEquals(savedConfig.auth.username, "existing-user");
  });
});

Deno.test("runDaemonCli web init reports invalid existing config before reading password input", async () => {
  await withTestTempDir("web-cli-invalid-config-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    await Deno.mkdir(join(rootDir, "web"), { recursive: true });
    await Deno.writeTextFile(
      join(rootDir, "web", "kato-web-config.yaml"),
      "auth: [broken",
    );
    const harness = makeRuntimeHarness(runtimeDir);

    const code = await runDaemonCli(
      ["web", "init", "--username", "dj"],
      {
        runtime: harness.runtime,
        defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
        defaultSharedConfig: makeDefaultSharedConfig(),
      },
    );

    assertEquals(code, 1);
    assertStringIncludes(
      harness.stderr.join(""),
      "Web config file contains invalid YAML",
    );
  });
});

Deno.test("runDaemonCli web status reports stale plain-text status when the stored process is gone", async () => {
  await withTestTempDir("web-cli-status-stale-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    const webConfigStore = new WebConfigFileStore(
      join(rootDir, "web", "kato-web-config.yaml"),
    );
    const webStatusStore = new WebServerStatusFileStore(
      join(rootDir, "web", "kato-web-status.json"),
      () => new Date("2026-03-07T20:00:00.000Z"),
    );
    await webConfigStore.ensureInitialized(
      await createInitializedWebConfig({
        hostname: "127.0.0.1",
        port: 3187,
        username: "dj",
        password: "secret-pass",
      }),
    );
    await webStatusStore.save({
      schemaVersion: 1,
      running: true,
      hostname: "127.0.0.1",
      port: 3187,
      pid: 999999,
      startedAt: "2026-03-07T20:00:00.000Z",
      heartbeatAt: "2026-03-07T20:00:05.000Z",
      url: "http://127.0.0.1:3187/",
      version: "test-build",
    });

    const harness = makeRuntimeHarness(runtimeDir);
    const code = await runDaemonCli(["web", "status"], {
      runtime: harness.runtime,
      defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
      defaultSharedConfig: makeDefaultSharedConfig(),
      webConfigStore,
      webStatusStore,
    });

    assertEquals(code, 0);
    assertStringIncludes(
      harness.stdout.join(""),
      "kato web: stale status",
    );
  });
});

Deno.test(
  "runDaemonCli web init, start, and status manage explicit web lifecycle state",
  async () => {
    await withTestTempDir("web-cli-lifecycle-", async (rootDir) => {
      const runtimeDir = join(rootDir, "daemon");
      await Deno.mkdir(runtimeDir, { recursive: true });
      const webConfigStore = new WebConfigFileStore(
        join(rootDir, "web", "kato-web-config.yaml"),
      );
      const webStatusStore = new WebServerStatusFileStore(
        join(rootDir, "web", "kato-web-status.json"),
        () => new Date("2026-03-07T20:00:00.000Z"),
      );
      const launchedPid = Deno.pid;
      const webLauncher: WebProcessLauncherLike = {
        async launchDetached() {
          await webStatusStore.save({
            schemaVersion: 1,
            running: true,
            hostname: "127.0.0.1",
            port: 3187,
            pid: launchedPid,
            startedAt: "2026-03-07T20:00:00.000Z",
            heartbeatAt: "2026-03-07T20:00:00.000Z",
            url: "http://127.0.0.1:3187/",
            version: "test-build",
          });
          return launchedPid;
        },
      };

      const initHarness = makeRuntimeHarness(runtimeDir, {
        webInitPassword: {
          readPasswordFromEnv: () => "secret-pass",
        },
      });
      const initCode = await runDaemonCli(
        [
          "web",
          "init",
          "--username",
          "dj",
          "--host",
          "127.0.0.1",
          "--port",
          "3187",
        ],
        {
          runtime: initHarness.runtime,
          defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
          defaultSharedConfig: makeDefaultSharedConfig(),
          webConfigStore,
          webStatusStore,
          webLauncher,
        },
      );
      assertEquals(initCode, 0);
      assertStringIncludes(initHarness.stdout.join(""), "web config");
      const savedConfig = await webConfigStore.load();
      assertEquals(savedConfig.auth.username, "dj");

      const startHarness = makeRuntimeHarness(runtimeDir);
      const startCode = await runDaemonCli(["web", "start"], {
        runtime: startHarness.runtime,
        defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
        defaultSharedConfig: makeDefaultSharedConfig(),
        webConfigStore,
        webStatusStore,
        webLauncher,
      });
      assertEquals(startCode, 0);
      assertStringIncludes(
        startHarness.stdout.join(""),
        "kato web started in background",
      );
      const savedStatus = await webStatusStore.load();
      assertEquals(savedStatus.running, true);
      assertEquals(savedStatus.pid, launchedPid);

      const statusHarness = makeRuntimeHarness(runtimeDir);
      const statusCode = await runDaemonCli(["web", "status", "--json"], {
        runtime: statusHarness.runtime,
        defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
        defaultSharedConfig: makeDefaultSharedConfig(),
        webConfigStore,
        webStatusStore,
        webLauncher,
      });
      assertEquals(statusCode, 0);
      const statusPayload = JSON.parse(statusHarness.stdout.join("")) as {
        configured: boolean;
        running: boolean;
        stale?: boolean;
        state: string;
        port: number;
      };
      assertEquals(statusPayload.configured, true);
      assertEquals(["running", "stale"].includes(statusPayload.state), true);
      assertEquals(statusPayload.port, 3187);
    });
  },
);

Deno.test(
  "runDaemonCli web restart stops a running web process and starts it again",
  async () => {
    await withTestTempDir("web-cli-restart-", async (rootDir) => {
      const runtimeDir = join(rootDir, "daemon");
      await Deno.mkdir(runtimeDir, { recursive: true });
      const webConfigStore = new WebConfigFileStore(
        join(rootDir, "web", "kato-web-config.yaml"),
      );
      const webStatusStore = new WebServerStatusFileStore(
        join(rootDir, "web", "kato-web-status.json"),
        () => new Date("2026-03-07T20:00:00.000Z"),
      );
      await webConfigStore.ensureInitialized(
        await createInitializedWebConfig({
          hostname: "127.0.0.1",
          port: 3187,
          username: "dj",
          password: "secret-pass",
        }),
      );

      const runningChild = spawnLongRunningProcess();

      try {
        await webStatusStore.save({
          schemaVersion: 1,
          running: true,
          hostname: "127.0.0.1",
          port: 3187,
          pid: runningChild.pid,
          startedAt: "2026-03-07T20:00:00.000Z",
          heartbeatAt: "2026-03-07T20:00:00.000Z",
          url: "http://127.0.0.1:3187/",
          version: "test-build",
        });

        const webLauncher: WebProcessLauncherLike = {
          async launchDetached({ hostname, port }) {
            await webStatusStore.save({
              schemaVersion: 1,
              running: true,
              hostname,
              port,
              pid: Deno.pid,
              startedAt: "2026-03-07T20:00:01.000Z",
              heartbeatAt: "2026-03-07T20:00:01.000Z",
              url: `http://${hostname}:${port}/`,
              version: "test-build",
            });
            return Deno.pid;
          },
        };

        const harness = makeRuntimeHarness(runtimeDir);
        const code = await runDaemonCli(["web", "restart"], {
          runtime: harness.runtime,
          defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
          defaultSharedConfig: makeDefaultSharedConfig(),
          webConfigStore,
          webStatusStore,
          webLauncher,
        });

        assertEquals(code, 0);
        assertStringIncludes(
          harness.stdout.join(""),
          `kato web stopped (pid: ${runningChild.pid})`,
        );
        assertStringIncludes(
          harness.stdout.join(""),
          "kato web started in background",
        );
        assertEquals(isProcessAlive(runningChild.pid), false);
        const savedStatus = await webStatusStore.load();
        assertEquals(savedStatus.running, true);
        assertEquals(savedStatus.pid, Deno.pid);
      } finally {
        if (isProcessAlive(runningChild.pid)) {
          terminateProcess(runningChild.pid, true);
        }
        await runningChild.status;
      }
    });
  },
);

Deno.test(
  "runDaemonCli web start clears status when startup acknowledgement never arrives",
  async () => {
    await withTestTempDir("web-cli-start-ack-failure-", async (rootDir) => {
      const runtimeDir = join(rootDir, "daemon");
      await Deno.mkdir(runtimeDir, { recursive: true });
      const webConfigStore = new WebConfigFileStore(
        join(rootDir, "web", "kato-web-config.yaml"),
      );
      const webStatusStore = new WebServerStatusFileStore(
        join(rootDir, "web", "kato-web-status.json"),
        () => new Date("2026-03-07T20:00:00.000Z"),
      );
      const webLauncher: WebProcessLauncherLike = {
        launchDetached: () => Promise.resolve(999999),
      };

      const initHarness = makeRuntimeHarness(runtimeDir, {
        webInitPassword: {
          readPasswordFromEnv: () => "secret-pass",
        },
      });
      const initCode = await runDaemonCli(
        [
          "web",
          "init",
          "--username",
          "dj",
        ],
        {
          runtime: initHarness.runtime,
          defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
          defaultSharedConfig: makeDefaultSharedConfig(),
          webConfigStore,
          webStatusStore,
          webLauncher,
        },
      );
      assertEquals(initCode, 0);

      const startHarness = makeRuntimeHarness(runtimeDir);
      const startCode = await runDaemonCli(["web", "start"], {
        runtime: startHarness.runtime,
        defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
        defaultSharedConfig: makeDefaultSharedConfig(),
        webConfigStore,
        webStatusStore,
        webLauncher,
      });

      assertEquals(startCode, 1);
      assertStringIncludes(
        startHarness.stderr.join(""),
        "startup acknowledgement",
      );

      const savedStatus = await webStatusStore.load();
      assertEquals(savedStatus.running, false);
      assertEquals(savedStatus.pid, undefined);
    });
  },
);

Deno.test("runDaemonCli web status prints the unconfigured message in text mode", async () => {
  await withTestTempDir("web-cli-status-unconfigured-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    const harness = makeRuntimeHarness(runtimeDir);

    const code = await runDaemonCli(["web", "status"], {
      runtime: harness.runtime,
      defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
      defaultSharedConfig: makeDefaultSharedConfig(),
    });

    assertEquals(code, 0);
    assertStringIncludes(harness.stdout.join(""), "kato web: unconfigured");
  });
});

Deno.test("runDaemonCli web stop clears stale stored status when the process is already gone", async () => {
  await withTestTempDir("web-cli-stop-stale-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    const webStatusStore = new WebServerStatusFileStore(
      join(rootDir, "web", "kato-web-status.json"),
      () => new Date("2026-03-07T20:00:00.000Z"),
    );
    await webStatusStore.save({
      schemaVersion: 1,
      running: true,
      hostname: "127.0.0.1",
      port: 3187,
      pid: 999999,
      startedAt: "2026-03-07T20:00:00.000Z",
      heartbeatAt: "2026-03-07T20:00:05.000Z",
      url: "http://127.0.0.1:3187/",
      version: "test-build",
    });

    const harness = makeRuntimeHarness(runtimeDir);
    const code = await runDaemonCli(["web", "stop"], {
      runtime: harness.runtime,
      defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
      defaultSharedConfig: makeDefaultSharedConfig(),
      webStatusStore,
    });

    assertEquals(code, 0);
    assertStringIncludes(harness.stdout.join(""), "kato web already stopped.");
    const savedStatus = await webStatusStore.load();
    assertEquals(savedStatus.running, false);
    assertEquals(savedStatus.pid, undefined);
  });
});

Deno.test("runDaemonCli ignores a broken web config for unrelated commands", async () => {
  await withTestTempDir("web-cli-broken-config-", async (rootDir) => {
    const runtimeDir = join(rootDir, "daemon");
    await Deno.mkdir(runtimeDir, { recursive: true });
    await Deno.mkdir(join(rootDir, "web"), { recursive: true });
    await Deno.writeTextFile(
      join(rootDir, "web", "kato-web-config.yaml"),
      "not: [valid yaml",
    );
    const harness = makeRuntimeHarness(runtimeDir);

    const code = await runDaemonCli(["workspace", "list"], {
      runtime: harness.runtime,
      defaultRuntimeConfig: makeDefaultRuntimeConfig(runtimeDir, rootDir),
      defaultSharedConfig: makeDefaultSharedConfig(),
    });

    assertEquals(code, 0);
    assertEquals(harness.stdout.join(""), "no registered workspaces\n");
  });
});
