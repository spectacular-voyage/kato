import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  resolveDefaultSessionsDir,
  runMaintenanceClean,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

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
