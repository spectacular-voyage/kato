import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import {
  FileProviderIngestionRunner,
  InMemorySessionSnapshotStore,
  type LogRecord,
  PersistentSessionStateStore,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";
import { parseCodexEvents } from "../apps/daemon/src/providers/codex/parser.ts";
import { jsonlReaderStats } from "../apps/daemon/src/utils/jsonl_line_reader.ts";
import { withTestTempDir } from "./test_temp.ts";

class CaptureSink {
  records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
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

function codexLine(type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type, payload })}\n`;
}

function turn(id: string, finalText: string): string {
  return codexLine("event_msg", { type: "task_started", turn_id: id }) +
    codexLine("event_msg", {
      type: "task_complete",
      last_agent_message: finalText,
    });
}

Deno.test("Codex runner steady-state ingests read only appended bytes", async () => {
  await withTestTempDir("ingestion-incremental-", async (dir) => {
    const sessionFile = join(dir, "rollout-incremental.jsonl");
    const filler = codexLine("event_msg", {
      type: "token_count",
      padding: "p".repeat(4000),
    });
    await Deno.writeTextFile(
      sessionFile,
      codexLine("session_meta", { id: "sess-inc" }) +
        codexLine("turn_context", { model: "gpt-test" }) +
        codexLine("compacted", { message: "earlier" }) +
        turn("t1", "First turn done") +
        filler.repeat(250),
    );

    const store = new InMemorySessionSnapshotStore();
    const harness = makeWatchHarness();
    const runner = new FileProviderIngestionRunner({
      provider: "codex",
      watchRoots: [dir],
      sessionSnapshotStore: store,
      sessionStateStore: new PersistentSessionStateStore({
        katoDir: join(dir, ".kato"),
        makeSessionId: () => "kato-sess-inc",
      }),
      watchFs: harness.watchFn,
      discoverSessions: () =>
        Promise.resolve([{
          sessionId: "sess-inc",
          filePath: sessionFile,
          modifiedAtMs: Date.now(),
        }]),
      parseEvents: (filePath, fromOffset, ctx) =>
        parseCodexEvents(filePath, fromOffset, ctx),
    });

    await runner.start();
    const cold = await runner.poll();
    assertEquals(cold.eventsObserved, 1);

    // The first warm ingest after a from-0 ingest records the compaction
    // anchor (pre-existing behavior: it backtracks once with dedupe).
    await Deno.writeTextFile(sessionFile, filler, { append: true });
    await harness.emitModify(sessionFile);
    await runner.poll();

    const appended = turn("t2", "Second turn done");
    await Deno.writeTextFile(sessionFile, appended, { append: true });
    await harness.emitModify(sessionFile);
    const before = jsonlReaderStats.bytesRead;
    const warm = await runner.poll();
    const warmBytes = jsonlReaderStats.bytesRead - before;
    assertEquals(warm.eventsObserved, 1);
    const finals = (store.get("sess-inc")?.events ?? [])
      .filter((event: ConversationEvent) => event.kind === "message.assistant")
      .map((event) => (event as { content: string }).content);
    assertEquals(finals, ["First turn done", "Second turn done"]);
    // Parse + compaction scan each read the appended bytes plus a guard window.
    const appendedBytes = new TextEncoder().encode(appended).length;
    assert(
      warmBytes <= 2 * (appendedBytes + 256),
      `warm ingest read ${warmBytes} bytes for a ${appendedBytes}-byte append`,
    );

    await harness.emitModify(sessionFile);
    const idleBefore = jsonlReaderStats.bytesRead;
    const idle = await runner.poll();
    assertEquals(idle.eventsObserved, 0);
    assert(jsonlReaderStats.bytesRead - idleBefore <= 2 * 256);

    await runner.stop();
  });
});

Deno.test("FileProviderIngestionRunner backs off failing sessions, reports them, and recovers", async () => {
  await withTestTempDir("ingestion-backoff-", async (dir) => {
    const sessionFile = join(dir, "failing.jsonl");
    await Deno.writeTextFile(sessionFile, "{}\n");
    let nowMs = Date.parse("2026-11-08T12:00:00.000Z");
    const sink = new CaptureSink();
    let failing = true;
    let parseCalls = 0;

    const runner = new FileProviderIngestionRunner({
      provider: "codex",
      watchRoots: [dir],
      now: () => new Date(nowMs),
      sessionSnapshotStore: new InMemorySessionSnapshotStore(),
      operationalLogger: new StructuredLogger([sink], {
        channel: "operational",
        minLevel: "debug",
      }),
      watchFs: makeWatchHarness().watchFn,
      discoverSessions: () =>
        Promise.resolve([{
          sessionId: "sess-fail",
          filePath: sessionFile,
          modifiedAtMs: nowMs,
        }]),
      parseEvents: () => {
        parseCalls += 1;
        return (async function* () {
          if (failing) {
            throw new Error("failed to allocate string");
          }
          yield {
            event: {
              eventId: "e1",
              provider: "codex",
              sessionId: "sess-fail",
              timestamp: "2026-11-08T12:00:00.000Z",
              kind: "message.assistant",
              role: "assistant",
              content: "hello",
              source: { providerEventType: "assistant", providerEventId: "e1" },
            } as unknown as ConversationEvent,
            cursor: { kind: "byte-offset" as const, value: 3 },
          };
        })();
      },
    });

    await runner.start();
    await runner.poll();
    assertEquals(parseCalls, 1);
    let failures = runner.getIngestionFailures();
    assertEquals(failures.length, 1);
    assertEquals(failures[0]!.sessionId, "sess-fail");
    assertEquals(failures[0]!.consecutiveFailures, 1);
    assertEquals(failures[0]!.error, "failed to allocate string");
    assertEquals(failures[0]!.nextRetryAt, "2026-11-08T12:00:30.000Z");

    // Within the backoff window: not retried.
    nowMs += 10_000;
    await runner.poll();
    assertEquals(parseCalls, 1);

    // Due: retried without any new file event, backoff doubles.
    nowMs += 21_000;
    await runner.poll();
    assertEquals(parseCalls, 2);
    failures = runner.getIngestionFailures();
    assertEquals(failures[0]!.consecutiveFailures, 2);
    assertEquals(failures[0]!.firstFailedAt, "2026-11-08T12:00:00.000Z");
    assertEquals(failures[0]!.nextRetryAt, "2026-11-08T12:01:31.000Z");

    failing = false;
    nowMs += 61_000;
    const recovered = await runner.poll();
    assertEquals(parseCalls, 3);
    assertEquals(recovered.eventsObserved, 1);
    assertEquals(runner.getIngestionFailures(), []);

    const events = sink.records.map((record) => record.event);
    assertEquals(
      events.filter((event) => event === "provider.ingestion.parse_error")
        .length,
      2,
    );
    assertEquals(
      events.filter((event) => event === "provider.ingestion.parse_recovered")
        .length,
      1,
    );
    const firstError = sink.records.find((record) =>
      record.event === "provider.ingestion.parse_error"
    );
    assertEquals(firstError?.attributes?.["consecutiveFailures"], 1);

    await runner.stop();
  });
});
