import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { loadSummaryPageData } from "../apps/web/src/loaders/status.ts";
import { withTestTempDir } from "./test_temp.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";

Deno.test("loadSummaryPageData reads the default shared status snapshot", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-summary-loader-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const statusPath = join(homeDir, ".kato", "shared", "status.json");
        await Deno.mkdir(join(homeDir, ".kato", "shared"), { recursive: true });
        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-07T16:00:00.000Z",
            heartbeatAt: "2026-03-07T16:00:00.000Z",
            daemonRunning: true,
            daemonPid: 4242,
            providers: [{
              provider: "codex",
              activeSessions: 1,
              lastEventAt: "2026-03-07T15:59:00.000Z",
            }],
            recordings: {
              activeRecordings: 2,
              destinations: 1,
            },
            sessions: [{
              provider: "codex",
              sessionId: "sess-001",
              updatedAt: "2026-03-07T15:59:00.000Z",
              lastEventAt: "2026-03-07T15:59:00.000Z",
              stale: false,
              snippet: "status summary",
              recordings: [{
                outputPath: "/tmp/active-a.md",
                startedAt: "2026-03-07T15:30:00.000Z",
                lastWriteAt: "2026-03-07T15:59:00.000Z",
              }, {
                outputPath: "/tmp/active-b.md",
                startedAt: "2026-03-07T15:35:00.000Z",
                lastWriteAt: "2026-03-07T15:59:00.000Z",
              }],
            }],
          }),
        );

        const data = await loadSummaryPageData({
          now: () => new Date("2026-03-07T16:00:02.000Z"),
        });

        assertEquals(data.daemon, "running");
        assertEquals(data.daemonPid, 4242);
        assertEquals(data.sessionCount, 1);
        assertEquals(data.recordingCount, 2);
        assertEquals(data.inactiveRecordingCount, 0);
        assertEquals(data.providers.length, 1);
        assertEquals(data.sessions[0]?.sessionId, "sess-001");
        assertEquals(data.stale, false);
        assertEquals(data.statusPath, statusPath);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSummaryPageData counts stale sessions from the full snapshot", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-summary-loader-stale-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const statusPath = join(homeDir, ".kato", "shared", "status.json");
        await Deno.mkdir(join(homeDir, ".kato", "shared"), { recursive: true });
        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-07T16:00:00.000Z",
            heartbeatAt: "2026-03-07T16:00:00.000Z",
            daemonRunning: true,
            providers: [],
            recordings: {
              activeRecordings: 0,
              destinations: 0,
            },
            sessions: [
              {
                provider: "codex",
                sessionId: "sess-active",
                updatedAt: "2026-03-07T15:59:00.000Z",
                lastEventAt: "2026-03-07T15:59:00.000Z",
                stale: false,
                snippet: "active session",
                recordings: [],
              },
              {
                provider: "codex",
                sessionId: "sess-stale",
                updatedAt: "2026-03-07T15:00:00.000Z",
                lastEventAt: "2026-03-07T15:00:00.000Z",
                stale: true,
                snippet: "stale session",
                recordings: [{
                  outputPath: "/tmp/stale-a.md",
                  startedAt: "2026-03-07T14:00:00.000Z",
                  lastWriteAt: "2026-03-07T15:00:00.000Z",
                }, {
                  outputPath: "/tmp/stale-b.md",
                  startedAt: "2026-03-07T14:15:00.000Z",
                  lastWriteAt: "2026-03-07T15:00:00.000Z",
                }],
              },
            ],
          }),
        );

        const data = await loadSummaryPageData({
          now: () => new Date("2026-03-07T16:00:02.000Z"),
        });

        assertEquals(data.sessionCount, 2);
        assertEquals(data.activeSessionCount, 1);
        assertEquals(data.staleSessionCount, 1);
        assertEquals(data.recordingCount, 0);
        assertEquals(data.inactiveRecordingCount, 3);
        assertEquals(data.sessions.length, 1);
        assertEquals(data.sessions[0]?.sessionId, "sess-active");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSummaryPageData merges daemon and web recent errors", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-summary-loader-errors-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        const statusPath = join(katoDir, "shared", "status.json");
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.mkdir(join(katoDir, "daemon", "logs"), {
          recursive: true,
        });
        await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });

        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-07T16:00:00.000Z",
            heartbeatAt: "2026-03-07T16:00:00.000Z",
            daemonRunning: true,
            providers: [],
            recordings: {
              activeRecordings: 0,
              destinations: 0,
            },
            sessions: [],
          }),
        );

        await Deno.writeTextFile(
          join(katoDir, "daemon", "logs", "operational.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-07T15:59:00.000Z",
            level: "warn",
            channel: "operational",
            event: "daemon.test.warn",
            message: "daemon warning",
          }) + "\n",
        );
        await Deno.writeTextFile(
          join(katoDir, "web", "logs", "operational.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-07T16:00:01.000Z",
            level: "error",
            channel: "operational",
            event: "web.request.unhandled_error",
            message: "web request failed",
          }) + "\n",
        );

        const data = await loadSummaryPageData({
          now: () => new Date("2026-03-07T16:00:02.000Z"),
        });

        assertEquals(data.recentErrors.length, 2);
        assertEquals(data.recentErrors[0]?.scope, "web");
        assertEquals(
          data.recentErrors[0]?.event,
          "web.request.unhandled_error",
        );
        assertEquals(data.recentErrors[1]?.scope, "daemon");
        assertEquals(data.recentErrors[1]?.event, "daemon.test.warn");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
