import { assertEquals, assertExists } from "@std/assert";
import {
  DebouncedPathAccumulator,
  watchFsDebounced,
} from "../apps/daemon/src/mod.ts";
import {
  makeTestTempDir,
  removePathIfPresent,
  resolveTestTempPath,
} from "./test_temp.ts";

function createFsEvent(
  kind: Deno.FsEvent["kind"],
  paths: string[],
): Deno.FsEvent {
  return { kind, paths };
}

const WATCHER_PATH_A = resolveTestTempPath("watcher", "a.txt");
const WATCHER_PATH_B = resolveTestTempPath("watcher", "b.txt");
const WATCHER_PATH_C = resolveTestTempPath("watcher", "c.txt");

Deno.test("DebouncedPathAccumulator flushes only after debounce window", () => {
  const accumulator = new DebouncedPathAccumulator(200);

  accumulator.add(createFsEvent("modify", [WATCHER_PATH_A]), 1_000);
  assertEquals(accumulator.shouldFlush(1_100), false);
  assertEquals(accumulator.shouldFlush(1_200), true);

  const batch = accumulator.flush(new Date("2026-02-22T10:00:00.000Z"));
  assertExists(batch);
  assertEquals(batch.paths, [WATCHER_PATH_A]);
  assertEquals(batch.kinds, ["modify"]);
  assertEquals(batch.emittedAt, "2026-02-22T10:00:00.000Z");
  assertEquals(accumulator.hasPending(), false);
});

Deno.test("DebouncedPathAccumulator de-duplicates paths and kinds", () => {
  const accumulator = new DebouncedPathAccumulator(100);

  accumulator.add(
    createFsEvent("modify", [WATCHER_PATH_A, WATCHER_PATH_B]),
    10,
  );
  accumulator.add(createFsEvent("modify", [WATCHER_PATH_B]), 20);
  accumulator.add(createFsEvent("create", [WATCHER_PATH_C]), 30);

  assertEquals(accumulator.shouldFlush(120), false);
  assertEquals(accumulator.shouldFlush(130), true);

  const batch = accumulator.flush(new Date("2026-02-22T10:10:00.000Z"));
  assertExists(batch);

  assertEquals([...batch.paths].sort(), [
    WATCHER_PATH_A,
    WATCHER_PATH_B,
    WATCHER_PATH_C,
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
