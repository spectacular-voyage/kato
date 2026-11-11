// Watcher-led discovery (task.2026.2026-11-10-watcher-led-discovery): the
// runner walks roots rarely while its watcher is trusted, resolves reported
// paths on their own, stat-checks active sessions, and falls back to fast
// walks for roots whose watcher is down or misses changes.
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import type {
  DebouncedWatchBatch,
  WatchDebounceOptions,
} from "../apps/daemon/src/core/watcher.ts";
import {
  type CodexSessionMetaCache,
  describeClaudeSessionFile,
  describeCodexSessionFile,
  describeGeminiSessionFile,
  discoverClaudeSessions,
  discoverCodexSessions,
  type DiscoveryTimingOptions,
  FileProviderIngestionRunner,
  type GeminiDiscoveryCache,
  isJsonlSessionPath,
  type ProviderSessionFile,
} from "../apps/daemon/src/orchestrator/provider_ingestion.ts";
import {
  InMemorySessionSnapshotStore,
  type LogRecord,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

class CaptureSink {
  records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

class Clock {
  ms = T0;
  readonly now = (): Date => new Date(this.ms);
  set(ms: number): void {
    this.ms = ms;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeLaunch {
  roots: string[];
  onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void;
  reject: (error: unknown) => void;
}

/** A watcher that reports only what a test emits, and fails on demand. */
class FakeWatcher {
  readonly launches: FakeLaunch[] = [];

  readonly watchFs = (
    roots: string[],
    onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void,
    options: WatchDebounceOptions,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      this.launches.push({ roots: [...roots], onBatch, reject });
      options.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });

  async emit(
    paths: string[],
    extra: Partial<DebouncedWatchBatch> = {},
  ): Promise<void> {
    const launch = this.launches.at(-1);
    assert(launch, "watcher was never launched");
    await launch.onBatch({
      paths,
      kinds: ["modify"],
      emittedAt: new Date(T0).toISOString(),
      ...extra,
    });
  }

  async fail(): Promise<void> {
    this.launches.at(-1)?.reject(new Error("watch failed"));
    await settle();
  }
}

async function writeAt(
  path: string,
  content: string,
  mtimeMs: number,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  await Deno.utime(path, new Date(mtimeMs), new Date(mtimeMs));
}

async function appendAt(
  path: string,
  content: string,
  mtimeMs: number,
): Promise<void> {
  await Deno.writeTextFile(path, content, { append: true });
  await Deno.utime(path, new Date(mtimeMs), new Date(mtimeMs));
}

function fakeEvent(id: string): ConversationEvent {
  return {
    eventId: id,
    provider: "claude",
    sessionId: "unused",
    timestamp: new Date(T0).toISOString(),
    kind: "message.assistant",
    role: "assistant",
    content: id,
    source: { providerEventType: "assistant", providerEventId: id },
  } as unknown as ConversationEvent;
}

interface Harness {
  runner: FileProviderIngestionRunner;
  clock: Clock;
  watcher: FakeWatcher;
  /** Roots passed to each walk. */
  walks: string[][];
  /** `path@offset` for each parse that found new bytes. */
  parsed: string[];
  logs: CaptureSink;
  trackedIds: () => string[];
}

interface HarnessOptions {
  provider?: "claude" | "codex";
  timing?: DiscoveryTimingOptions;
  /** Shared with another runner, for comparing incremental and fresh walks. */
  codexCache?: CodexSessionMetaCache;
}

function makeHarness(roots: string[], options: HarnessOptions = {}): Harness {
  const clock = new Clock();
  const watcher = new FakeWatcher();
  const walks: string[][] = [];
  const parsed: string[] = [];
  const logs = new CaptureSink();
  const provider = options.provider ?? "claude";
  const codexCache: CodexSessionMetaCache = options.codexCache ?? new Map();
  const runner = new FileProviderIngestionRunner({
    provider,
    watchRoots: roots,
    discoverSessions: (walkRoots) => {
      walks.push([...walkRoots]);
      return provider === "claude"
        ? discoverClaudeSessions(walkRoots)
        : discoverCodexSessions(walkRoots, codexCache);
    },
    describeSessionFile: (filePath) =>
      provider === "claude"
        ? describeClaudeSessionFile(filePath)
        : describeCodexSessionFile(filePath, codexCache),
    isSessionFilePath: isJsonlSessionPath,
    parseEvents(filePath, fromOffset) {
      return (async function* () {
        const size = (await Deno.stat(filePath)).size;
        if (size <= fromOffset) return;
        parsed.push(`${filePath}@${fromOffset}`);
        yield {
          event: fakeEvent(`${filePath}@${fromOffset}`),
          cursor: { kind: "byte-offset" as const, value: size },
        };
      })();
    },
    sessionSnapshotStore: new InMemorySessionSnapshotStore(),
    now: clock.now,
    watchFs: watcher.watchFs,
    discoveryTiming: options.timing,
    operationalLogger: new StructuredLogger([logs], {
      channel: "operational",
      minLevel: "debug",
      now: clock.now,
    }),
  });
  return {
    runner,
    clock,
    watcher,
    walks,
    parsed,
    logs,
    trackedIds: () =>
      runner.listTrackedSessions().map((session) => session.sessionId),
  };
}

function logEvents(harness: Harness, event: string): LogRecord[] {
  return harness.logs.records.filter((record) => record.event === event);
}

function codexMeta(id: string, source: string): string {
  return `${
    JSON.stringify({ type: "session_meta", payload: { id, source } })
  }\n`;
}

Deno.test("discovery walks a watched root only at start and every five minutes", async () => {
  await withTestTempDir("discovery-healthy-", async (dir) => {
    const root = join(dir, "projects");
    await writeAt(join(root, "p", "a.jsonl"), "a\n", T0 - MINUTE);
    const harness = makeHarness([root]);
    await harness.runner.start();
    await harness.runner.poll();
    for (let minute = 1; minute <= 11; minute += 1) {
      harness.clock.set(T0 + minute * MINUTE);
      await harness.runner.poll();
    }
    assertEquals(harness.walks.length, 3);
    assertEquals(harness.trackedIds(), ["a"]);
    assertEquals(harness.runner.getWatchDegraded(), []);
    await harness.runner.stop();
  });
});

Deno.test("discovery resolves reported paths without walking", async () => {
  await withTestTempDir("discovery-reported-", async (dir) => {
    const root = join(dir, "projects");
    await writeAt(join(root, "p", "a.jsonl"), "a\n", T0 - MINUTE);
    const harness = makeHarness([root]);
    await harness.runner.start();
    await harness.runner.poll();
    assertEquals(harness.walks.length, 1);

    // A new transcript is tracked and ingested from its event alone.
    const b = join(root, "p", "b.jsonl");
    await writeAt(b, "b\n", T0 + SECOND);
    await harness.watcher.emit([b]);
    await harness.runner.poll();
    assertEquals(harness.trackedIds(), ["a", "b"]);
    assert(harness.parsed.includes(`${b}@0`));

    // Files that cannot be transcripts are ignored.
    const notes = join(root, "p", "memory", "notes.md");
    await writeAt(notes, "notes", T0 + SECOND);
    await harness.watcher.emit([notes]);
    await harness.runner.poll();

    // A reported directory is read: its file predates any watch on it.
    const c = join(root, "q", "nested", "c.jsonl");
    await writeAt(c, "c\n", T0 + 2 * SECOND);
    await harness.watcher.emit([join(root, "q")]);
    await harness.runner.poll();
    assertEquals(harness.trackedIds(), ["a", "b", "c"]);

    // An append to a tracked transcript is ingested from its offset.
    await appendAt(b, "more\n", T0 + 3 * SECOND);
    await harness.watcher.emit([b]);
    await harness.runner.poll();
    assert(harness.parsed.includes(`${b}@2`));

    assertEquals(harness.walks.length, 1);
    await harness.runner.stop();
  });
});

Deno.test("discovery ignores Codex exec rollouts without walking", async () => {
  await withTestTempDir("discovery-exec-", async (dir) => {
    const root = join(dir, "sessions");
    const interactive = join(root, "2026", "11", "rollout-a.jsonl");
    await writeAt(interactive, codexMeta("codex-a", "cli"), T0 - MINUTE);
    const harness = makeHarness([root], { provider: "codex" });
    await harness.runner.start();
    await harness.runner.poll();

    const exec = join(root, "2026", "11", "rollout-exec.jsonl");
    await writeAt(exec, codexMeta("codex-exec", "exec"), T0 + SECOND);
    for (let index = 0; index < 3; index += 1) {
      await appendAt(exec, "{}\n", T0 + (index + 2) * SECOND);
      await harness.watcher.emit([exec]);
      await harness.runner.poll();
    }
    assertEquals(harness.trackedIds(), ["codex-a"]);
    assertEquals(harness.walks.length, 1);
    await harness.runner.stop();
  });
});

Deno.test("discovery moves and drops sessions on rename and removal events", async () => {
  await withTestTempDir("discovery-rename-", async (dir) => {
    const root = join(dir, "projects");
    const original = join(root, "p", "a.jsonl");
    await writeAt(original, "a\n", T0 - MINUTE);
    const harness = makeHarness([root]);
    await harness.runner.start();
    await harness.runner.poll();

    const moved = join(root, "q", "a.jsonl");
    await Deno.mkdir(dirname(moved), { recursive: true });
    await Deno.rename(original, moved);
    await harness.watcher.emit([original, moved]);
    await harness.runner.poll();
    assertEquals(
      harness.runner.listTrackedSessions().map((session) => session.filePath),
      [moved],
    );

    await Deno.remove(moved);
    await harness.watcher.emit([moved]);
    await harness.runner.poll();
    assertEquals(harness.trackedIds(), []);

    assertEquals(harness.walks.length, 1);
    await harness.runner.stop();
  });
});

Deno.test("discovery walks every root after the watcher reports dropped events", async () => {
  await withTestTempDir("discovery-rescan-", async (dir) => {
    const rootA = join(dir, "a");
    const rootB = join(dir, "b");
    await writeAt(join(rootA, "p", "a.jsonl"), "a\n", T0 - MINUTE);
    await writeAt(join(rootB, "p", "b.jsonl"), "b\n", T0 - MINUTE);
    const harness = makeHarness([rootA, rootB]);
    await harness.runner.start();
    await harness.runner.poll();

    // Written while events were being dropped: only the rescan finds it.
    await writeAt(join(rootB, "p", "c.jsonl"), "c\n", T0 + SECOND);
    await harness.watcher.emit([], { rescan: true });
    harness.clock.set(T0 + 2 * SECOND);
    await harness.runner.poll();

    assertEquals(harness.walks, [[rootA, rootB], [rootA, rootB]]);
    assertEquals(harness.trackedIds(), ["a", "b", "c"]);
    assertEquals(
      logEvents(harness, "provider.ingestion.watch.rescan").length,
      1,
    );
    await harness.runner.stop();
  });
});

Deno.test("discovery restarts a failed watcher with backoff and walks fast meanwhile", async () => {
  await withTestTempDir("discovery-restart-", async (dir) => {
    const root = join(dir, "projects");
    await writeAt(join(root, "p", "a.jsonl"), "a\n", T0 - MINUTE);
    const harness = makeHarness([root]);
    await harness.runner.start();
    await harness.runner.poll();
    assertEquals(harness.watcher.launches.length, 1);

    await harness.watcher.fail();
    const down = harness.runner.getWatchDegraded();
    assertEquals(down.map((entry) => [entry.reason, entry.roots]), [[
      "watcher-down",
      [root],
    ]]);
    assertEquals(
      logEvents(harness, "provider.ingestion.watch.failed").length,
      1,
    );

    // First restart after 5 seconds, with a walk for what it missed.
    harness.clock.set(T0 + 5 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.watcher.launches.length, 2);
    assertEquals(harness.walks.length, 2);
    assertEquals(harness.runner.getWatchDegraded(), []);
    assertEquals(
      logEvents(harness, "provider.ingestion.watch.restarted").length,
      1,
    );

    // Trusted again: no walk 5 seconds later.
    harness.clock.set(T0 + 10 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.walks.length, 2);

    // A second failure waits 30 seconds; the root is walked every 5 meanwhile.
    await harness.watcher.fail();
    harness.clock.set(T0 + 15 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.walks.length, 3);
    assertEquals(harness.watcher.launches.length, 2);
    harness.clock.set(T0 + 40 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.watcher.launches.length, 3);
    await harness.runner.stop();
  });
});

Deno.test("discovery catches a blind watcher with the hot poll and degrades only that root", async () => {
  await withTestTempDir("discovery-blind-", async (dir) => {
    const rootA = join(dir, "a");
    const rootB = join(dir, "b");
    const a = join(rootA, "p", "a.jsonl");
    await writeAt(a, "a\n", T0 - MINUTE);
    await writeAt(join(rootB, "p", "b.jsonl"), "b\n", T0 - MINUTE);
    const harness = makeHarness([rootA, rootB]);
    await harness.runner.start();
    await harness.runner.poll();

    // Three appends the watcher never reports, each older than the grace.
    for (let index = 1; index <= 3; index += 1) {
      const nowMs = T0 + index * 5 * SECOND;
      await appendAt(a, `line ${index}\n`, nowMs - 4 * SECOND);
      harness.clock.set(nowMs);
      await harness.runner.poll();
    }
    // Distinct offsets: the first ingest also reads from 0 for a snippet.
    assertEquals(
      new Set(harness.parsed.filter((entry) => entry.startsWith(a))).size,
      3,
    );
    const degraded = harness.runner.getWatchDegraded();
    assertEquals(
      degraded.map((entry) => [entry.reason, entry.roots, entry.missedChanges]),
      [["missed-changes", [rootA], 3]],
    );
    assertEquals(
      logEvents(harness, "provider.ingestion.watch.degraded").length,
      1,
    );

    // Only the degraded root goes back to walks every 5 seconds.
    harness.clock.set(T0 + 20 * SECOND);
    await harness.runner.poll();
    harness.clock.set(T0 + 25 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.walks.slice(1), [[rootA], [rootA]]);
    assertEquals(harness.trackedIds(), ["a", "b"]);
    await harness.runner.stop();
  });
});

Deno.test("discovery does not count reported or in-flight changes as misses", async () => {
  await withTestTempDir("discovery-grace-", async (dir) => {
    const root = join(dir, "projects");
    const a = join(root, "p", "a.jsonl");
    await writeAt(a, "a\n", T0 - MINUTE);
    const harness = makeHarness([root], { timing: { watchMissThreshold: 1 } });
    await harness.runner.start();
    await harness.runner.poll();

    // Younger than the grace period: its event may still be on the way.
    await appendAt(a, "one\n", T0 + 4 * SECOND);
    harness.clock.set(T0 + 5 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.runner.getWatchDegraded(), []);

    // Reported by the watcher.
    await appendAt(a, "two\n", T0 + 6 * SECOND);
    await harness.watcher.emit([a]);
    harness.clock.set(T0 + 10 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.runner.getWatchDegraded(), []);

    // Old enough and never reported: one miss degrades at threshold 1.
    await appendAt(a, "three\n", T0 + 11 * SECOND);
    harness.clock.set(T0 + 15 * SECOND);
    await harness.runner.poll();
    assertEquals(
      harness.runner.getWatchDegraded().map((entry) => entry.reason),
      ["missed-changes"],
    );
    await harness.runner.stop();
  });
});

Deno.test("discovery watches a root that appears after start", async () => {
  await withTestTempDir("discovery-appear-", async (dir) => {
    const root = join(dir, "projects");
    const harness = makeHarness([root]);
    await harness.runner.start();
    await harness.runner.poll();
    assertEquals(harness.watcher.launches.length, 0);

    await writeAt(join(root, "p", "a.jsonl"), "a\n", T0 + SECOND);
    harness.clock.set(T0 + 5 * SECOND);
    await harness.runner.poll();
    harness.clock.set(T0 + 6 * SECOND);
    await harness.runner.poll();
    assertEquals(harness.watcher.launches.map((launch) => launch.roots), [[
      root,
    ]]);
    assertEquals(harness.trackedIds(), ["a"]);

    // Watched now, so the next walk waits the full interval.
    const walks = harness.walks.length;
    harness.clock.set(T0 + 2 * MINUTE);
    await harness.runner.poll();
    assertEquals(harness.walks.length, walks);
    await harness.runner.stop();
  });
});

function trackedSummary(
  sessions: ProviderSessionFile[],
): Array<[string, string, number]> {
  return sessions.map((session) => [
    session.sessionId,
    session.filePath,
    session.modifiedAtMs,
  ]);
}

Deno.test("discovery from events tracks what a fresh walk finds", async () => {
  await withTestTempDir("discovery-equivalence-", async (dir) => {
    const rootA = join(dir, "a");
    const rootB = join(dir, "b");
    await writeAt(join(rootA, "p", "keep.jsonl"), "k\n", T0 - MINUTE);
    await writeAt(join(rootA, "p", "gone.jsonl"), "g\n", T0 - MINUTE);
    await Deno.mkdir(rootB, { recursive: true });
    const harness = makeHarness([rootA, rootB]);
    await harness.runner.start();
    await harness.runner.poll();

    let tick = 0;
    const at = () => T0 + (++tick) * SECOND;
    const step = async (paths: string[]) => {
      await harness.watcher.emit(paths);
      harness.clock.set(at());
      await harness.runner.poll();
    };

    // Create, append, delete.
    const fresh = join(rootB, "q", "fresh.jsonl");
    await writeAt(fresh, "f\n", at());
    await step([fresh]);
    await appendAt(join(rootA, "p", "keep.jsonl"), "k2\n", at());
    await step([join(rootA, "p", "keep.jsonl")]);
    await Deno.remove(join(rootA, "p", "gone.jsonl"));
    await step([join(rootA, "p", "gone.jsonl")]);

    // The same session id in both roots: the newer file wins, either way.
    const dupA = join(rootA, "p", "dup.jsonl");
    const dupB = join(rootB, "q", "dup.jsonl");
    await writeAt(dupA, "d\n", at());
    await step([dupA]);
    await writeAt(dupB, "d\n", at());
    await step([dupB]);
    await appendAt(dupA, "d2\n", at());
    await step([dupA]);

    // A rename into a new directory, reported as the directory.
    const renamedFrom = join(rootB, "q", "fresh.jsonl");
    const renamedTo = join(rootB, "r", "fresh.jsonl");
    await Deno.mkdir(dirname(renamedTo), { recursive: true });
    await Deno.rename(renamedFrom, renamedTo);
    await step([renamedFrom, join(rootB, "r")]);

    // A directory removed with its transcript.
    const doomed = join(rootB, "s", "doomed.jsonl");
    await writeAt(doomed, "x\n", at());
    await step([doomed]);
    await Deno.remove(join(rootB, "s"), { recursive: true });
    await step([join(rootB, "s")]);

    assertEquals(harness.walks.length, 1);

    const reference = makeHarness([rootA, rootB]);
    await reference.runner.start();
    await reference.runner.poll();
    assertEquals(
      trackedSummary(harness.runner.listTrackedSessions()),
      trackedSummary(reference.runner.listTrackedSessions()),
    );
    assertEquals(
      harness.runner.listTrackedSessions().find((session) =>
        session.sessionId === "dup"
      )?.filePath,
      dupA,
    );
    await reference.runner.stop();
    await harness.runner.stop();
  });
});

Deno.test("Gemini discovery reuses a file's read while its mtime and size hold", async () => {
  await withTestTempDir("discovery-gemini-cache-", async (dir) => {
    const root = join(dir, "tmp");
    const file = join(root, "hash", "chats", "session-1.json");
    const content = (id: string) =>
      JSON.stringify({ sessionId: id, messages: [] });
    await writeAt(file, content("first-id"), T0);
    const cache: GeminiDiscoveryCache = new Map();
    assertEquals(
      (await describeGeminiSessionFile(file, root, cache))?.sessionId,
      "first-id",
    );

    // Same size and mtime: the cached read stands.
    await writeAt(file, content("other-id"), T0);
    assertEquals(
      (await describeGeminiSessionFile(file, root, cache))?.sessionId,
      "first-id",
    );

    // A new mtime means a new read.
    await Deno.utime(file, new Date(T0 + SECOND), new Date(T0 + SECOND));
    assertEquals(
      (await describeGeminiSessionFile(file, root, cache))?.sessionId,
      "other-id",
    );
  });
});
