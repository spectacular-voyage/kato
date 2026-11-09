import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  buildRotatedLogFilePath,
  JsonLineFileSink,
  type LogRecord,
} from "@kato/runtime";
import {
  parseRotatedLogDay,
  pruneRotatedLogFiles,
} from "../apps/runtime/src/observability/log_rotation.ts";
import { withTestTempDir } from "./test_temp.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function record(event: string, timestamp: Date): LogRecord {
  return {
    timestamp: timestamp.toISOString(),
    level: "info",
    channel: "security-audit",
    event,
    message: event,
  };
}

async function readEvents(path: string): Promise<string[]> {
  const raw = await Deno.readTextFile(path);
  return raw.trim().split("\n").filter((line) => line.length > 0).map((
    line,
  ) => (JSON.parse(line) as LogRecord).event);
}

async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    names.push(entry.name);
  }
  return names.sort();
}

async function setMtime(path: string, date: Date): Promise<void> {
  await Deno.utime(path, date, date);
}

function utcNoon(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

function shiftDay(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + deltaDays * DAY_MS)
    .toISOString().slice(0, 10);
}

Deno.test("JsonLineFileSink keeps same-day writes in the active file", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    const path = join(dir, "logs", "security-audit.jsonl");
    const now = utcNoon("2026-11-07");
    const sink = new JsonLineFileSink(path, { now: () => now });

    await sink.write(record("a", now));
    await sink.write(record("b", now));

    assertEquals(await listNames(join(dir, "logs")), ["security-audit.jsonl"]);
    assertEquals(await readEvents(path), ["a", "b"]);
  });
});

Deno.test("JsonLineFileSink rotates the active file on UTC day change", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    const path = join(dir, "security-audit.jsonl");
    let now = utcNoon("2026-11-07");
    const sink = new JsonLineFileSink(path, { now: () => now });

    await sink.write(record("day1", now));
    await setMtime(path, now);
    now = utcNoon("2026-11-08");
    await sink.write(record("day2", now));

    assertEquals(await listNames(dir), [
      "security-audit.2026-11-07.jsonl",
      "security-audit.jsonl",
    ]);
    assertEquals(await readEvents(path), ["day2"]);
    assertEquals(
      await readEvents(join(dir, "security-audit.2026-11-07.jsonl")),
      ["day1"],
    );
  });
});

Deno.test("JsonLineFileSink rotates a stale pre-existing log by its mtime day on first write", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    const path = join(dir, "operational.jsonl");
    await Deno.writeTextFile(
      path,
      `${JSON.stringify(record("legacy", utcNoon("2026-10-01")))}\n`,
    );
    await setMtime(path, utcNoon("2026-11-05"));

    const now = utcNoon("2026-11-08");
    const sink = new JsonLineFileSink(path, { now: () => now });
    await sink.write(record("fresh", now));

    assertEquals(await readEvents(path), ["fresh"]);
    assertEquals(
      await readEvents(join(dir, "operational.2026-11-05.jsonl")),
      ["legacy"],
    );
  });
});

Deno.test("JsonLineFileSink never overwrites an existing rotated file", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    const path = join(dir, "security-audit.jsonl");
    const existingRotated = join(dir, "security-audit.2026-11-07.jsonl");
    await Deno.writeTextFile(
      existingRotated,
      `${JSON.stringify(record("earlier", utcNoon("2026-11-07")))}\n`,
    );
    await Deno.writeTextFile(
      path,
      `${JSON.stringify(record("later", utcNoon("2026-11-07")))}\n`,
    );
    await setMtime(path, utcNoon("2026-11-07"));

    const now = utcNoon("2026-11-08");
    await new JsonLineFileSink(path, { now: () => now }).write(
      record("today", now),
    );

    assertEquals(await readEvents(existingRotated), ["earlier"]);
    assertEquals(
      await readEvents(join(dir, "security-audit.2026-11-07.1.jsonl")),
      ["later"],
    );
    assertEquals(await readEvents(path), ["today"]);
  });
});

Deno.test("JsonLineFileSink prunes only this log's rotated files older than the retention window", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    const today = "2026-11-08";
    const path = join(dir, "security-audit.jsonl");
    const expired = buildRotatedLogFilePath(path, shiftDay(today, -31));
    const expiredCollision = buildRotatedLogFilePath(
      path,
      shiftDay(today, -45),
      2,
    );
    const boundary = buildRotatedLogFilePath(path, shiftDay(today, -30));
    const recent = buildRotatedLogFilePath(path, shiftDay(today, -1));
    const otherLog = join(dir, `operational.${shiftDay(today, -90)}.jsonl`);
    const unrelated = join(dir, "security-audit.backup.jsonl");
    const invalidDay = join(dir, "security-audit.2026-02-30.jsonl");
    for (
      const file of [
        expired,
        expiredCollision,
        boundary,
        recent,
        otherLog,
        unrelated,
        invalidDay,
      ]
    ) {
      await Deno.writeTextFile(file, "{}\n");
    }

    const now = utcNoon(today);
    await new JsonLineFileSink(path, { retentionDays: 30, now: () => now })
      .write(record("today", now));

    assertEquals(await listNames(dir), [
      "operational.2026-08-10.jsonl",
      "security-audit.2026-02-30.jsonl",
      "security-audit.2026-10-09.jsonl",
      "security-audit.2026-11-07.jsonl",
      "security-audit.backup.jsonl",
      "security-audit.jsonl",
    ]);
  });
});

Deno.test("JsonLineFileSink honors a configured retention window", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    const today = "2026-11-08";
    const path = join(dir, "operational.jsonl");
    await Deno.writeTextFile(
      buildRotatedLogFilePath(path, shiftDay(today, -8)),
      "{}\n",
    );
    await Deno.writeTextFile(
      buildRotatedLogFilePath(path, shiftDay(today, -7)),
      "{}\n",
    );

    const now = utcNoon(today);
    await new JsonLineFileSink(path, { retentionDays: 7, now: () => now })
      .write(record("today", now));

    assertEquals(await listNames(dir), [
      "operational.2026-11-01.jsonl",
      "operational.jsonl",
    ]);
  });
});

Deno.test("concurrent JsonLineFileSink instances lose no records across a day change", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    const path = join(dir, "security-audit.jsonl");
    let now = utcNoon("2026-11-07");
    const sinkA = new JsonLineFileSink(path, { now: () => now });
    const sinkB = new JsonLineFileSink(path, { now: () => now });
    await sinkA.write(record("a-day1", now));
    await sinkB.write(record("b-day1", now));
    await setMtime(path, now);

    now = utcNoon("2026-11-08");
    await Promise.all(
      Array.from(
        { length: 20 },
        (_, index) =>
          (index % 2 === 0 ? sinkA : sinkB).write(
            record(`day2-${index}`, now),
          ),
      ),
    );

    assertEquals(await listNames(dir), [
      "security-audit.2026-11-07.jsonl",
      "security-audit.jsonl",
    ]);
    assertEquals(
      await readEvents(join(dir, "security-audit.2026-11-07.jsonl")),
      ["a-day1", "b-day1"],
    );
    const todayEvents = await readEvents(path);
    assertEquals(todayEvents.length, 20);
    assertEquals(
      new Set(todayEvents),
      new Set(Array.from({ length: 20 }, (_, index) => `day2-${index}`)),
    );
  });
});

Deno.test("JsonLineFileSink rejects invalid retentionDays", () => {
  for (const retentionDays of [0, -1, 1.5, Number.NaN]) {
    assertThrows(
      () => new JsonLineFileSink("unused.jsonl", { retentionDays }),
      Error,
      "retentionDays",
    );
  }
});

Deno.test("parseRotatedLogDay matches only valid rotated siblings", () => {
  const active = join("logs", "security-audit.jsonl");
  assertEquals(
    parseRotatedLogDay(active, "security-audit.2026-11-07.jsonl"),
    "2026-11-07",
  );
  assertEquals(
    parseRotatedLogDay(active, "security-audit.2026-11-07.3.jsonl"),
    "2026-11-07",
  );
  assertEquals(parseRotatedLogDay(active, "security-audit.jsonl"), undefined);
  assertEquals(
    parseRotatedLogDay(active, "security-audit.2026-13-01.jsonl"),
    undefined,
  );
  assertEquals(
    parseRotatedLogDay(active, "operational.2026-11-07.jsonl"),
    undefined,
  );
  assertEquals(
    parseRotatedLogDay(active, "security-audit.2026-11-07.jsonl.bak"),
    undefined,
  );
  assertEquals(
    parseRotatedLogDay(join("logs", "a+b.jsonl"), "a+b.2026-11-07.jsonl"),
    "2026-11-07",
  );
  assertEquals(
    parseRotatedLogDay(join("logs", "a+b.jsonl"), "aab.2026-11-07.jsonl"),
    undefined,
  );
});

Deno.test("pruneRotatedLogFiles ignores a missing log directory", async () => {
  await withTestTempDir("log-rotation-", async (dir) => {
    assertEquals(
      await pruneRotatedLogFiles(
        join(dir, "missing", "operational.jsonl"),
        "2026-11-08",
        30,
      ),
      [],
    );
  });
});
