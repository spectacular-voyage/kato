import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  AuditLogger,
  NoopSink,
  PersistentSessionStateStore,
  resolveExportsLogPath,
  runMaintenanceClean,
  StructuredLogger,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

function createLoggerSpies() {
  const infoCalls: Array<{
    event: string;
    message: string;
    attributes?: Record<string, unknown>;
  }> = [];
  const warnCalls: Array<{
    event: string;
    message: string;
    attributes?: Record<string, unknown>;
  }> = [];
  const auditCalls: Array<
    | {
      kind: "record";
      event: string;
      message: string;
      attributes?: Record<string, unknown>;
    }
    | {
      kind: "command";
      commandName: string;
      attributes?: Record<string, unknown>;
    }
  > = [];

  const operationalLogger = new StructuredLogger([new NoopSink()], {
    channel: "operational",
  });
  operationalLogger.info = (
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ) => {
    infoCalls.push({ event, message, attributes });
    return Promise.resolve();
  };
  operationalLogger.warn = (
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ) => {
    warnCalls.push({ event, message, attributes });
    return Promise.resolve();
  };

  const auditLogger = new AuditLogger(
    new StructuredLogger([new NoopSink()], { channel: "security-audit" }),
  );
  auditLogger.record = (
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ) => {
    auditCalls.push({ kind: "record", event, message, attributes });
    return Promise.resolve();
  };
  auditLogger.command = (
    commandName: string,
    attributes?: Record<string, unknown>,
  ) => {
    auditCalls.push({ kind: "command", commandName, attributes });
    return Promise.resolve();
  };

  return {
    operationalLogger,
    auditLogger,
    infoCalls,
    warnCalls,
    auditCalls,
  };
}

async function createTwinCleanupFixture(options: {
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
    now: () => new Date("2026-03-07T00:00:00.000Z"),
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
  metadata.ingestionActivatedAt = "2026-03-01T00:00:00.000Z";
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

Deno.test("runMaintenanceClean dry-run reports old twins without deleting them", async () => {
  await withTestTempDir("maintenance-clean-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const oldSession = await createTwinCleanupFixture({
      rootDir,
      sessionId: "session-old-clean",
      providerSessionId: "provider-old-clean",
      sourceName: "old-clean",
      twinTime: "2026-02-01T00:00:00.000Z",
    });
    const recentSession = await createTwinCleanupFixture({
      rootDir,
      sessionId: "session-recent-clean",
      providerSessionId: "provider-recent-clean",
      sourceName: "recent-clean",
      twinTime: "2026-03-05T00:00:00.000Z",
    });

    const result = await runMaintenanceClean({
      all: false,
      dryRun: true,
      twinsDays: 7,
      runtimeDir,
      katoDir: rootDir,
      now: () => new Date("2026-03-07T00:00:00.000Z"),
      source: "web",
    });

    assertEquals(result.stats.twinsWouldDelete, 1);
    assertEquals(result.stats.twinFilesWouldDelete, 1);
    assertEquals(result.stats.metadataFilesWouldDelete, 0);
    assertStringIncludes(result.summary, "mode=dry-run");
    assertStringIncludes(result.summary, "twinsToDelete=1");
    await Deno.stat(oldSession.metadataPath);
    await Deno.stat(oldSession.twinPath);
    await Deno.stat(recentSession.metadataPath);
    await Deno.stat(recentSession.twinPath);
  });
});

Deno.test("runMaintenanceClean preserves metadata by default and clears twin-only state", async () => {
  await withTestTempDir("maintenance-clean-preserve-meta-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const oldSession = await createTwinCleanupFixture({
      rootDir,
      sessionId: "session-preserve-meta",
      providerSessionId: "provider-preserve-meta",
      sourceName: "preserve-meta",
      twinTime: "2026-02-01T00:00:00.000Z",
    });

    const result = await runMaintenanceClean({
      all: false,
      dryRun: false,
      twinsDays: 7,
      runtimeDir,
      katoDir: rootDir,
      now: () => new Date("2026-03-07T00:00:00.000Z"),
      source: "web",
    });

    assertEquals(result.stats.twinsDeleted, 1);
    assertEquals(result.stats.twinFilesDeleted, 1);
    assertEquals(result.stats.metadataFilesDeleted, 0);
    await Deno.stat(oldSession.metadataPath);
    await assertRejects(
      () => Deno.stat(oldSession.twinPath),
      Deno.errors.NotFound,
    );

    const store = new PersistentSessionStateStore({ katoDir: rootDir });
    const reloaded = (await store.listSessionMetadata()).find((entry) =>
      entry.sessionId === oldSession.sessionId
    );
    assertEquals(reloaded?.nextTwinSeq, 1);
    assertEquals(reloaded?.recentFingerprints, []);
    assertEquals(reloaded?.ingestionActivatedAt, undefined);
  });
});

Deno.test("runMaintenanceClean optionally deletes twin metadata too", async () => {
  await withTestTempDir("maintenance-clean-delete-meta-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const oldSession = await createTwinCleanupFixture({
      rootDir,
      sessionId: "session-delete-meta",
      providerSessionId: "provider-delete-meta",
      sourceName: "delete-meta",
      twinTime: "2026-02-01T00:00:00.000Z",
    });

    const result = await runMaintenanceClean({
      all: false,
      dryRun: false,
      twinsDays: 7,
      deleteTwinMetadata: true,
      runtimeDir,
      katoDir: rootDir,
      now: () => new Date("2026-03-07T00:00:00.000Z"),
      source: "web",
    });

    assertEquals(result.stats.twinsDeleted, 1);
    assertEquals(result.stats.twinFilesDeleted, 1);
    assertEquals(result.stats.metadataFilesDeleted, 1);
    assertStringIncludes(result.summary, "deleteMetadata=true");
    assertStringIncludes(result.summary, "metadataFilesDeleted=1");
    await assertRejects(
      () => Deno.stat(oldSession.metadataPath),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(oldSession.twinPath),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("runMaintenanceClean treats twinsDays=0 as remove all twins", async () => {
  await withTestTempDir("maintenance-clean-zero-days-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    await createTwinCleanupFixture({
      rootDir,
      sessionId: "session-zero-old",
      providerSessionId: "provider-zero-old",
      sourceName: "zero-old",
      twinTime: "2026-02-01T00:00:00.000Z",
    });
    await createTwinCleanupFixture({
      rootDir,
      sessionId: "session-zero-recent",
      providerSessionId: "provider-zero-recent",
      sourceName: "zero-recent",
      twinTime: "2026-03-07T00:00:00.000Z",
    });

    const result = await runMaintenanceClean({
      all: false,
      dryRun: true,
      twinsDays: 0,
      runtimeDir,
      katoDir: rootDir,
      now: () => new Date("2026-03-07T00:00:00.000Z"),
      source: "web",
    });

    assertEquals(result.stats.twinsWouldDelete, 2);
    assertEquals(result.stats.twinFilesWouldDelete, 2);
    assertStringIncludes(result.summary, "twins=0d");
    assertStringIncludes(result.summary, "twinsToDelete=2");
  });
});

Deno.test("runMaintenanceClean flushes supported logs in dry-run mode and records web audits", async () => {
  await withTestTempDir("maintenance-clean-all-dry-run-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    const exportsLogPath = resolveExportsLogPath(runtimeDir);
    const daemonOperationalLogPath = `${runtimeDir}/logs/operational.jsonl`;
    const webOperationalLogPath = `${rootDir}/web/logs/operational.jsonl`;
    await Deno.mkdir(`${runtimeDir}/logs`, { recursive: true });
    await Deno.mkdir(`${rootDir}/web/logs`, { recursive: true });
    await Deno.writeTextFile(daemonOperationalLogPath, '{"daemon":true}\n');
    await Deno.writeTextFile(webOperationalLogPath, '{"web":true}\n');
    await Deno.writeTextFile(exportsLogPath, '{"exports":true}\n');

    const {
      auditCalls,
      auditLogger,
      infoCalls,
      operationalLogger,
      warnCalls,
    } = createLoggerSpies();
    const result = await runMaintenanceClean({
      all: true,
      dryRun: true,
      recordingsDays: 30,
      runtimeDir,
      katoDir: rootDir,
      operationalLogger,
      auditLogger,
      source: "web",
    });

    assertEquals(result.mode, "dry-run");
    assertEquals(result.stats.logFilesWouldFlush, 3);
    assertEquals(result.stats.logFilesFlushed, 0);
    assertEquals(result.stats.missingFiles, 2);
    assertEquals(result.stats.skippedScopes, ["recordings"]);
    assertStringIncludes(result.summary, "mode=dry-run");
    assertStringIncludes(result.summary, "all=true");
    assertStringIncludes(result.summary, "recordings=30d");
    assertStringIncludes(result.summary, "logsToFlush=3");
    assertStringIncludes(result.summary, "scopesNotImplemented=recordings");
    assertEquals(
      await Deno.readTextFile(daemonOperationalLogPath),
      '{"daemon":true}\n',
    );
    assertEquals(
      await Deno.readTextFile(webOperationalLogPath),
      '{"web":true}\n',
    );
    assertEquals(
      await Deno.readTextFile(exportsLogPath),
      '{"exports":true}\n',
    );
    assertEquals(infoCalls.map((call) => call.event), ["clean.completed"]);
    assertEquals(warnCalls.map((call) => call.event), [
      "clean.scope_unimplemented",
    ]);
    assertEquals(auditCalls.length, 1);
    assertEquals(auditCalls[0]?.kind, "record");
    assertEquals(
      auditCalls[0]?.kind === "record" ? auditCalls[0].event : undefined,
      "web.maintenance.clean",
    );
  });
});

Deno.test("runMaintenanceClean executes full log cleanup and uses CLI audit command", async () => {
  await withTestTempDir("maintenance-clean-all-execute-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    const exportsLogPath = resolveExportsLogPath(runtimeDir);
    const daemonAuditLogPath = `${runtimeDir}/logs/security-audit.jsonl`;
    const webAuditLogPath = `${rootDir}/web/logs/security-audit.jsonl`;
    await Deno.mkdir(`${runtimeDir}/logs`, { recursive: true });
    await Deno.mkdir(`${rootDir}/web/logs`, { recursive: true });
    await Deno.writeTextFile(daemonAuditLogPath, '{"daemon":true}\n');
    await Deno.writeTextFile(webAuditLogPath, '{"web":true}\n');
    await Deno.writeTextFile(exportsLogPath, '{"exports":true}\n');

    const {
      auditCalls,
      auditLogger,
      infoCalls,
      operationalLogger,
      warnCalls,
    } = createLoggerSpies();
    const result = await runMaintenanceClean({
      all: true,
      dryRun: false,
      recordingsDays: 14,
      twinsDays: 7,
      runtimeDir,
      katoDir: rootDir,
      operationalLogger,
      auditLogger,
    });

    assertEquals(result.mode, "execute");
    assertEquals(result.stats.logFilesFlushed, 3);
    assertEquals(result.stats.logFilesWouldFlush, 0);
    assertEquals(result.stats.missingFiles, 2);
    assertEquals(result.stats.twinsMatched, 0);
    assertEquals(result.stats.twinsDeleted, 0);
    assertEquals(result.stats.skippedScopes, ["recordings"]);
    assertStringIncludes(result.summary, "mode=execute");
    assertStringIncludes(result.summary, "all=true");
    assertStringIncludes(result.summary, "recordings=14d");
    assertStringIncludes(result.summary, "twins=7d");
    assertStringIncludes(result.summary, "logsFlushed=3");
    assertStringIncludes(result.summary, "twinsDeleted=0");
    assertEquals(await Deno.readTextFile(daemonAuditLogPath), "");
    assertEquals(await Deno.readTextFile(webAuditLogPath), "");
    assertEquals(await Deno.readTextFile(exportsLogPath), "");
    assertEquals(infoCalls.map((call) => call.event), [
      "clean.twins",
      "clean.completed",
    ]);
    assertEquals(warnCalls.map((call) => call.event), [
      "clean.scope_unimplemented",
    ]);
    assertEquals(auditCalls.length, 1);
    assertEquals(auditCalls[0]?.kind, "command");
    assertEquals(
      auditCalls[0]?.kind === "command" ? auditCalls[0].commandName : undefined,
      "clean",
    );
  });
});

Deno.test("runMaintenanceClean requires at least one cleanup scope", async () => {
  const runtimeDir =
    `${Deno.cwd()}/.test-tmp/maintenance-clean-no-scope-runtime`;
  await assertRejects(
    () =>
      runMaintenanceClean({
        all: false,
        dryRun: true,
        runtimeDir,
        katoDir: `${Deno.cwd()}/.test-tmp/maintenance-clean-no-scope-kato`,
      }),
    Error,
    "At least one cleanup scope is required",
  );
});

Deno.test("runMaintenanceClean rejects negative twin cleanup windows", async () => {
  await assertRejects(
    () =>
      runMaintenanceClean({
        all: false,
        dryRun: true,
        twinsDays: -1,
        runtimeDir:
          `${Deno.cwd()}/.test-tmp/maintenance-clean-negative-twins-runtime`,
        katoDir:
          `${Deno.cwd()}/.test-tmp/maintenance-clean-negative-twins-kato`,
      }),
    Error,
    "twinsDays must be greater than or equal to 0",
  );
});

Deno.test("runMaintenanceClean rejects negative recordings cleanup windows", async () => {
  await assertRejects(
    () =>
      runMaintenanceClean({
        all: false,
        dryRun: true,
        recordingsDays: -1,
        runtimeDir:
          `${Deno.cwd()}/.test-tmp/maintenance-clean-negative-recordings-runtime`,
        katoDir:
          `${Deno.cwd()}/.test-tmp/maintenance-clean-negative-recordings-kato`,
      }),
    Error,
    "recordingsDays must be greater than or equal to 0",
  );
});
