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
              recordings: [],
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
