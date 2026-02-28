import { assertEquals, assertExists } from "@std/assert";
import {
  DebouncedPathAccumulator,
  watchFsDebounced,
} from "../apps/daemon/src/mod.ts";
import { makeTestTempDir, removePathIfPresent } from "./test_temp.ts";

function createFsEvent(
  kind: Deno.FsEvent["kind"],
  paths: string[],
): Deno.FsEvent {
  return { kind, paths };
}

Deno.test("DebouncedPathAccumulator flushes only after debounce window", () => {
  const accumulator = new DebouncedPathAccumulator(200);

  accumulator.add(createFsEvent("modify", ["/tmp/a.txt"]), 1_000);
  assertEquals(accumulator.shouldFlush(1_100), false);
  assertEquals(accumulator.shouldFlush(1_200), true);

  const batch = accumulator.flush(new Date("2026-02-22T10:00:00.000Z"));
  assertExists(batch);
  assertEquals(batch.paths, ["/tmp/a.txt"]);
  assertEquals(batch.kinds, ["modify"]);
  assertEquals(batch.emittedAt, "2026-02-22T10:00:00.000Z");
  assertEquals(accumulator.hasPending(), false);
});

Deno.test("DebouncedPathAccumulator de-duplicates paths and kinds", () => {
  const accumulator = new DebouncedPathAccumulator(100);

  accumulator.add(createFsEvent("modify", ["/tmp/a.txt", "/tmp/b.txt"]), 10);
  accumulator.add(createFsEvent("modify", ["/tmp/b.txt"]), 20);
  accumulator.add(createFsEvent("create", ["/tmp/c.txt"]), 30);

  assertEquals(accumulator.shouldFlush(120), false);
  assertEquals(accumulator.shouldFlush(130), true);

  const batch = accumulator.flush(new Date("2026-02-22T10:10:00.000Z"));
  assertExists(batch);

  assertEquals([...batch.paths].sort(), [
    "/tmp/a.txt",
    "/tmp/b.txt",
    "/tmp/c.txt",
  ]);
  assertEquals([...batch.kinds].sort(), ["create", "modify"]);
});

Deno.test("DebouncedPathAccumulator flush returns null with no pending events", () => {
  const accumulator = new DebouncedPathAccumulator(100);
  assertEquals(accumulator.flush(), null);
});

Deno.test("watchFsDebounced exits promptly when aborted without filesystem events", async () => {
  const dir = await makeTestTempDir("watch-abort-");

  try {
    const abortController = new AbortController();
    const watchTask = watchFsDebounced(
      [dir],
      () => {},
      { signal: abortController.signal },
    );
    const abortTimer = setTimeout(() => {
      abortController.abort();
    }, 25);
    let timeoutTimer: number | undefined;

    const completed = await Promise.race([
      watchTask.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    clearTimeout(abortTimer);
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }

    assertEquals(completed, true);
  } finally {
    await removePathIfPresent(dir);
  }
});
