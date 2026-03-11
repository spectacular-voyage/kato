import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { loadLogPageData } from "../apps/web/src/loaders/logs.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { withTestTempDir } from "./test_temp.ts";

Deno.test("loadLogPageData filters operational logs across daemon and web", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-log-loader-operational-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        await Deno.mkdir(join(katoDir, "daemon", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.writeTextFile(
          join(katoDir, "shared", "status.json"),
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-10T01:00:00.000Z",
            heartbeatAt: "2026-03-10T01:00:00.000Z",
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
          [
            JSON.stringify({
              timestamp: "2026-03-10T00:59:00.000Z",
              level: "warn",
              channel: "operational",
              event: "daemon.disk.warn",
              message: "disk usage high",
              attributes: { percent: 88 },
            }),
            JSON.stringify({
              timestamp: "2026-03-10T00:58:00.000Z",
              level: "info",
              channel: "operational",
              event: "daemon.ok",
              message: "steady state",
            }),
          ].join("\n") + "\n",
        );
        await Deno.writeTextFile(
          join(katoDir, "web", "logs", "operational.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-10T01:00:01.000Z",
            level: "error",
            channel: "operational",
            event: "web.request.unhandled_error",
            message: "web request failed",
            attributes: { pathname: "/api/summary" },
          }) + "\n",
        );

        const filtered = await loadLogPageData({
          channel: "operational",
          scope: "web",
          level: "error",
          eventFilter: "unhandled",
          textFilter: "failed",
        });

        assertEquals(filtered.rows.length, 1);
        assertEquals(filtered.matchedCount, 1);
        assertEquals(filtered.rows[0]?.scope, "web");
        assertEquals(filtered.rows[0]?.event, "web.request.unhandled_error");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadLogPageData returns security audit entries with attributes", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-log-loader-security-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        await Deno.mkdir(join(katoDir, "daemon", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.writeTextFile(
          join(katoDir, "shared", "status.json"),
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-10T01:00:00.000Z",
            heartbeatAt: "2026-03-10T01:00:00.000Z",
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
          join(katoDir, "daemon", "logs", "security-audit.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-10T00:57:00.000Z",
            level: "info",
            channel: "security-audit",
            event: "policy.decision",
            message: "Policy decision recorded",
            attributes: {
              decision: "deny",
              targetPath: join(homeDir, "outside.md"),
            },
          }) + "\n",
        );

        const data = await loadLogPageData({
          channel: "security-audit",
          level: "all",
        });

        assertEquals(data.rows.length, 1);
        assertEquals(data.rows[0]?.channel, "security-audit");
        assertEquals(data.rows[0]?.event, "policy.decision");
        assertExists(data.rows[0]?.attributes);
        assertEquals(data.rows[0]?.attributes?.["decision"], "deny");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadLogPageData combines operational and security channels when channel=all", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-log-loader-all-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        await Deno.mkdir(join(katoDir, "daemon", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.writeTextFile(
          join(katoDir, "shared", "status.json"),
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-10T01:00:00.000Z",
            heartbeatAt: "2026-03-10T01:00:00.000Z",
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
            timestamp: "2026-03-10T00:59:00.000Z",
            level: "warn",
            channel: "operational",
            event: "daemon.disk.warn",
            message: "disk usage high",
          }) + "\n",
        );
        await Deno.writeTextFile(
          join(katoDir, "web", "logs", "security-audit.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-10T01:00:01.000Z",
            level: "error",
            channel: "security-audit",
            event: "web.auth.failed",
            message: "authentication failed",
          }) + "\n",
        );

        const data = await loadLogPageData({
          channel: "all",
        });

        assertEquals(data.channel, "all");
        assertEquals(data.level, "warn");
        assertEquals(data.rows.length, 2);
        assertEquals(data.rows[0]?.channel, "security-audit");
        assertEquals(data.rows[1]?.channel, "operational");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadLogPageData treats warn as a minimum severity threshold", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-log-loader-threshold-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, ".kato");
        await Deno.mkdir(join(katoDir, "daemon", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.writeTextFile(
          join(katoDir, "shared", "status.json"),
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-10T01:00:00.000Z",
            heartbeatAt: "2026-03-10T01:00:00.000Z",
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
          [
            JSON.stringify({
              timestamp: "2026-03-10T00:57:00.000Z",
              level: "info",
              channel: "operational",
              event: "daemon.info",
              message: "informational event",
            }),
            JSON.stringify({
              timestamp: "2026-03-10T00:58:00.000Z",
              level: "warn",
              channel: "operational",
              event: "daemon.warn",
              message: "warning event",
            }),
            JSON.stringify({
              timestamp: "2026-03-10T00:59:00.000Z",
              level: "error",
              channel: "operational",
              event: "daemon.error",
              message: "error event",
            }),
          ].join("\n") + "\n",
        );

        const data = await loadLogPageData({
          channel: "operational",
          level: "warn",
        });

        assertEquals(data.rows.length, 2);
        assertEquals(data.rows[0]?.level, "error");
        assertEquals(data.rows[1]?.level, "warn");
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadLogPageData keeps daemon and web logs on the same instance when only statusPath is overridden", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-log-loader-status-path-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

        const katoDir = join(homeDir, "alternate-kato");
        const statusPath = join(katoDir, "shared", "status.json");
        await Deno.mkdir(join(katoDir, "daemon", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "web", "logs"), { recursive: true });
        await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
        await Deno.writeTextFile(
          statusPath,
          JSON.stringify({
            schemaVersion: 2,
            generatedAt: "2026-03-10T01:00:00.000Z",
            heartbeatAt: "2026-03-10T01:00:00.000Z",
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
            timestamp: "2026-03-10T00:59:00.000Z",
            level: "warn",
            channel: "operational",
            event: "daemon.warn",
            message: "daemon warning",
          }) + "\n",
        );
        await Deno.writeTextFile(
          join(katoDir, "web", "logs", "operational.jsonl"),
          JSON.stringify({
            timestamp: "2026-03-10T01:00:01.000Z",
            level: "error",
            channel: "operational",
            event: "web.error",
            message: "web failure",
          }) + "\n",
        );

        const data = await loadLogPageData({
          channel: "operational",
          level: "warn",
          statusPath,
        });

        assertEquals(data.rows.map((row) => row.event), [
          "web.error",
          "daemon.warn",
        ]);
      });
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
