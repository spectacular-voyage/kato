import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import {
  FileProviderIngestionRunner,
  InMemorySessionSnapshotStore,
  type LogRecord,
  PersistentSessionStateStore,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

class CaptureSink {
  records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

interface ParseCall {
  sessionId: string;
  fromOffset: number;
}

/** One `{"text": ...}` JSON line per event; cursors are byte offsets. */
function makeLineParser(calls: ParseCall[]) {
  return (filePath: string, fromOffset: number, ctx: { sessionId: string }) => {
    calls.push({ sessionId: ctx.sessionId, fromOffset });
    return (async function* () {
      const bytes = await Deno.readFile(filePath);
      let offset = fromOffset;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline < 0) break;
        const line = new TextDecoder().decode(bytes.subarray(offset, newline));
        offset = newline + 1;
        const { text } = JSON.parse(line) as { text: string };
        const cursor: ProviderCursor = { kind: "byte-offset", value: offset };
        yield {
          event: {
            eventId: `${ctx.sessionId}:${offset}`,
            provider: "claude",
            sessionId: ctx.sessionId,
            timestamp: "2026-11-08T12:00:00.000Z",
            kind: "message.assistant",
            role: "assistant",
            content: text,
            source: {
              providerEventType: "assistant",
              providerEventId: `${ctx.sessionId}:${offset}`,
            },
          } as unknown as ConversationEvent,
          cursor,
        };
      }
    })();
  };
}

function makeWatchHarness() {
  let onBatch:
    | ((batch: {
      paths: string[];
      kinds: Array<"access" | "create" | "modify" | "remove" | "any" | "other">;
      emittedAt: string;
    }) => Promise<void> | void)
    | undefined;
  return {
    watchFn(
      _paths: string[],
      handler: NonNullable<typeof onBatch>,
      options: { signal?: AbortSignal },
    ): Promise<void> {
      onBatch = handler;
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
    async emitModify(path: string): Promise<void> {
      await onBatch?.({
        paths: [path],
        kinds: ["modify"],
        emittedAt: new Date().toISOString(),
      });
    },
  };
}

const line = (text: string) => `${JSON.stringify({ text })}\n`;

/** Discovery that reports real file mtimes, like the provider discoverers. */
function discoverFrom(files: Record<string, string>) {
  return async () =>
    await Promise.all(
      Object.entries(files).map(async ([sessionId, filePath]) => ({
        sessionId,
        filePath,
        modifiedAtMs: (await Deno.stat(filePath)).mtime!.getTime(),
      })),
    );
}

async function setMtime(path: string, mtimeMs: number): Promise<void> {
  await Deno.utime(path, mtimeMs / 1000, mtimeMs / 1000);
}

/**
 * Runs a first daemon lifetime that ingests every listed session to EOF,
 * then returns. Sessions are proactively ingested because the runner's
 * clock starts before the files' mtimes.
 */
async function ingestOnce(
  katoDir: string,
  files: Record<string, string>,
): Promise<void> {
  const runner = new FileProviderIngestionRunner({
    provider: "claude",
    watchRoots: [],
    now: () => new Date(0),
    sessionSnapshotStore: new InMemorySessionSnapshotStore(),
    sessionStateStore: new PersistentSessionStateStore({ katoDir }),
    watchFs: makeWatchHarness().watchFn,
    discoverSessions: discoverFrom(files),
    parseEvents: makeLineParser([]),
  });
  await runner.start();
  await runner.poll();
  await runner.stop();
}

Deno.test("FileProviderIngestionRunner catches up stale tracked sessions at startup, one per poll", async () => {
  await withTestTempDir("ingestion-catch-up-", async (dir) => {
    const katoDir = join(dir, ".kato");
    const files = {
      "sess-a": join(dir, "a.jsonl"),
      "sess-b": join(dir, "b.jsonl"),
      "sess-touched": join(dir, "touched.jsonl"),
    };
    for (const [id, path] of Object.entries(files)) {
      await Deno.writeTextFile(path, line(`${id} first`));
    }
    const baseMs = Date.parse("2026-11-01T00:00:00.000Z");
    for (const path of Object.values(files)) await setMtime(path, baseMs);
    await ingestOnce(katoDir, files);

    // While the daemon is down: a and b gain content (b most recently),
    // touched only gets a newer mtime, and an untracked session appears.
    await Deno.writeTextFile(files["sess-a"], line("sess-a second"), {
      append: true,
    });
    await setMtime(files["sess-a"], baseMs + 20_000);
    await Deno.writeTextFile(files["sess-b"], line("sess-b second"), {
      append: true,
    });
    await setMtime(files["sess-b"], baseMs + 30_000);
    await setMtime(files["sess-touched"], baseMs + 40_000);
    const untracked = join(dir, "untracked.jsonl");
    await Deno.writeTextFile(untracked, line("never tracked"));
    await setMtime(untracked, baseMs + 50_000);

    const calls: ParseCall[] = [];
    const sink = new CaptureSink();
    const snapshots = new InMemorySessionSnapshotStore();
    const runner = new FileProviderIngestionRunner({
      provider: "claude",
      watchRoots: [],
      // Restarted well after every write: nothing is "modified since start".
      now: () => new Date(baseMs + 3_600_000),
      sessionSnapshotStore: snapshots,
      sessionStateStore: new PersistentSessionStateStore({ katoDir }),
      operationalLogger: new StructuredLogger([sink], {
        channel: "operational",
        minLevel: "debug",
      }),
      watchFs: makeWatchHarness().watchFn,
      discoverSessions: discoverFrom({ ...files, "sess-untracked": untracked }),
      parseEvents: makeLineParser(calls),
    });
    const resumedFor = (sessionId: string) =>
      calls.filter((call) =>
        call.sessionId === sessionId && call.fromOffset > 0
      ).length;
    const contents = (sessionId: string) =>
      (snapshots.get(sessionId)?.events ?? []).map((event) =>
        (event as { content: string }).content
      );

    await runner.start();
    await runner.poll();
    assertEquals(resumedFor("sess-b"), 1, "most recent stale session first");
    assertEquals(resumedFor("sess-a"), 0, "only one catch-up per poll");
    assert(contents("sess-b").includes("sess-b second"));

    await runner.poll();
    assertEquals(resumedFor("sess-a"), 1);
    assert(contents("sess-a").includes("sess-a second"));

    await runner.poll();
    assertEquals(resumedFor("sess-a"), 1);
    assertEquals(resumedFor("sess-b"), 1);
    assertEquals(
      calls.filter((call) => call.sessionId === "sess-touched").length,
      0,
      "a newer mtime with no unread bytes must not trigger ingestion",
    );
    assertEquals(
      calls.filter((call) => call.sessionId === "sess-untracked").length,
      0,
      "untracked history stays lazy",
    );

    const queued = sink.records.filter((record) =>
      record.event === "provider.ingestion.catch_up.queued"
    );
    assertEquals(queued.length, 1);
    assertEquals(queued[0]!.attributes?.["sessions"], 2);
    assertEquals(queued[0]!.attributes?.["sessionIds"], ["sess-b", "sess-a"]);

    await runner.stop();
  });
});

Deno.test("FileProviderIngestionRunner does not re-ingest a queued catch-up session after a watch event ingested it", async () => {
  await withTestTempDir("ingestion-catch-up-watch-", async (dir) => {
    const katoDir = join(dir, ".kato");
    const files = {
      "sess-a": join(dir, "a.jsonl"),
      "sess-b": join(dir, "b.jsonl"),
    };
    for (const [id, path] of Object.entries(files)) {
      await Deno.writeTextFile(path, line(`${id} first`));
    }
    const baseMs = Date.parse("2026-11-01T00:00:00.000Z");
    for (const path of Object.values(files)) await setMtime(path, baseMs);
    await ingestOnce(katoDir, files);

    for (const [id, path] of Object.entries(files)) {
      await Deno.writeTextFile(path, line(`${id} second`), { append: true });
    }
    await setMtime(files["sess-a"], baseMs + 10_000);
    await setMtime(files["sess-b"], baseMs + 20_000);

    const calls: ParseCall[] = [];
    const harness = makeWatchHarness();
    const runner = new FileProviderIngestionRunner({
      provider: "claude",
      watchRoots: [dir],
      now: () => new Date(baseMs + 3_600_000),
      sessionSnapshotStore: new InMemorySessionSnapshotStore(),
      sessionStateStore: new PersistentSessionStateStore({ katoDir }),
      watchFs: harness.watchFn,
      discoverSessions: discoverFrom(files),
      parseEvents: makeLineParser(calls),
    });
    const resumedFor = (sessionId: string) =>
      calls.filter((call) =>
        call.sessionId === sessionId && call.fromOffset > 0
      ).length;

    await runner.start();
    await runner.poll();
    assertEquals(resumedFor("sess-b"), 1);
    assertEquals(resumedFor("sess-a"), 0);

    // sess-a is still queued when a live append arrives for it.
    await Deno.writeTextFile(files["sess-a"], line("sess-a third"), {
      append: true,
    });
    await harness.emitModify(files["sess-a"]);
    await runner.poll();
    assertEquals(resumedFor("sess-a"), 1);

    await runner.poll();
    assertEquals(resumedFor("sess-a"), 1, "catch-up already satisfied");
    assertEquals(resumedFor("sess-b"), 1);

    await runner.stop();
  });
});
