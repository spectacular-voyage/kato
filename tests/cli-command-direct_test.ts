import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { DaemonStatusSnapshot } from "@kato/shared";
import {
  AuditLogger,
  createDefaultCliConfig,
  createDefaultRuntimeConfig,
  createDefaultSharedBehaviorConfig,
  createDefaultStatusSnapshot,
  createDefaultWebConfig,
  createDefaultWebServerStatus,
  type LogRecord,
  type LogSink,
  StructuredLogger,
} from "@kato/runtime";
import type { DaemonCliCommandContext } from "../apps/cli/src/commands/context.ts";
import { runExportCommand } from "../apps/cli/src/commands/export.ts";
import { runStartCommand } from "../apps/cli/src/commands/start.ts";
import { runWorkspaceInitCommand } from "../apps/cli/src/commands/workspace_init.ts";
import { withLockedEnvironment } from "./test_env.ts";
import { makeTestTempDir, removePathIfPresent } from "./test_temp.ts";

const NOW = new Date("2026-03-06T12:00:00.000Z");

class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

type StatusLoadStep = DaemonStatusSnapshot | Error;
type EnqueuedControlRequest = Parameters<
  DaemonCliCommandContext["controlStore"]["enqueue"]
>[0];
type StoredControlRequest = Awaited<
  ReturnType<DaemonCliCommandContext["controlStore"]["enqueue"]>
>;
type PathPolicyDecision = Awaited<
  ReturnType<DaemonCliCommandContext["pathPolicyGate"]["evaluateWritePath"]>
>;

function makeStatusSnapshot(
  heartbeatAt: string,
  options: {
    daemonRunning?: boolean;
    daemonPid?: number;
  } = {},
): DaemonStatusSnapshot {
  const snapshot = createDefaultStatusSnapshot(new Date(heartbeatAt));
  return {
    ...snapshot,
    generatedAt: heartbeatAt,
    heartbeatAt,
    daemonRunning: options.daemonRunning ?? snapshot.daemonRunning,
    ...(options.daemonPid !== undefined
      ? { daemonPid: options.daemonPid }
      : {}),
  };
}

function makeSequencedStatusStore(steps: StatusLoadStep[]) {
  let index = 0;
  return {
    loadCalls: () => index,
    store: {
      load(): Promise<DaemonStatusSnapshot> {
        const step = steps[Math.min(index, steps.length - 1)]!;
        index += 1;
        if (step instanceof Error) {
          return Promise.reject(step);
        }
        return Promise.resolve(step);
      },
      save(_snapshot: DaemonStatusSnapshot): Promise<void> {
        // Not used by these command-level tests.
        return Promise.resolve();
      },
    },
  };
}

function makeCommandContext(root: string, options: {
  statusSteps: StatusLoadStep[];
  launchedPid?: number;
  cwdPath?: string;
  runtimeDir?: string;
  enqueueImpl?: (
    request: EnqueuedControlRequest,
  ) => Promise<StoredControlRequest>;
  pathPolicyDecision?: Omit<PathPolicyDecision, "targetPath">;
}): {
  ctx: DaemonCliCommandContext;
  stdout: string[];
  stderr: string[];
  sink: MemorySink;
  launchCalls: () => number;
} {
  const runtimeDir = options.runtimeDir ?? join(root, "runtime");
  const katoDir = join(root, ".kato");
  const runtimeConfig = createDefaultRuntimeConfig({
    runtimeDir,
    katoDir,
    daemonMaxMemoryMb: 256,
    logging: {
      operationalLevel: "info",
      auditLevel: "info",
    },
  });
  const sharedConfig = createDefaultSharedBehaviorConfig({
    allowedWriteRoots: [root, katoDir],
  });
  const cliConfig = createDefaultCliConfig({
    logging: {
      operationalLevel: "info",
      auditLevel: "info",
    },
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = new MemorySink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => NOW,
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => NOW,
    }),
  );
  const statusStore = makeSequencedStatusStore(options.statusSteps);
  let launchCalls = 0;
  const launchedPid = options.launchedPid ?? 9001;

  const ctx: DaemonCliCommandContext = {
    runtime: {
      runtimeDir,
      configPath: join(runtimeDir, "kato-daemon-config.yaml"),
      statusPath: join(runtimeDir, "status.json"),
      controlPath: join(runtimeDir, "control.json"),
      cwdPath: options.cwdPath ?? root,
      allowedWriteRoots: [root, katoDir],
      providerSessionRoots: runtimeConfig.providerSessionRoots,
      now: () => NOW,
      pid: 4242,
      writeStdout(text: string) {
        stdout.push(text);
      },
      writeStderr(text: string) {
        stderr.push(text);
      },
    },
    configStore: {
      load() {
        return Promise.resolve(runtimeConfig);
      },
      ensureInitialized() {
        return Promise.resolve({
          created: false,
          config: runtimeConfig,
          path: join(runtimeDir, "kato-daemon-config.yaml"),
        });
      },
    },
    sharedConfigStore: {
      load() {
        return Promise.resolve(sharedConfig);
      },
      ensureInitialized() {
        return Promise.resolve({
          created: false,
          config: sharedConfig,
          path: join(katoDir, "shared", "kato-shared-config.yaml"),
        });
      },
      save(_config) {
        // Not used by these command-level tests.
        return Promise.resolve();
      },
    },
    cliConfigStore: {
      load() {
        return Promise.resolve(cliConfig);
      },
      ensureInitialized() {
        return Promise.resolve({
          created: false,
          config: cliConfig,
          path: join(katoDir, "cli", "kato-cli-config.yaml"),
        });
      },
    },
    runtimeConfig,
    sharedConfig,
    cliConfig,
    defaultRuntimeConfig: runtimeConfig,
    defaultSharedConfig: sharedConfig,
    defaultCliConfig: cliConfig,
    webConfigStore: {
      load() {
        return Promise.resolve(createDefaultWebConfig());
      },
      ensureInitialized() {
        return Promise.resolve({
          created: false,
          config: createDefaultWebConfig(),
          path: join(katoDir, "web", "kato-web-config.yaml"),
        });
      },
    },
    webConfig: createDefaultWebConfig(),
    webStatusStore: {
      load() {
        return Promise.resolve(createDefaultWebServerStatus(NOW));
      },
      save() {
        return Promise.resolve();
      },
    },
    webLauncher: {
      launchDetached() {
        return Promise.resolve(9002);
      },
    },
    statusStore: statusStore.store,
    controlStore: {
      list() {
        return Promise.resolve([]);
      },
      async enqueue(request) {
        if (options.enqueueImpl) {
          return await options.enqueueImpl(request);
        }
        throw new Error("enqueue not implemented in direct command tests");
      },
      markProcessed(_requestId) {
        // Not used by these command-level tests.
        return Promise.resolve();
      },
    },
    daemonLauncher: {
      launchDetached() {
        launchCalls += 1;
        return Promise.resolve(launchedPid);
      },
    },
    pathPolicyGate: {
      evaluateWritePath(targetPath: string) {
        return Promise.resolve({
          decision: options.pathPolicyDecision?.decision ?? "allow",
          targetPath,
          reason: options.pathPolicyDecision?.reason ?? "test",
          canonicalTargetPath: options.pathPolicyDecision?.canonicalTargetPath,
          matchedRoot: options.pathPolicyDecision?.matchedRoot,
        });
      },
    },
    operationalLogger,
    auditLogger,
    resolveUserConfigStore: () => ({
      load() {
        return Promise.reject(
          new Error(
            "user config store not implemented in direct command tests",
          ),
        );
      },
      ensureInitialized() {
        return Promise.reject(
          new Error(
            "user config store not implemented in direct command tests",
          ),
        );
      },
      save() {
        return Promise.reject(
          new Error(
            "user config store not implemented in direct command tests",
          ),
        );
      },
    }),
  };

  return {
    ctx,
    stdout,
    stderr,
    sink,
    launchCalls: () => launchCalls,
  };
}

async function withCommandTestRoot(
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  await withLockedEnvironment(async () => {
    const root = await makeTestTempDir(prefix);
    try {
      await run(root);
    } finally {
      await removePathIfPresent(root);
    }
  });
}

Deno.test("runStartCommand returns early when daemon is already running and fresh", async () => {
  await withCommandTestRoot("cli-command-start-running-", async (root) => {
    const { ctx, stdout, sink, launchCalls } = makeCommandContext(root, {
      statusSteps: [
        makeStatusSnapshot("2026-03-06T11:59:59.000Z", {
          daemonRunning: true,
          daemonPid: 7777,
        }),
      ],
    });

    await runStartCommand(ctx);

    assertEquals(launchCalls(), 0);
    assertEquals(stdout, ["kato daemon is already running (pid: 7777).\n"]);
    assertEquals(sink.records.length, 0);
  });
});

Deno.test("runStartCommand launches and acknowledges a stopped daemon", async () => {
  await withCommandTestRoot("cli-command-start-ack-", async (root) => {
    const { ctx, stdout, sink, launchCalls } = makeCommandContext(root, {
      statusSteps: [
        makeStatusSnapshot("2026-03-06T11:59:40.000Z", {
          daemonRunning: false,
        }),
        makeStatusSnapshot("2026-03-06T12:00:00.500Z", {
          daemonRunning: true,
          daemonPid: 9001,
        }),
      ],
    });

    await runStartCommand(ctx);

    assertEquals(launchCalls(), 1);
    assertEquals(stdout, ["kato daemon started in background (pid: 9001).\n"]);

    const infoRecord = sink.records.find((record) =>
      record.event === "daemon.start"
    );
    assertExists(infoRecord);
    assertEquals(infoRecord.channel, "operational");
    assertEquals(infoRecord.attributes?.["staleBeforeLaunch"], false);

    const auditRecord = sink.records.find((record) =>
      record.event === "cli.command" &&
      record.attributes?.["commandName"] === "start"
    );
    assertExists(auditRecord);
    assertEquals(auditRecord.channel, "security-audit");
    assertEquals(auditRecord.attributes?.["launchedPid"], 9001);
  });
});

Deno.test("runStartCommand retries transient ack failures and preserves stale-before-launch state", async () => {
  await withCommandTestRoot("cli-command-start-retry-", async (root) => {
    const { ctx, stdout, sink, launchCalls } = makeCommandContext(root, {
      statusSteps: [
        makeStatusSnapshot("2026-03-06T11:59:00.000Z", {
          daemonRunning: true,
          daemonPid: 1111,
        }),
        new Deno.errors.NotFound("missing status"),
        new Error("temporary parse failure"),
        makeStatusSnapshot("2026-03-06T12:00:00.400Z", {
          daemonRunning: true,
          daemonPid: 1234,
        }),
        makeStatusSnapshot("2026-03-06T12:00:00.700Z", {
          daemonRunning: true,
          daemonPid: 9001,
        }),
      ],
    });

    await runStartCommand(ctx);

    assertEquals(launchCalls(), 1);
    assertEquals(stdout, ["kato daemon started in background (pid: 9001).\n"]);

    const retryRecord = sink.records.find((record) =>
      record.event === "daemon.start.ack_poll_retry"
    );
    assertExists(retryRecord);
    assertEquals(retryRecord.channel, "operational");
    assertStringIncludes(
      String(retryRecord.attributes?.["error"] ?? ""),
      "temporary parse failure",
    );

    const infoRecord = sink.records.find((record) =>
      record.event === "daemon.start"
    );
    assertExists(infoRecord);
    assertEquals(infoRecord.attributes?.["staleBeforeLaunch"], true);
    assertEquals(infoRecord.attributes?.["launchedPid"], 9001);
  });
});

Deno.test("runWorkspaceInitCommand creates a workspace config at an explicit directory", async () => {
  await withCommandTestRoot(
    "cli-command-workspace-init-create-",
    async (root) => {
      const workspaceDir = join(root, "notes");
      const { ctx, stdout, sink } = makeCommandContext(root, {
        statusSteps: [makeStatusSnapshot("2026-03-06T12:00:00.000Z")],
        cwdPath: root,
      });

      await runWorkspaceInitCommand(ctx, "./notes");

      const configPath = join(workspaceDir, ".kato-workspace-config.yaml");
      const written = await Deno.readTextFile(configPath);
      assertStringIncludes(written, "defaultOutputDir:");
      assertEquals(stdout, [`created workspace config at ${configPath}\n`]);

      const infoRecord = sink.records.find((record) =>
        record.event === "workspace.init"
      );
      assertExists(infoRecord);
      assertEquals(infoRecord.attributes?.["created"], true);
      assertEquals(infoRecord.attributes?.["configPath"], configPath);
    },
  );
});

Deno.test("runWorkspaceInitCommand preserves an existing workspace config", async () => {
  await withCommandTestRoot(
    "cli-command-workspace-init-existing-",
    async (root) => {
      const workspaceDir = join(root, "workspace");
      const configPath = join(workspaceDir, ".kato-workspace-config.yaml");
      await Deno.mkdir(workspaceDir, { recursive: true });
      await Deno.writeTextFile(configPath, "defaultOutputDir: ./custom\n");

      const { ctx, stdout, sink } = makeCommandContext(root, {
        statusSteps: [makeStatusSnapshot("2026-03-06T12:00:00.000Z")],
        cwdPath: workspaceDir,
      });

      await runWorkspaceInitCommand(ctx);

      assertEquals(
        await Deno.readTextFile(configPath),
        "defaultOutputDir: ./custom\n",
      );
      assertEquals(stdout, [
        `workspace config already exists at ${configPath}\n`,
      ]);

      const infoRecord = sink.records.find((record) =>
        record.event === "workspace.init"
      );
      assertExists(infoRecord);
      assertEquals(infoRecord.attributes?.["created"], false);
      assertEquals(infoRecord.attributes?.["configPath"], configPath);
    },
  );
});

Deno.test("runExportCommand rejects stale daemon status before queueing", async () => {
  await withCommandTestRoot("cli-command-export-stale-", async (root) => {
    const enqueued: EnqueuedControlRequest[] = [];
    const { ctx, sink } = makeCommandContext(root, {
      statusSteps: [
        makeStatusSnapshot("2026-03-06T11:59:00.000Z", {
          daemonRunning: true,
          daemonPid: 4242,
        }),
      ],
      enqueueImpl: (request) => {
        enqueued.push(request);
        return Promise.resolve({
          ...request,
          requestId: "req-unexpected",
          requestedAt: NOW.toISOString(),
        });
      },
    });

    await assertRejects(
      () => runExportCommand(ctx, "session-stale"),
      Error,
      "Export requires a running daemon with a fresh heartbeat",
    );

    assertEquals(enqueued.length, 0);

    const warnRecord = sink.records.find((record) =>
      record.event === "export.rejected.daemon_unavailable"
    );
    assertExists(warnRecord);
    assertEquals(warnRecord.channel, "operational");
    assertEquals(warnRecord.attributes?.["staleStatus"], true);

    const auditRecord = sink.records.find((record) =>
      record.event === "cli.command" &&
      record.attributes?.["commandName"] === "export"
    );
    assertExists(auditRecord);
    assertEquals(auditRecord.channel, "security-audit");
    assertEquals(auditRecord.attributes?.["requestEnqueued"], false);
  });
});

Deno.test("runExportCommand rejects denied output paths before enqueueing", async () => {
  await withCommandTestRoot("cli-command-export-deny-", async (root) => {
    const enqueued: EnqueuedControlRequest[] = [];
    const deniedPath = join(root, "..", "outside.md");
    const { ctx, sink } = makeCommandContext(root, {
      statusSteps: [
        makeStatusSnapshot("2026-03-06T12:00:00.000Z", {
          daemonRunning: true,
          daemonPid: 4242,
        }),
      ],
      pathPolicyDecision: {
        decision: "deny",
        reason: "Target path is outside allowed write roots",
        canonicalTargetPath: deniedPath,
      },
      enqueueImpl: (request) => {
        enqueued.push(request);
        return Promise.resolve({
          ...request,
          requestId: "req-unexpected",
          requestedAt: NOW.toISOString(),
        });
      },
    });

    await assertRejects(
      () => runExportCommand(ctx, "session-denied", deniedPath, "markdown"),
      Error,
      "Export path denied by policy",
    );

    assertEquals(enqueued.length, 0);

    const policyRecord = sink.records.find((record) =>
      record.event === "policy.decision"
    );
    assertExists(policyRecord);
    assertEquals(policyRecord.channel, "security-audit");
    assertEquals(policyRecord.attributes?.["decision"], "deny");

    const warnRecord = sink.records.find((record) =>
      record.event === "export.denied"
    );
    assertExists(warnRecord);
    assertEquals(warnRecord.attributes?.["sessionId"], "session-denied");
  });
});

Deno.test("runExportCommand enqueues exports and records queue history", async () => {
  await withCommandTestRoot("cli-command-export-success-", async (root) => {
    const enqueued: EnqueuedControlRequest[] = [];
    const outputPath = join(root, "exports", "session-42.md");
    const resolvedOutputPath = join(root, "resolved", "session-42.md");
    const { ctx, stdout, sink } = makeCommandContext(root, {
      statusSteps: [
        makeStatusSnapshot("2026-03-06T12:00:00.000Z", {
          daemonRunning: true,
          daemonPid: 4242,
        }),
      ],
      pathPolicyDecision: {
        decision: "allow",
        reason: "Target path is within allowed write roots",
        canonicalTargetPath: resolvedOutputPath,
        matchedRoot: root,
      },
      enqueueImpl: (request) => {
        enqueued.push(request);
        return Promise.resolve({
          ...request,
          requestId: "req-export-1",
          requestedAt: NOW.toISOString(),
        });
      },
    });

    await runExportCommand(ctx, "session-42", outputPath, "jsonl");

    assertEquals(stdout, [
      `export request queued: session=session-42 output=${outputPath} format=jsonl requestId=req-export-1\n`,
    ]);
    assertEquals(enqueued.length, 1);
    assertEquals(enqueued[0]?.command, "export");
    assertEquals(enqueued[0]?.payload?.["sessionId"], "session-42");
    assertEquals(enqueued[0]?.payload?.["outputPath"], outputPath);
    assertEquals(
      enqueued[0]?.payload?.["resolvedOutputPath"],
      resolvedOutputPath,
    );
    assertEquals(enqueued[0]?.payload?.["format"], "jsonl");

    const exportsLogPath = join(root, "exports.jsonl");
    const queuedEntry = JSON.parse(
      (await Deno.readTextFile(exportsLogPath)).trim(),
    ) as {
      requestId: string;
      status: string;
      sessionId: string;
      outputPath: string;
      format: string;
    };
    assertEquals(queuedEntry.requestId, "req-export-1");
    assertEquals(queuedEntry.status, "queued");
    assertEquals(queuedEntry.sessionId, "session-42");
    assertEquals(queuedEntry.outputPath, resolvedOutputPath);
    assertEquals(queuedEntry.format, "jsonl");

    const infoRecord = sink.records.find((record) =>
      record.event === "export.requested"
    );
    assertExists(infoRecord);
    assertEquals(infoRecord.channel, "operational");
    assertEquals(infoRecord.attributes?.["requestId"], "req-export-1");

    const auditRecord = sink.records.find((record) =>
      record.event === "cli.command" &&
      record.attributes?.["commandName"] === "export"
    );
    assertExists(auditRecord);
    assertEquals(auditRecord.channel, "security-audit");
    assertEquals(auditRecord.attributes?.["requestEnqueued"], true);
  });
});

Deno.test("runExportCommand continues when export history append fails", async () => {
  await withCommandTestRoot(
    "cli-command-export-history-fail-",
    async (root) => {
      const occupiedRoot = join(root, "occupied-root");
      await Deno.writeTextFile(occupiedRoot, "occupied");

      const enqueued: EnqueuedControlRequest[] = [];
      const { ctx, stdout, sink } = makeCommandContext(root, {
        statusSteps: [
          makeStatusSnapshot("2026-03-06T12:00:00.000Z", {
            daemonRunning: true,
            daemonPid: 4242,
          }),
        ],
        runtimeDir: join(occupiedRoot, "runtime"),
        enqueueImpl: (request) => {
          enqueued.push(request);
          return Promise.resolve({
            ...request,
            requestId: "req-export-2",
            requestedAt: NOW.toISOString(),
          });
        },
      });

      await runExportCommand(ctx, "session-history-fail");

      assertEquals(stdout, [
        "export request queued: session=session-history-fail requestId=req-export-2\n",
      ]);
      assertEquals(enqueued.length, 1);
      assertEquals(enqueued[0]?.payload?.["outputPath"], undefined);
      assertEquals(enqueued[0]?.payload?.["resolvedOutputPath"], undefined);
      assertEquals(enqueued[0]?.payload?.["format"], undefined);

      const warnRecord = sink.records.find((record) =>
        record.event === "export.history.write_failed"
      );
      assertExists(warnRecord);
      assertEquals(warnRecord.channel, "operational");
      assertStringIncludes(
        String(warnRecord.attributes?.["error"] ?? ""),
        "File exists",
      );

      await assertRejects(
        () => Deno.stat(join(occupiedRoot, "exports.jsonl")),
        Error,
      );
    },
  );
});
