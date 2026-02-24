import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import {
  AuditLogger,
  createClaudeIngestionRunner,
  createCodexIngestionRunner,
  FileProviderIngestionRunner,
  InMemorySessionSnapshotStore,
  type LogRecord,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";

function makeEvent(id: string, timestamp: string): ConversationEvent {
  return {
    eventId: id,
    provider: "test-provider",
    sessionId: "sess-test",
    timestamp,
    kind: "message.assistant",
    role: "assistant",
    content: `${id}-content`,
    source: { providerEventType: "assistant", providerEventId: id },
  } as unknown as ConversationEvent;
}

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
      _watchPaths: string[],
      handler: (batch: {
        paths: string[];
        kinds: Array<
          "access" | "create" | "modify" | "remove" | "any" | "other"
        >;
        emittedAt: string;
      }) => Promise<void> | void,
      options: { signal?: AbortSignal },
    ): Promise<void> {
      onBatch = handler;
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
    emitModify(path: string): Promise<void> {
      if (!onBatch) {
        return Promise.resolve();
      }
      return Promise.resolve(
        onBatch({
          paths: [path],
          kinds: ["modify"],
          emittedAt: new Date("2026-02-23T00:00:00.000Z").toISOString(),
        }),
      );
    },
  };
}

async function withTempDir(
  prefix: string,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const dir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix,
  });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("FileProviderIngestionRunner resumes byte-offset cursors after watch updates", async () => {
  await withTempDir("provider-ingestion-runner-", async (dir) => {
    const sessionFile = join(dir, "session-1.jsonl");
    await Deno.writeTextFile(sessionFile, "placeholder\n");

    const store = new InMemorySessionSnapshotStore();
    const harness = makeWatchHarness();
    const parseOffsets: number[] = [];

    const runner = new FileProviderIngestionRunner({
      provider: "test-provider",
      watchRoots: [dir],
      sessionSnapshotStore: store,
      watchFs: harness.watchFn,
      discoverSessions() {
        return Promise.resolve([{
          sessionId: "session-1",
          filePath: sessionFile,
          modifiedAtMs: Date.now(),
        }]);
      },
      parseEvents(
        _filePath: string,
        fromOffset: number,
        _ctx: { provider: string; sessionId: string },
      ) {
        parseOffsets.push(fromOffset);
        return (async function* () {
          if (fromOffset === 0) {
            yield {
              event: makeEvent("m1", "2026-02-22T20:00:00.000Z"),
              cursor: { kind: "byte-offset" as const, value: 10 },
            };
            return;
          }

          if (fromOffset === 10) {
            yield {
              event: makeEvent("m2", "2026-02-22T20:01:00.000Z"),
              cursor: { kind: "byte-offset" as const, value: 20 },
            };
          }
        })();
      },
    });

    await runner.start();
    const firstPoll = await runner.poll();
    assertEquals(firstPoll.sessionsUpdated, 1);
    assertEquals(firstPoll.eventsObserved, 1);

    const firstSnapshot = store.get("session-1");
    assertExists(firstSnapshot);
    assertEquals(firstSnapshot.events.map((event) => event.eventId), ["m1"]);
    assertEquals(firstSnapshot.cursor, { kind: "byte-offset", value: 10 });

    await harness.emitModify(sessionFile);
    const secondPoll = await runner.poll();
    assertEquals(secondPoll.sessionsUpdated, 1);
    assertEquals(secondPoll.eventsObserved, 1);

    const secondSnapshot = store.get("session-1");
    assertExists(secondSnapshot);
    assertEquals(secondSnapshot.events.map((event) => event.eventId), [
      "m1",
      "m2",
    ]);
    assertEquals(secondSnapshot.cursor, { kind: "byte-offset", value: 20 });
    assertEquals(parseOffsets, [0, 10]);

    await runner.stop();
  });
});

Deno.test("FileProviderIngestionRunner logs parse errors and continues polling", async () => {
  await withTempDir("provider-ingestion-errors-", async (dir) => {
    const sessionFile = join(dir, "session-err.jsonl");
    await Deno.writeTextFile(sessionFile, "placeholder\n");

    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-22T20:10:00.000Z"),
    });
    const auditLogger = new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date("2026-02-22T20:10:00.000Z"),
      }),
    );

    const harness = makeWatchHarness();
    const runner = new FileProviderIngestionRunner({
      provider: "test-provider",
      watchRoots: [dir],
      sessionSnapshotStore: new InMemorySessionSnapshotStore(),
      watchFs: harness.watchFn,
      operationalLogger,
      auditLogger,
      discoverSessions() {
        return Promise.resolve([{
          sessionId: "session-err",
          filePath: sessionFile,
          modifiedAtMs: Date.now(),
        }]);
      },
      parseEvents(
        _filePath: string,
        _fromOffset: number,
        _ctx: { provider: string; sessionId: string },
      ) {
        return (async function* () {
          if (Date.now() < 0) {
            yield {
              event: makeEvent("unreachable", "2026-02-22T00:00:00.000Z"),
              cursor: { kind: "byte-offset" as const, value: 0 },
            };
          }
          throw new Error("parse exploded");
        })();
      },
    });

    await runner.start();
    const result = await runner.poll();
    assertEquals(result.sessionsUpdated, 0);
    assertEquals(result.eventsObserved, 0);

    await runner.stop();

    assert(
      sink.records.some((record) =>
        record.event === "provider.ingestion.parse_error" &&
        record.channel === "operational"
      ),
    );
    assert(
      sink.records.some((record) =>
        record.event === "provider.ingestion.parse_error" &&
        record.channel === "security-audit"
      ),
    );
  });
});

Deno.test("FileProviderIngestionRunner skips watch setup when roots are missing", async () => {
  await withTempDir("provider-ingestion-missing-roots-", async (dir) => {
    const missingRoot = join(dir, "does-not-exist");
    let watchCalled = 0;

    const runner = new FileProviderIngestionRunner({
      provider: "test-provider",
      watchRoots: [missingRoot],
      sessionSnapshotStore: new InMemorySessionSnapshotStore(),
      watchFs() {
        watchCalled += 1;
        return Promise.resolve();
      },
      discoverSessions() {
        return Promise.resolve([]);
      },
      parseEvents(
        _filePath: string,
        _fromOffset: number,
        _ctx: { provider: string; sessionId: string },
      ) {
        return (async function* () {})();
      },
    });

    await runner.start();
    const result = await runner.poll();
    await runner.stop();

    assertEquals(watchCalled, 0);
    assertEquals(result.sessionsUpdated, 0);
    assertEquals(result.eventsObserved, 0);
  });
});

Deno.test("FileProviderIngestionRunner suppresses duplicate replayed messages", async () => {
  await withTempDir("provider-ingestion-dedupe-", async (dir) => {
    const sessionFile = join(dir, "session-dedupe.jsonl");
    await Deno.writeTextFile(sessionFile, "placeholder\n");

    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-22T20:15:00.000Z"),
    });
    const auditLogger = new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date("2026-02-22T20:15:00.000Z"),
      }),
    );

    const harness = makeWatchHarness();
    const store = new InMemorySessionSnapshotStore();
    const runner = new FileProviderIngestionRunner({
      provider: "test-provider",
      watchRoots: [dir],
      sessionSnapshotStore: store,
      watchFs: harness.watchFn,
      operationalLogger,
      auditLogger,
      discoverSessions() {
        return Promise.resolve([{
          sessionId: "session-dedupe",
          filePath: sessionFile,
          modifiedAtMs: Date.now(),
        }]);
      },
      parseEvents(
        _filePath: string,
        fromOffset: number,
        _ctx: { provider: string; sessionId: string },
      ) {
        return (async function* () {
          if (fromOffset === 0) {
            yield {
              event: makeEvent("m1", "2026-02-22T20:15:00.000Z"),
              cursor: { kind: "byte-offset" as const, value: 10 },
            };
          } else if (fromOffset === 10) {
            // Simulate replayed event after provider offset drift.
            yield {
              event: makeEvent("m1", "2026-02-22T20:15:00.000Z"),
              cursor: { kind: "byte-offset" as const, value: 20 },
            };
          }
        })();
      },
    });

    await runner.start();
    await runner.poll();
    await harness.emitModify(sessionFile);
    await runner.poll();
    await runner.stop();

    const snapshot = store.get("session-dedupe");
    assertExists(snapshot);
    assertEquals(snapshot.events.length, 1);
    assert(
      sink.records.some((record) =>
        record.event === "provider.ingestion.events_dropped" &&
        record.channel === "operational"
      ),
    );
  });
});

Deno.test("createClaudeIngestionRunner ingests discovered Claude sessions", async () => {
  await withTempDir("provider-ingestion-claude-", async (dir) => {
    const projectDir = join(dir, "project-1");
    await Deno.mkdir(projectDir, { recursive: true });
    const sessionPath = join(projectDir, "session-claude.jsonl");
    await Deno.writeTextFile(
      sessionPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          timestamp: "2026-02-22T20:20:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-02-22T20:20:05.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "hi there" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const store = new InMemorySessionSnapshotStore();
    const harness = makeWatchHarness();
    const runner = createClaudeIngestionRunner({
      sessionSnapshotStore: store,
      sessionRoots: [dir],
      watchFs: harness.watchFn,
    });

    await runner.start();
    const result = await runner.poll();
    await runner.stop();

    assertEquals(result.provider, "claude");
    assertEquals(result.sessionsUpdated, 1);
    assert(result.eventsObserved >= 1);
    const snapshot = store.get("session-claude");
    assertExists(snapshot);
    assertEquals(snapshot.provider, "claude");
    assert(snapshot.events.length >= 1);
    assertEquals(snapshot.cursor.kind, "byte-offset");
  });
});

Deno.test("createCodexIngestionRunner ingests discovered Codex sessions", async () => {
  await withTempDir("provider-ingestion-codex-", async (dir) => {
    const dayDir = join(dir, "2026", "02", "22");
    await Deno.mkdir(dayDir, { recursive: true });
    const sessionPath = join(dayDir, "session-codex.jsonl");
    await Deno.writeTextFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "codex-session-1",
            source: "chat",
            cwd: "/tmp/workspace",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "## My request for Codex:\nhello",
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            phase: "final_answer",
            content: [{ type: "text", text: "hi there" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const store = new InMemorySessionSnapshotStore();
    const harness = makeWatchHarness();
    const runner = createCodexIngestionRunner({
      sessionSnapshotStore: store,
      sessionRoots: [dir],
      watchFs: harness.watchFn,
    });

    await runner.start();
    const result = await runner.poll();
    await runner.stop();

    assertEquals(result.provider, "codex");
    assertEquals(result.sessionsUpdated, 1);
    assert(result.eventsObserved >= 1);
    const snapshot = store.get("codex-session-1");
    assertExists(snapshot);
    assertEquals(snapshot.provider, "codex");
    assert(snapshot.events.length >= 1);
    assertEquals(snapshot.cursor.kind, "byte-offset");
  });
});
