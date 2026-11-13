// The real platform watcher (inotify, FSEvents, ReadDirectoryChangesW) behind
// a Claude runner. Walks and the hot poll are pushed out of reach, so every
// change here has to arrive through the watcher; see
// task.2026.2026-11-10-watcher-led-discovery.
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  createClaudeIngestionRunner,
  type FileProviderIngestionRunner,
  InMemorySessionSnapshotStore,
  type LogRecord,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

const HOUR = 60 * 60_000;
const WAIT_MS = 10_000;

class CaptureSink {
  records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

function claudeLine(id: string, text: string): string {
  return `${
    JSON.stringify({
      type: "user",
      uuid: id,
      timestamp: new Date().toISOString(),
      cwd: "/tmp/project",
      message: { role: "user", content: [{ type: "text", text }] },
    })
  }\n`;
}

interface Watched {
  runner: FileProviderIngestionRunner;
  store: InMemorySessionSnapshotStore;
  sink: CaptureSink;
}

function makeWatchedRunner(
  root: string,
  timing: { hotPollIntervalMs?: number } = {},
): Watched {
  const store = new InMemorySessionSnapshotStore();
  const sink = new CaptureSink();
  const runner = createClaudeIngestionRunner({
    sessionSnapshotStore: store,
    sessionRoots: [root],
    discoveryIntervalMs: HOUR,
    discoveryTiming: {
      degradedDiscoveryIntervalMs: HOUR,
      hotPollIntervalMs: timing.hotPollIntervalMs ?? HOUR,
    },
    watchDebounceMs: 50,
    operationalLogger: new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
    }),
  }) as FileProviderIngestionRunner;
  return { runner, store, sink };
}

async function pollUntil(
  watched: Watched,
  what: string,
  condition: () => boolean,
): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await watched.runner.poll();
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`);
}

function trackedPath(watched: Watched, sessionId: string): string | undefined {
  return watched.runner.listTrackedSessions().find((session) =>
    session.sessionId === sessionId
  )?.filePath;
}

function walkCount(watched: Watched): number {
  return watched.sink.records.filter((record) =>
    record.event === "provider.ingestion.discovery.walked"
  ).length;
}

function eventCount(watched: Watched, sessionId: string): number {
  return watched.store.get(sessionId)?.events.length ?? 0;
}

Deno.test("the platform watcher alone reports creates, appends, renames and deletes", async () => {
  await withTestTempDir("watch-integration-", async (dir) => {
    const root = join(dir, "projects");
    await Deno.mkdir(root, { recursive: true });
    const watched = makeWatchedRunner(root);
    await watched.runner.start();
    try {
      await watched.runner.poll();

      // A nested directory and its file, created back to back.
      const created = join(root, "fresh", "nested", "s1.jsonl");
      await Deno.mkdir(dirname(created), { recursive: true });
      await Deno.writeTextFile(created, claudeLine("u1", "first"));
      await pollUntil(
        watched,
        "the new transcript",
        () => eventCount(watched, "s1") >= 1,
      );

      await Deno.writeTextFile(created, claudeLine("u2", "second"), {
        append: true,
      });
      await pollUntil(
        watched,
        "the appended line",
        () => eventCount(watched, "s1") >= 2,
      );

      const moved = join(root, "moved", "s1.jsonl");
      await Deno.mkdir(dirname(moved), { recursive: true });
      await Deno.rename(created, moved);
      await pollUntil(
        watched,
        "the renamed transcript",
        () => trackedPath(watched, "s1") === moved,
      );

      await Deno.remove(moved);
      await pollUntil(
        watched,
        "the removal",
        () => trackedPath(watched, "s1") === undefined,
      );

      assertEquals(walkCount(watched), 1);
      assertEquals(watched.runner.getWatchDegraded(), []);
    } finally {
      await watched.runner.stop();
    }
  });
});

Deno.test("an append through a held-open handle is ingested", async () => {
  await withTestTempDir("watch-integration-handle-", async (dir) => {
    const root = join(dir, "projects");
    const path = join(root, "p", "held.jsonl");
    await Deno.mkdir(dirname(path), { recursive: true });
    // The hot poll stays on: some watchers may report such appends late.
    const watched = makeWatchedRunner(root, { hotPollIntervalMs: 200 });
    await watched.runner.start();
    await watched.runner.poll();
    // Written after start, so the session is new to this runner.
    await Deno.writeTextFile(path, claudeLine("h1", "opening"));
    const file = await Deno.open(path, { append: true });
    try {
      await pollUntil(
        watched,
        "the opening line",
        () => eventCount(watched, "held") >= 1,
      );
      await file.write(new TextEncoder().encode(claudeLine("h2", "held")));
      await pollUntil(
        watched,
        "the held-open append",
        () => eventCount(watched, "held") >= 2,
      );
    } finally {
      file.close();
      await watched.runner.stop();
    }
  });
});

Deno.test({
  name: "a root reached through a symlink is watched under its configured path",
  // Windows needs a privilege to make symlinks; macOS is the case that
  // matters, since FSEvents reports resolved paths.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTestTempDir("watch-integration-symlink-", symlinkedRootCase);
  },
});

async function symlinkedRootCase(dir: string): Promise<void> {
  const real = join(dir, "real-projects");
  const root = join(dir, "projects-link");
  await Deno.mkdir(real, { recursive: true });
  // Deno.symlink needs unscoped write permission; the test has `ln`.
  const linked = await new Deno.Command("ln", { args: ["-s", real, root] })
    .output();
  assert(linked.success, new TextDecoder().decode(linked.stderr));
  const watched = makeWatchedRunner(root);
  await watched.runner.start();
  try {
    await watched.runner.poll();
    const created = join(root, "p", "linked.jsonl");
    await Deno.mkdir(dirname(created), { recursive: true });
    await Deno.writeTextFile(created, claudeLine("l1", "through the link"));
    await pollUntil(
      watched,
      "the transcript under the symlinked root",
      () => trackedPath(watched, "linked") !== undefined,
    );
    const tracked = trackedPath(watched, "linked");
    assert(tracked?.startsWith(root), `tracked as ${tracked}`);
    assertEquals(walkCount(watched), 1);
  } finally {
    await watched.runner.stop();
  }
}
