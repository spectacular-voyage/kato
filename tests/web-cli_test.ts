import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_KATO_WEB_PORT } from "@kato/shared";
import { parseDaemonCliArgs } from "../apps/cli/src/parser.ts";
import { runDaemonCli } from "../apps/cli/src/router.ts";
import type { DaemonCliRuntime } from "../apps/cli/src/types.ts";
import type { RuntimeConfig, SharedBehaviorConfig } from "@kato/shared";
import {
  WebConfigFileStore,
  type WebProcessLauncherLike,
  WebServerStatusFileStore,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

function makeRuntimeHarness(runtimeDir: string): {
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
      now: () => new Date("2026-03-07T20:00:00.000Z"),
      pid: Deno.pid,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
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
    "--password",
    "secret-pass",
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

  const status = parseDaemonCliArgs(["web", "status", "--json"]);
  assertEquals(status.kind, "command");
  if (status.kind !== "command" || status.command.name !== "web-status") {
    throw new Error("expected web-status command");
  }
  assertEquals(status.command.asJson, true);

  assertThrows(() => parseDaemonCliArgs(["web", "init", "--port", "0"]));
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
    const harness = makeRuntimeHarness(runtimeDir);

    const code = await runDaemonCli(
      [
        "web",
        "init",
        "--username",
        "dj",
        "--password",
        "secret-pass",
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
      const webLauncher: WebProcessLauncherLike = {
        launchDetached: async () => Deno.pid,
      };

      const initHarness = makeRuntimeHarness(runtimeDir);
      const initCode = await runDaemonCli(
        [
          "web",
          "init",
          "--username",
          "dj",
          "--password",
          "secret-pass",
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
