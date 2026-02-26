import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import {
  AuditLogger,
  createClaudeIngestionRunner,
  createCodexIngestionRunner,
  createGeminiIngestionRunner,
  FileProviderIngestionRunner,
  InMemorySessionSnapshotStore,
  type LogRecord,
  PersistentSessionStateStore,
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

interface GeminiFixtureMessage {
  id: string;
  type: "user" | "gemini";
  content: string;
  timestamp: string;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function writeGeminiSessionFixture(
  filePath: string,
  sessionId: string,
  messages: GeminiFixtureMessage[],
): Promise<void> {
  await Deno.writeTextFile(
    filePath,
    JSON.stringify(
      {
        sessionId,
        messages: messages.map((message) => ({
          id: message.id,
          type: message.type,
          timestamp: message.timestamp,
          content: message.content,
          displayContent: message.content,
        })),
      },
      null,
      2,
    ),
  );
}

function parseGeminiFixtureEvents(
  filePath: string,
  fromOffset: number,
  ctx: { provider: string; sessionId: string },
): AsyncIterable<
  { event: ConversationEvent; cursor: { kind: "item-index"; value: number } }
> {
  return (async function* () {
    const parsed = JSON.parse(await Deno.readTextFile(filePath)) as unknown;
    const root =
      (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        ? parsed as Record<string, unknown>
        : {};
    const rawMessages = Array.isArray(root["messages"]) ? root["messages"] : [];
    const start = Math.max(0, Math.floor(fromOffset));

    for (let index = start; index < rawMessages.length; index += 1) {
      const raw = rawMessages[index];
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        continue;
      }
      const message = raw as Record<string, unknown>;
      const type = readOptionalString(message["type"]);
      if (type !== "user" && type !== "gemini") {
        continue;
      }
      const messageId = readOptionalString(message["id"]) ??
        `${ctx.sessionId}:${index}`;
      const content = readOptionalString(message["content"]) ??
        readOptionalString(message["displayContent"]) ?? "";
      if (content.length === 0) {
        continue;
      }

      const cursor = { kind: "item-index" as const, value: index + 1 };
      yield {
        event: {
          eventId: `${ctx.sessionId}:${messageId}`,
          provider: ctx.provider,
          sessionId: ctx.sessionId,
          timestamp: readOptionalString(message["timestamp"]) ??
            "2026-02-26T10:00:00.000Z",
          kind: type === "user" ? "message.user" : "message.assistant",
          role: type === "user" ? "user" : "assistant",
          content,
          source: {
            providerEventType: type,
            providerEventId: messageId,
            rawCursor: cursor,
          },
        } as ConversationEvent,
        cursor,
      };
    }
  })();
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

Deno.test("FileProviderIngestionRunner restores persisted cursor and hydrates snapshot from session twin", async () => {
  await withTempDir("provider-ingestion-persistent-", async (dir) => {
    const sessionFile = join(dir, "session-persist.jsonl");
    await Deno.writeTextFile(sessionFile, "placeholder\n");
    const stateRoot = join(dir, ".kato");
    const parseOffsets: number[] = [];

    function makeRunner(store: InMemorySessionSnapshotStore) {
      return new FileProviderIngestionRunner({
        provider: "test-provider",
        watchRoots: [dir],
        sessionSnapshotStore: store,
        sessionStateStore: new PersistentSessionStateStore({
          katoDir: stateRoot,
          now: () => new Date("2026-02-26T10:00:00.000Z"),
          makeSessionId: () => "session-uuid-abcdef12",
        }),
        autoGenerateSnapshots: true,
        discoverSessions() {
          return Promise.resolve([{
            sessionId: "session-persist",
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
                event: makeEvent("persist-1", "2026-02-26T10:00:00.000Z"),
                cursor: { kind: "byte-offset" as const, value: 10 },
              };
            }
          })();
        },
      });
    }

    const firstStore = new InMemorySessionSnapshotStore();
    const firstRunner = makeRunner(firstStore);
    await firstRunner.start();
    await firstRunner.poll();
    await firstRunner.stop();

    const firstSnapshot = firstStore.get("session-persist");
    assertExists(firstSnapshot);
    assertEquals(firstSnapshot.events.length, 1);

    const secondStore = new InMemorySessionSnapshotStore();
    const secondRunner = makeRunner(secondStore);
    await secondRunner.start();
    await secondRunner.poll();
    await secondRunner.stop();

    const secondSnapshot = secondStore.get("session-persist");
    assertExists(secondSnapshot);
    assertEquals(secondSnapshot.events.length, 1);
    assertEquals(parseOffsets, [0, 10]);
  });
});

Deno.test("FileProviderIngestionRunner bootstraps twin on-demand when twin file is missing", async () => {
  await withTempDir(
    "provider-ingestion-bootstrap-missing-twin-",
    async (dir) => {
      const sessionFile = join(dir, "session-bootstrap.jsonl");
      await Deno.writeTextFile(sessionFile, "placeholder\n");
      const stateRoot = join(dir, ".kato");
      const parseOffsets: number[] = [];
      let phase: "initial" | "recovery" = "initial";

      function makeRunner(store: InMemorySessionSnapshotStore) {
        return new FileProviderIngestionRunner({
          provider: "test-provider",
          watchRoots: [dir],
          sessionSnapshotStore: store,
          sessionStateStore: new PersistentSessionStateStore({
            katoDir: stateRoot,
            now: () => new Date("2026-02-26T10:00:00.000Z"),
            makeSessionId: () => "session-uuid-bootstrap-1",
          }),
          autoGenerateSnapshots: true,
          discoverSessions() {
            return Promise.resolve([{
              sessionId: "session-bootstrap",
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
                  event: makeEvent("bootstrap-1", "2026-02-26T10:00:00.000Z"),
                  cursor: { kind: "byte-offset" as const, value: 10 },
                };
              }
              if (phase === "recovery" && fromOffset === 10) {
                yield {
                  event: makeEvent("bootstrap-2", "2026-02-26T10:00:01.000Z"),
                  cursor: { kind: "byte-offset" as const, value: 20 },
                };
              }
            })();
          },
        });
      }

      const firstStore = new InMemorySessionSnapshotStore();
      const firstRunner = makeRunner(firstStore);
      await firstRunner.start();
      await firstRunner.poll();
      await firstRunner.stop();
      phase = "recovery";

      const stateStore = new PersistentSessionStateStore({
        katoDir: stateRoot,
        now: () => new Date("2026-02-26T10:00:00.000Z"),
        makeSessionId: () => "session-uuid-bootstrap-1",
      });
      const metadata = await stateStore.getOrCreateSessionMetadata({
        provider: "test-provider",
        providerSessionId: "session-bootstrap",
        sourceFilePath: sessionFile,
        initialCursor: { kind: "byte-offset", value: 0 },
      });
      await Deno.remove(metadata.twinPath);

      const secondStore = new InMemorySessionSnapshotStore();
      const secondRunner = makeRunner(secondStore);
      await secondRunner.start();
      await secondRunner.poll();
      await secondRunner.stop();

      const secondSnapshot = secondStore.get("session-bootstrap");
      assertExists(secondSnapshot);
      assertEquals(secondSnapshot.events.length, 2);
      assertEquals(
        secondSnapshot.events.map((event) =>
          event.kind === "message.assistant" ? event.content : undefined
        ),
        ["bootstrap-1-content", "bootstrap-2-content"],
      );
      assertEquals(parseOffsets, [0, 0, 10]);

      const reloadedStateStore = new PersistentSessionStateStore({
        katoDir: stateRoot,
        now: () => new Date("2026-02-26T10:00:00.000Z"),
        makeSessionId: () => "session-uuid-bootstrap-1",
      });
      const updatedMetadata = await reloadedStateStore
        .getOrCreateSessionMetadata({
          provider: "test-provider",
          providerSessionId: "session-bootstrap",
          sourceFilePath: sessionFile,
          initialCursor: { kind: "byte-offset", value: 0 },
        });
      assertEquals(updatedMetadata.ingestCursor, {
        kind: "byte-offset",
        value: 20,
      });
      assertEquals(updatedMetadata.nextTwinSeq, 3);

      const twinEvents = await reloadedStateStore.readTwinEvents(
        updatedMetadata,
        1,
      );
      assertEquals(twinEvents.map((event) => event.seq), [1, 2]);
      assertEquals(
        new Set(twinEvents.map((event) => event.seq)).size,
        twinEvents.length,
      );
    },
  );
});

Deno.test("FileProviderIngestionRunner fails closed for session with unsupported metadata schema", async () => {
  await withTempDir("provider-ingestion-fail-closed-schema-", async (dir) => {
    const sessionFile = join(dir, "session-fail-closed.jsonl");
    await Deno.writeTextFile(sessionFile, "placeholder\n");
    const stateRoot = join(dir, ".kato");

    const stateStore = new PersistentSessionStateStore({
      katoDir: stateRoot,
      now: () => new Date("2026-02-26T10:00:00.000Z"),
      makeSessionId: () => "session-uuid-fail-closed-1",
    });
    const location = stateStore.resolveLocation({
      provider: "test-provider",
      providerSessionId: "session-fail-closed",
    });
    await Deno.mkdir(join(stateRoot, "sessions"), { recursive: true });
    await Deno.writeTextFile(
      location.metadataPath,
      JSON.stringify({
        schemaVersion: 999,
        provider: "test-provider",
      }),
    );

    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-26T10:00:00.000Z"),
    });
    const auditLogger = new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date("2026-02-26T10:00:00.000Z"),
      }),
    );

    let parseCalled = false;
    const runner = new FileProviderIngestionRunner({
      provider: "test-provider",
      watchRoots: [dir],
      sessionSnapshotStore: new InMemorySessionSnapshotStore(),
      sessionStateStore: stateStore,
      autoGenerateSnapshots: true,
      operationalLogger,
      auditLogger,
      discoverSessions() {
        return Promise.resolve([{
          sessionId: "session-fail-closed",
          filePath: sessionFile,
          modifiedAtMs: Date.now(),
        }]);
      },
      parseEvents() {
        parseCalled = true;
        return (async function* () {})();
      },
    });

    await runner.start();
    const result = await runner.poll();
    await runner.stop();

    assertEquals(result.sessionsUpdated, 0);
    assertEquals(result.eventsObserved, 0);
    assertEquals(parseCalled, false);
    assert(
      sink.records.some((record) =>
        record.event === "session.state.fail_closed" &&
        record.channel === "operational"
      ),
    );
    assert(
      sink.records.some((record) =>
        record.event === "session.state.fail_closed" &&
        record.channel === "security-audit"
      ),
    );
  });
});

Deno.test("FileProviderIngestionRunner realigns Gemini cursor via persisted anchor", async () => {
  await withTempDir(
    "provider-ingestion-gemini-anchor-realign-",
    async (dir) => {
      const sessionId = "gemini-session-anchor";
      const sessionFile = join(dir, "session-gemini-anchor.json");
      const stateRoot = join(dir, ".kato");
      const parseOffsets: number[] = [];
      const sink = new CaptureSink();
      const operationalLogger = new StructuredLogger([sink], {
        channel: "operational",
        minLevel: "debug",
        now: () => new Date("2026-02-26T10:00:00.000Z"),
      });
      const auditLogger = new AuditLogger(
        new StructuredLogger([sink], {
          channel: "security-audit",
          minLevel: "debug",
          now: () => new Date("2026-02-26T10:00:00.000Z"),
        }),
      );

      await writeGeminiSessionFixture(sessionFile, sessionId, [
        {
          id: "m-a",
          type: "user",
          content: "first",
          timestamp: "2026-02-26T10:00:00.000Z",
        },
        {
          id: "m-b",
          type: "gemini",
          content: "second",
          timestamp: "2026-02-26T10:00:01.000Z",
        },
      ]);

      function makeRunner(store: InMemorySessionSnapshotStore) {
        return new FileProviderIngestionRunner({
          provider: "gemini",
          watchRoots: [dir],
          sessionSnapshotStore: store,
          sessionStateStore: new PersistentSessionStateStore({
            katoDir: stateRoot,
            now: () => new Date("2026-02-26T10:00:00.000Z"),
            makeSessionId: () => "kato-gemini-anchor-1234",
          }),
          autoGenerateSnapshots: true,
          operationalLogger,
          auditLogger,
          discoverSessions() {
            return Promise.resolve([{
              sessionId,
              filePath: sessionFile,
              modifiedAtMs: Date.now(),
            }]);
          },
          parseEvents(filePath, fromOffset, ctx) {
            parseOffsets.push(fromOffset);
            return parseGeminiFixtureEvents(filePath, fromOffset, ctx);
          },
        });
      }

      const firstStore = new InMemorySessionSnapshotStore();
      const firstRunner = makeRunner(firstStore);
      await firstRunner.start();
      await firstRunner.poll();
      await firstRunner.stop();

      await writeGeminiSessionFixture(sessionFile, sessionId, [
        {
          id: "m-b",
          type: "gemini",
          content: "second",
          timestamp: "2026-02-26T10:00:01.000Z",
        },
        {
          id: "m-x",
          type: "user",
          content: "third",
          timestamp: "2026-02-26T10:00:02.000Z",
        },
        {
          id: "m-c",
          type: "gemini",
          content: "fourth",
          timestamp: "2026-02-26T10:00:03.000Z",
        },
      ]);

      const secondStore = new InMemorySessionSnapshotStore();
      const secondRunner = makeRunner(secondStore);
      await secondRunner.start();
      await secondRunner.poll();
      await secondRunner.stop();

      assertEquals(parseOffsets, [0, 1]);
      assert(
        sink.records.some((record) =>
          record.event === "provider.ingestion.anchor.realigned" &&
          record.channel === "operational"
        ),
      );
    },
  );
});

Deno.test("FileProviderIngestionRunner replays Gemini from start when anchor is missing", async () => {
  await withTempDir("provider-ingestion-gemini-anchor-replay-", async (dir) => {
    const sessionId = "gemini-session-replay";
    const sessionFile = join(dir, "session-gemini-replay.json");
    const stateRoot = join(dir, ".kato");
    const parseOffsets: number[] = [];
    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-26T10:00:00.000Z"),
    });
    const auditLogger = new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date("2026-02-26T10:00:00.000Z"),
      }),
    );

    await writeGeminiSessionFixture(sessionFile, sessionId, [
      {
        id: "m-a",
        type: "user",
        content: "first",
        timestamp: "2026-02-26T10:00:00.000Z",
      },
      {
        id: "m-b",
        type: "gemini",
        content: "second",
        timestamp: "2026-02-26T10:00:01.000Z",
      },
    ]);

    function makeRunner(store: InMemorySessionSnapshotStore) {
      return new FileProviderIngestionRunner({
        provider: "gemini",
        watchRoots: [dir],
        sessionSnapshotStore: store,
        sessionStateStore: new PersistentSessionStateStore({
          katoDir: stateRoot,
          now: () => new Date("2026-02-26T10:00:00.000Z"),
          makeSessionId: () => "kato-gemini-replay-5678",
        }),
        autoGenerateSnapshots: true,
        operationalLogger,
        auditLogger,
        discoverSessions() {
          return Promise.resolve([{
            sessionId,
            filePath: sessionFile,
            modifiedAtMs: Date.now(),
          }]);
        },
        parseEvents(filePath, fromOffset, ctx) {
          parseOffsets.push(fromOffset);
          return parseGeminiFixtureEvents(filePath, fromOffset, ctx);
        },
      });
    }

    const firstStore = new InMemorySessionSnapshotStore();
    const firstRunner = makeRunner(firstStore);
    await firstRunner.start();
    await firstRunner.poll();
    await firstRunner.stop();

    await writeGeminiSessionFixture(sessionFile, sessionId, [
      {
        id: "m-x",
        type: "user",
        content: "replacement-1",
        timestamp: "2026-02-26T10:00:02.000Z",
      },
      {
        id: "m-y",
        type: "gemini",
        content: "replacement-2",
        timestamp: "2026-02-26T10:00:03.000Z",
      },
    ]);

    const secondStore = new InMemorySessionSnapshotStore();
    const secondRunner = makeRunner(secondStore);
    await secondRunner.start();
    await secondRunner.poll();
    await secondRunner.stop();

    assertEquals(parseOffsets, [0, 0]);
    assert(
      sink.records.some((record) =>
        record.event === "provider.ingestion.anchor.not_found" &&
        record.channel === "operational"
      ),
    );
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
    assertEquals(
      sink.records.some((record) =>
        record.event === "provider.ingestion.parse_error" &&
        record.channel === "security-audit"
      ),
      false,
    );
  });
});

Deno.test("FileProviderIngestionRunner audits permission-denied discovery failures", async () => {
  await withTempDir(
    "provider-ingestion-access-denied-discovery-",
    async (dir) => {
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
          return Promise.reject(
            new Deno.errors.PermissionDenied("read denied"),
          );
        },
        parseEvents() {
          return (async function* () {})();
        },
      });

      await runner.start();
      const result = await runner.poll();
      await runner.stop();

      assertEquals(result.sessionsUpdated, 0);
      assertEquals(result.eventsObserved, 0);
      assert(
        sink.records.some((record) =>
          record.event === "provider.ingestion.read_denied" &&
          record.channel === "operational" &&
          record.attributes?.["operation"] === "readDir"
        ),
      );
      assert(
        sink.records.some((record) =>
          record.event === "provider.ingestion.read_denied" &&
          record.channel === "security-audit" &&
          record.attributes?.["operation"] === "readDir"
        ),
      );
    },
  );
});

Deno.test("FileProviderIngestionRunner audits permission-denied parse reads", async () => {
  await withTempDir("provider-ingestion-access-denied-open-", async (dir) => {
    const sessionFile = join(dir, "session-denied.jsonl");
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
          sessionId: "session-denied",
          filePath: sessionFile,
          modifiedAtMs: Date.now(),
        }]);
      },
      parseEvents() {
        return (async function* () {
          if (Date.now() < 0) {
            yield {
              event: makeEvent("unreachable", "2026-02-22T00:00:00.000Z"),
              cursor: { kind: "byte-offset" as const, value: 0 },
            };
          }
          throw new Deno.errors.PermissionDenied("open denied");
        })();
      },
    });

    await runner.start();
    const result = await runner.poll();
    await runner.stop();

    assertEquals(result.sessionsUpdated, 0);
    assertEquals(result.eventsObserved, 0);
    assert(
      sink.records.some((record) =>
        record.event === "provider.ingestion.read_denied" &&
        record.channel === "operational" &&
        record.attributes?.["operation"] === "open" &&
        record.attributes?.["targetPath"] === sessionFile
      ),
    );
    assert(
      sink.records.some((record) =>
        record.event === "provider.ingestion.read_denied" &&
        record.channel === "security-audit" &&
        record.attributes?.["operation"] === "open" &&
        record.attributes?.["targetPath"] === sessionFile
      ),
    );
    assertEquals(
      sink.records.some((record) =>
        record.event === "provider.ingestion.parse_error"
      ),
      false,
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

Deno.test("FileProviderIngestionRunner logs duplicate session discovery warnings once per duplicate set", async () => {
  await withTempDir("provider-ingestion-duplicate-sessions-", async (dir) => {
    const sessionFileA = join(dir, "session-dup-a.jsonl");
    const sessionFileB = join(dir, "session-dup-b.jsonl");
    await Deno.writeTextFile(sessionFileA, "placeholder\n");
    await Deno.writeTextFile(sessionFileB, "placeholder\n");

    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-22T20:16:00.000Z"),
    });
    const auditLogger = new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date("2026-02-22T20:16:00.000Z"),
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
      discoveryIntervalMs: 0,
      discoverSessions() {
        return Promise.resolve([
          {
            sessionId: "shared-session-id",
            filePath: sessionFileA,
            modifiedAtMs: Date.now(),
          },
          {
            sessionId: "shared-session-id",
            filePath: sessionFileB,
            modifiedAtMs: Date.now() - 1,
          },
        ]);
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
    await runner.poll();
    await runner.poll();
    await runner.stop();

    const duplicateDiscoveryWarnings = sink.records.filter((record) =>
      record.event === "provider.ingestion.events_dropped" &&
      record.channel === "operational" &&
      record.attributes?.["reason"] === "duplicate-session-id"
    );
    assertEquals(duplicateDiscoveryWarnings.length, 1);
    assert(
      duplicateDiscoveryWarnings.every((record) =>
        Array.isArray(record.attributes?.["duplicateSessionIds"])
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

Deno.test("createGeminiIngestionRunner ingests discovered Gemini sessions", async () => {
  await withTempDir("provider-ingestion-gemini-", async (dir) => {
    const chatsDir = join(dir, "project-alpha", "chats");
    await Deno.mkdir(chatsDir, { recursive: true });
    const sessionPath = join(chatsDir, "session-2026-02-24-example.json");
    await Deno.writeTextFile(
      sessionPath,
      JSON.stringify({
        sessionId: "gemini-session-1",
        startTime: "2026-02-24T20:00:00.000Z",
        lastUpdated: "2026-02-24T20:00:10.000Z",
        messages: [
          {
            id: "u1",
            timestamp: "2026-02-24T20:00:01.000Z",
            type: "user",
            displayContent: [{ text: "build auth middleware" }],
            content: [{ text: "ignored because displayContent exists" }],
          },
          {
            id: "a1",
            timestamp: "2026-02-24T20:00:05.000Z",
            type: "gemini",
            model: "gemini-2.0-pro",
            content: "I will inspect your routes first.",
            toolCalls: [{
              id: "tool-1",
              name: "run_shell_command",
              args: { command: "ls src/routes" },
              resultDisplay: "auth.ts\nusers.ts",
            }],
          },
          {
            id: "i1",
            timestamp: "2026-02-24T20:00:06.000Z",
            type: "info",
            content: "ignored info event",
          },
        ],
      }),
    );

    const store = new InMemorySessionSnapshotStore();
    const harness = makeWatchHarness();
    const runner = createGeminiIngestionRunner({
      sessionSnapshotStore: store,
      sessionRoots: [dir],
      watchFs: harness.watchFn,
    });

    await runner.start();
    const result = await runner.poll();
    await runner.stop();

    assertEquals(result.provider, "gemini");
    assertEquals(result.sessionsUpdated, 1);
    assert(result.eventsObserved >= 3);
    const snapshot = store.get("gemini-session-1");
    assertExists(snapshot);
    assertEquals(snapshot.provider, "gemini");
    assertEquals(snapshot.cursor.kind, "item-index");
    assertEquals(
      snapshot.events.some((event) => event.kind === "provider.info"),
      false,
    );
    assertEquals(
      snapshot.events.some((event) => event.kind === "message.user"),
      true,
    );
    assertEquals(
      snapshot.events.some((event) => event.kind === "message.assistant"),
      true,
    );
  });
});
