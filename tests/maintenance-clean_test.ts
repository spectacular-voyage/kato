import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  AuditLogger,
  NoopSink,
  resolveDefaultSessionsDir,
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

Deno.test("runMaintenanceClean dry-run reports old session artifacts without deleting them", async () => {
  await withTestTempDir("maintenance-clean-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const sessionsDir = resolveDefaultSessionsDir(rootDir);
    await Deno.mkdir(sessionsDir, { recursive: true });

    const oldMetaPath = `${sessionsDir}/old.meta.json`;
    const oldTwinPath = `${sessionsDir}/old.twin.jsonl`;
    const recentMetaPath = `${sessionsDir}/recent.meta.json`;
    await Deno.writeTextFile(oldMetaPath, "{}\n");
    await Deno.writeTextFile(oldTwinPath, "{}\n");
    await Deno.writeTextFile(recentMetaPath, "{}\n");

    const oldTime = new Date("2026-02-01T00:00:00.000Z");
    const recentTime = new Date("2026-03-05T00:00:00.000Z");
    await Deno.utime(oldMetaPath, oldTime, oldTime);
    await Deno.utime(oldTwinPath, oldTime, oldTime);
    await Deno.utime(recentMetaPath, recentTime, recentTime);

    const result = await runMaintenanceClean({
      all: false,
      dryRun: true,
      sessionsDays: 7,
      runtimeDir,
      katoDir: rootDir,
      now: () => new Date("2026-03-07T00:00:00.000Z"),
      source: "web",
    });

    assertEquals(result.stats.sessionsWouldDelete, 1);
    assertEquals(result.stats.sessionFilesWouldDelete, 2);
    assertStringIncludes(result.summary, "mode=dry-run");
    assertStringIncludes(result.summary, "sessionsToDelete=1");
    await Deno.stat(oldMetaPath);
    await Deno.stat(oldTwinPath);
    await Deno.stat(recentMetaPath);
  });
});

Deno.test("runMaintenanceClean allows session cleanup while daemon is running", async () => {
  await withTestTempDir("maintenance-clean-running-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const sessionsDir = resolveDefaultSessionsDir(rootDir);
    await Deno.mkdir(sessionsDir, { recursive: true });

    const oldMetaPath = `${sessionsDir}/old.meta.json`;
    const oldTwinPath = `${sessionsDir}/old.twin.jsonl`;
    await Deno.writeTextFile(oldMetaPath, "{}\n");
    await Deno.writeTextFile(oldTwinPath, "{}\n");

    const oldTime = new Date("2026-02-01T00:00:00.000Z");
    await Deno.utime(oldMetaPath, oldTime, oldTime);
    await Deno.utime(oldTwinPath, oldTime, oldTime);

    const result = await runMaintenanceClean({
      all: false,
      dryRun: false,
      sessionsDays: 7,
      runtimeDir,
      katoDir: rootDir,
      now: () => new Date("2026-03-07T00:00:00.000Z"),
      source: "web",
    });

    assertEquals(result.stats.sessionsDeleted, 1);
    assertEquals(result.stats.sessionFilesDeleted, 2);
    await assertRejects(() => Deno.stat(oldMetaPath), Deno.errors.NotFound);
    await assertRejects(() => Deno.stat(oldTwinPath), Deno.errors.NotFound);
  });
});

Deno.test("runMaintenanceClean treats sessionsDays=0 as remove all session artifacts", async () => {
  await withTestTempDir("maintenance-clean-zero-days-", async (rootDir) => {
    const runtimeDir = `${rootDir}/daemon`;
    await Deno.mkdir(runtimeDir, { recursive: true });
    const sessionsDir = resolveDefaultSessionsDir(rootDir);
    await Deno.mkdir(sessionsDir, { recursive: true });

    const oldMetaPath = `${sessionsDir}/old.meta.json`;
    const recentTwinPath = `${sessionsDir}/recent.twin.jsonl`;
    await Deno.writeTextFile(oldMetaPath, "{}\n");
    await Deno.writeTextFile(recentTwinPath, "{}\n");

    const oldTime = new Date("2026-02-01T00:00:00.000Z");
    const recentTime = new Date("2026-03-07T00:00:00.000Z");
    await Deno.utime(oldMetaPath, oldTime, oldTime);
    await Deno.utime(recentTwinPath, recentTime, recentTime);

    const result = await runMaintenanceClean({
      all: false,
      dryRun: true,
      sessionsDays: 0,
      runtimeDir,
      katoDir: rootDir,
      now: () => new Date("2026-03-07T00:00:00.000Z"),
      source: "web",
    });

    assertEquals(result.stats.sessionsWouldDelete, 2);
    assertEquals(result.stats.sessionFilesWouldDelete, 2);
    assertStringIncludes(result.summary, "sessions=0d");
    assertStringIncludes(result.summary, "sessionsToDelete=2");
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
      sessionsDays: 7,
      runtimeDir,
      katoDir: rootDir,
      operationalLogger,
      auditLogger,
    });

    assertEquals(result.mode, "execute");
    assertEquals(result.stats.logFilesFlushed, 3);
    assertEquals(result.stats.logFilesWouldFlush, 0);
    assertEquals(result.stats.missingFiles, 2);
    assertEquals(result.stats.sessionsMatched, 0);
    assertEquals(result.stats.sessionsDeleted, 0);
    assertEquals(result.stats.skippedScopes, ["recordings"]);
    assertStringIncludes(result.summary, "mode=execute");
    assertStringIncludes(result.summary, "all=true");
    assertStringIncludes(result.summary, "recordings=14d");
    assertStringIncludes(result.summary, "sessions=7d");
    assertStringIncludes(result.summary, "logsFlushed=3");
    assertStringIncludes(result.summary, "sessionsDeleted=0");
    assertEquals(await Deno.readTextFile(daemonAuditLogPath), "");
    assertEquals(await Deno.readTextFile(webAuditLogPath), "");
    assertEquals(await Deno.readTextFile(exportsLogPath), "");
    assertEquals(infoCalls.map((call) => call.event), [
      "clean.sessions",
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
  await assertRejects(
    () =>
      runMaintenanceClean({
        all: false,
        dryRun: true,
      }),
    Error,
    "At least one cleanup scope is required",
  );
});
