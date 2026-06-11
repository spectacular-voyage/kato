import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent, SecretsPolicyConfig } from "@kato/shared";
import {
  AuditLogger,
  createClaudeIngestionRunner,
  createCodexIngestionRunner,
  createGeminiIngestionRunner,
  FileProviderIngestionRunner,
  type FileProviderIngestionRunnerOptions,
  InMemorySessionSnapshotStore,
  type LogRecord,
  PersistentSessionStateStore,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";
import {
  loadPersistedSessionHistoryEvents,
  replayProviderSourceEvents,
} from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

const PLANTED_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const PLANTED_GITHUB_PAT = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

const TEST_NOW_ISO = "2026-06-10T10:00:00.000Z";

function testNow(): Date {
  return new Date(TEST_NOW_ISO);
}

class CaptureSink {
  records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

function makeCapturedAuditLogger(): {
  auditLogger: AuditLogger;
  sink: CaptureSink;
} {
  const sink = new CaptureSink();
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "info",
      now: testNow,
    }),
  );
  return { auditLogger, sink };
}

function makeUserEvent(
  id: string,
  content: string,
): ConversationEvent {
  return {
    eventId: id,
    provider: "test-provider",
    sessionId: "sess-secrets",
    timestamp: TEST_NOW_ISO,
    kind: "message.user",
    role: "user",
    content,
    source: { providerEventType: "user", providerEventId: id },
  } as unknown as ConversationEvent;
}

interface SecretsRunnerSetup {
  dir: string;
  store: InMemorySessionSnapshotStore;
  stateRoot: string;
  secretsPolicy?: SecretsPolicyConfig;
  auditLogger?: AuditLogger;
  events: ConversationEvent[];
}

function makeSecretsTestRunner(
  setup: SecretsRunnerSetup,
): FileProviderIngestionRunner {
  const sessionFile = join(setup.dir, "session-secrets.jsonl");
  const options: FileProviderIngestionRunnerOptions = {
    provider: "test-provider",
    watchRoots: [setup.dir],
    sessionSnapshotStore: setup.store,
    sessionStateStore: new PersistentSessionStateStore({
      katoDir: setup.stateRoot,
      now: testNow,
      makeSessionId: () => "session-uuid-secrets-1",
    }),
    autoGenerateTwins: true,
    now: testNow,
    discoverSessions() {
      return Promise.resolve([{
        sessionId: "session-secrets",
        filePath: sessionFile,
        modifiedAtMs: Date.now(),
      }]);
    },
    parseEvents(_filePath, fromOffset) {
      const events = setup.events;
      return (async function* () {
        if (fromOffset === 0) {
          for (let i = 0; i < events.length; i += 1) {
            yield {
              event: events[i]!,
              cursor: { kind: "byte-offset" as const, value: (i + 1) * 10 },
            };
          }
        }
      })();
    },
    watchFs(_paths, _onBatch, opts: { signal?: AbortSignal }) {
      return new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
    ...(setup.secretsPolicy ? { secretsPolicy: setup.secretsPolicy } : {}),
    ...(setup.auditLogger ? { auditLogger: setup.auditLogger } : {}),
  };
  return new FileProviderIngestionRunner(options);
}

Deno.test("ingestion redacts secrets in snapshot, twin file, and snippet by default", async () => {
  await withTestTempDir("secrets-integration-default-", async (dir) => {
    await Deno.writeTextFile(join(dir, "session-secrets.jsonl"), "seed\n");
    const stateRoot = join(dir, ".kato");
    const store = new InMemorySessionSnapshotStore();
    const { auditLogger, sink } = makeCapturedAuditLogger();
    const runner = makeSecretsTestRunner({
      dir,
      store,
      stateRoot,
      auditLogger,
      events: [
        makeUserEvent(
          "evt-1",
          `please use ${PLANTED_AWS_KEY} for deploy`,
        ),
        makeUserEvent("evt-2", `and the PAT ${PLANTED_GITHUB_PAT}`),
      ],
    });

    await runner.start();
    await runner.poll();
    await runner.stop();

    // snapshot redacted
    const snapshot = store.get("session-secrets");
    assertExists(snapshot);
    const contents = snapshot.events.map((event) =>
      event.kind === "message.user" ? event.content : ""
    ).join("\n");
    assert(!contents.includes(PLANTED_AWS_KEY), "snapshot leaked aws key");
    assert(!contents.includes(PLANTED_GITHUB_PAT), "snapshot leaked pat");
    assert(contents.includes("[REDACTED:aws-access-key-id]"));
    assert(contents.includes("[REDACTED:github-pat]"));

    // snippet redacted
    assert(
      !(snapshot.metadata.snippet ?? "").includes(PLANTED_AWS_KEY),
      "snippet leaked aws key",
    );

    // twin file on disk redacted
    const stateStore = new PersistentSessionStateStore({
      katoDir: stateRoot,
      now: testNow,
      makeSessionId: () => "session-uuid-secrets-1",
    });
    const metadata = await stateStore.getOrCreateSessionMetadata({
      provider: "test-provider",
      providerSessionId: "session-secrets",
      sourceFilePath: join(dir, "session-secrets.jsonl"),
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    const twinRaw = await Deno.readTextFile(metadata.twinPath);
    assert(!twinRaw.includes(PLANTED_AWS_KEY), "twin leaked aws key");
    assert(!twinRaw.includes(PLANTED_GITHUB_PAT), "twin leaked pat");
    assert(twinRaw.includes("[REDACTED:aws-access-key-id]"));

    // audit event emitted without secret content
    const auditRecords = sink.records.filter((record) =>
      record.event === "secrets.redacted"
    );
    assertEquals(auditRecords.length, 1);
    const attributes = auditRecords[0]?.attributes as {
      countsByRule: Record<string, number>;
      eventsAffected: number;
      mode: string;
    };
    assertEquals(attributes.mode, "redact");
    assertEquals(attributes.eventsAffected, 2);
    assertEquals(attributes.countsByRule["aws-access-key-id"], 1);
    assertEquals(attributes.countsByRule["github-pat"], 1);
    assert(
      !JSON.stringify(auditRecords).includes(PLANTED_AWS_KEY),
      "audit log leaked secret",
    );
  });
});

Deno.test("ingestion detect mode reports but does not alter content", async () => {
  await withTestTempDir("secrets-integration-detect-", async (dir) => {
    await Deno.writeTextFile(join(dir, "session-secrets.jsonl"), "seed\n");
    const store = new InMemorySessionSnapshotStore();
    const { auditLogger, sink } = makeCapturedAuditLogger();
    const runner = makeSecretsTestRunner({
      dir,
      store,
      stateRoot: join(dir, ".kato"),
      auditLogger,
      secretsPolicy: { mode: "detect", disabledRules: [], allowlist: [] },
      events: [makeUserEvent("evt-1", `key ${PLANTED_AWS_KEY}`)],
    });

    await runner.start();
    await runner.poll();
    await runner.stop();

    const snapshot = store.get("session-secrets");
    assertExists(snapshot);
    const event = snapshot.events[0];
    assert(event?.kind === "message.user");
    assertEquals(event.content, `key ${PLANTED_AWS_KEY}`);
    assertEquals(
      sink.records.filter((record) => record.event === "secrets.detected")
        .length,
      1,
    );
  });
});

Deno.test("ingestion off mode skips scanning entirely", async () => {
  await withTestTempDir("secrets-integration-off-", async (dir) => {
    await Deno.writeTextFile(join(dir, "session-secrets.jsonl"), "seed\n");
    const store = new InMemorySessionSnapshotStore();
    const { auditLogger, sink } = makeCapturedAuditLogger();
    const runner = makeSecretsTestRunner({
      dir,
      store,
      stateRoot: join(dir, ".kato"),
      auditLogger,
      secretsPolicy: { mode: "off", disabledRules: [], allowlist: [] },
      events: [makeUserEvent("evt-1", `key ${PLANTED_AWS_KEY}`)],
    });

    await runner.start();
    await runner.poll();
    await runner.stop();

    const snapshot = store.get("session-secrets");
    assertExists(snapshot);
    const event = snapshot.events[0];
    assert(event?.kind === "message.user");
    assertEquals(event.content, `key ${PLANTED_AWS_KEY}`);
    assertEquals(
      sink.records.filter((record) =>
        record.event === "secrets.detected" ||
        record.event === "secrets.redacted"
      ).length,
      0,
    );
  });
});

Deno.test("claude ingestion redacts planted secrets via real parser", async () => {
  await withTestTempDir("secrets-claude-", async (dir) => {
    const projectDir = join(dir, "project-1");
    await Deno.mkdir(projectDir, { recursive: true });
    await Deno.writeTextFile(
      join(projectDir, "session-claude.jsonl"),
      [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          timestamp: "2026-06-10T10:00:00.000Z",
          message: {
            role: "user",
            content: [{
              type: "text",
              text: `here is my key ${PLANTED_AWS_KEY} please deploy`,
            }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-06-10T10:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4-6",
            content: [{ type: "text", text: "done" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const store = new InMemorySessionSnapshotStore();
    const runner = createClaudeIngestionRunner({
      sessionSnapshotStore: store,
      sessionRoots: [dir],
      now: testNow,
      watchFs: (_paths, _onBatch, opts: { signal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    });
    await runner.start();
    await runner.poll();
    await runner.stop();

    const snapshot = store.get("session-claude");
    assertExists(snapshot);
    const serialized = JSON.stringify(snapshot.events);
    assert(!serialized.includes(PLANTED_AWS_KEY), "claude snapshot leaked");
    assert(serialized.includes("[REDACTED:aws-access-key-id]"));
  });
});

Deno.test("codex ingestion redacts planted secrets via real parser", async () => {
  await withTestTempDir("secrets-codex-", async (dir) => {
    const dayDir = join(dir, "2026", "06", "10");
    await Deno.mkdir(dayDir, { recursive: true });
    await Deno.writeTextFile(
      join(dayDir, "session-codex.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-session-secrets", source: "chat", cwd: dir },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: `set token ${PLANTED_GITHUB_PAT}`,
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            phase: "final_answer",
            content: [{ type: "text", text: "ok" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const store = new InMemorySessionSnapshotStore();
    const runner = createCodexIngestionRunner({
      sessionSnapshotStore: store,
      sessionRoots: [dir],
      now: testNow,
      watchFs: (_paths, _onBatch, opts: { signal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    });
    await runner.start();
    await runner.poll();
    await runner.stop();

    const snapshot = store.get("codex-session-secrets");
    assertExists(snapshot);
    const serialized = JSON.stringify(snapshot.events);
    assert(!serialized.includes(PLANTED_GITHUB_PAT), "codex snapshot leaked");
    assert(serialized.includes("[REDACTED:github-pat]"));
  });
});

Deno.test("gemini ingestion redacts planted secrets in tool calls via real parser", async () => {
  await withTestTempDir("secrets-gemini-", async (dir) => {
    const chatsDir = join(dir, "project-alpha", "chats");
    await Deno.mkdir(chatsDir, { recursive: true });
    await Deno.writeTextFile(
      join(chatsDir, "session-2026-06-10-secrets.json"),
      JSON.stringify({
        sessionId: "gemini-session-secrets",
        startTime: "2026-06-10T10:00:00.000Z",
        lastUpdated: "2026-06-10T10:00:10.000Z",
        messages: [
          {
            id: "u1",
            timestamp: "2026-06-10T10:00:01.000Z",
            type: "user",
            displayContent: [{ text: "read my env file" }],
          },
          {
            id: "a1",
            timestamp: "2026-06-10T10:00:05.000Z",
            type: "gemini",
            model: "gemini-2.0-pro",
            content: "Reading it now.",
            toolCalls: [{
              id: "tool-1",
              name: "run_shell_command",
              args: { command: "cat .env" },
              resultDisplay: `AWS_ACCESS_KEY_ID=${PLANTED_AWS_KEY}\nDEBUG=1`,
            }],
          },
        ],
      }),
    );

    const store = new InMemorySessionSnapshotStore();
    const runner = createGeminiIngestionRunner({
      sessionSnapshotStore: store,
      sessionRoots: [dir],
      now: testNow,
      watchFs: (_paths, _onBatch, opts: { signal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    });
    await runner.start();
    await runner.poll();
    await runner.stop();

    const snapshot = store.get("gemini-session-secrets");
    assertExists(snapshot);
    const serialized = JSON.stringify(snapshot.events);
    assert(!serialized.includes(PLANTED_AWS_KEY), "gemini snapshot leaked");
    assert(serialized.includes("[REDACTED:aws-access-key-id]"));
  });
});

Deno.test("provider source replay redacts by default and honors mode off", async () => {
  await withTestTempDir("secrets-replay-", async (dir) => {
    const sourcePath = join(dir, "session-claude.jsonl");
    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-10T10:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: `key ${PLANTED_AWS_KEY}` }],
        },
      }) + "\n",
    );

    const metadata = {
      provider: "claude",
      providerSessionId: "session-claude",
      sourceFilePath: sourcePath,
    };

    const redacted = await replayProviderSourceEvents(metadata);
    const redactedSerialized = JSON.stringify(redacted.events);
    assert(
      !redactedSerialized.includes(PLANTED_AWS_KEY),
      "default replay leaked",
    );
    assert(redactedSerialized.includes("[REDACTED:aws-access-key-id]"));
    assertExists(redacted.redaction);
    assertEquals(redacted.redaction?.mode, "redact");

    const raw = await replayProviderSourceEvents(metadata, {
      secretsPolicy: { mode: "off", disabledRules: [], allowlist: [] },
    });
    assert(JSON.stringify(raw.events).includes(PLANTED_AWS_KEY));
    assertEquals(raw.redaction, undefined);
  });
});

Deno.test("persisted history falls back to redacted source replay when no twin exists", async () => {
  await withTestTempDir("secrets-history-", async (dir) => {
    const sourcePath = join(dir, "session-claude.jsonl");
    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-10T10:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: `key ${PLANTED_AWS_KEY}` }],
        },
      }) + "\n",
    );

    const stateStore = new PersistentSessionStateStore({
      katoDir: join(dir, ".kato"),
      now: testNow,
      makeSessionId: () => "session-uuid-history-1",
    });
    const metadata = await stateStore.getOrCreateSessionMetadata({
      provider: "claude",
      providerSessionId: "session-claude",
      sourceFilePath: sourcePath,
      initialCursor: { kind: "byte-offset", value: 0 },
    });

    const history = await loadPersistedSessionHistoryEvents(
      metadata,
      stateStore,
    );
    assertEquals(history.source, "source");
    assert(!JSON.stringify(history.events).includes(PLANTED_AWS_KEY));
  });
});

Deno.test("in-chat commands still parse in messages that also carry secrets", async () => {
  const { detectInChatControlCommands, createSecretsRedactor } = await import(
    "../apps/runtime/src/mod.ts"
  );
  const redactor = createSecretsRedactor({
    mode: "redact",
    disabledRules: [],
    allowlist: [],
  });
  const original = [
    "::capture-My.Proj notes/capture.md",
    `by the way my key is ${PLANTED_AWS_KEY}`,
  ].join("\n");
  const { text } = redactor.processText(original);
  assert(!text.includes(PLANTED_AWS_KEY));

  const detection = detectInChatControlCommands(text);
  assertEquals(detection.errors.length, 0);
  assertEquals(detection.commands.length, 1);
  assertEquals(detection.commands[0]?.verb, "capture");
  assertEquals(detection.commands[0]?.alias, "My.Proj");
});

Deno.test("twin dedupe stays stable when re-ingesting identical redacted content", async () => {
  await withTestTempDir("secrets-twin-dedupe-", async (dir) => {
    const { mapConversationEventsToTwin } = await import(
      "../apps/daemon/src/mod.ts"
    );
    const { createSecretsRedactor, redactConversationEvents } = await import(
      "../apps/runtime/src/mod.ts"
    );
    const stateStore = new PersistentSessionStateStore({
      katoDir: join(dir, ".kato"),
      now: testNow,
      makeSessionId: () => "session-uuid-dedupe-1",
    });
    const metadata = await stateStore.getOrCreateSessionMetadata({
      provider: "test-provider",
      providerSessionId: "session-dedupe",
      sourceFilePath: join(dir, "source.jsonl"),
      initialCursor: { kind: "byte-offset", value: 0 },
    });

    const redactor = createSecretsRedactor({
      mode: "redact",
      disabledRules: [],
      allowlist: [],
    });
    const makeDrafts = () => {
      const { events } = redactConversationEvents(
        [makeUserEvent("evt-1", `key ${PLANTED_AWS_KEY}`)],
        redactor,
      );
      return mapConversationEventsToTwin({
        provider: "test-provider",
        providerSessionId: "session-dedupe",
        sessionId: metadata.sessionId,
        events,
        mode: "live",
        capturedAt: TEST_NOW_ISO,
      });
    };

    const first = await stateStore.appendTwinEvents(metadata, makeDrafts());
    assertEquals(first.appended.length, 1);
    assertEquals(first.droppedAsDuplicate, 0);

    const reloaded = await stateStore.getOrCreateSessionMetadata({
      provider: "test-provider",
      providerSessionId: "session-dedupe",
      sourceFilePath: join(dir, "source.jsonl"),
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    const second = await stateStore.appendTwinEvents(reloaded, makeDrafts());
    assertEquals(second.appended.length, 0);
    assertEquals(second.droppedAsDuplicate, 1);
  });
});
