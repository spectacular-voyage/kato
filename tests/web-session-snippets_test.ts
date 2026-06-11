import { assertEquals } from "@std/assert";
import type {
  DaemonSessionStatus,
  DaemonStatusSnapshot,
  SessionTwinEventV1,
} from "@kato/shared";
import { PersistentSessionStateStore } from "../apps/runtime/src/mod.ts";
import { resolveSessionSnippet } from "../apps/web/src/session_snippets.ts";
import { withTestTempDir } from "./test_temp.ts";

const PLANTED_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

function makeStatusStore(
  sessions: DaemonSessionStatus[],
): {
  load(): Promise<DaemonStatusSnapshot>;
  save(snapshot: DaemonStatusSnapshot): Promise<void>;
} {
  const snapshot: DaemonStatusSnapshot = {
    schemaVersion: 2,
    generatedAt: "2026-03-11T10:00:00.000Z",
    heartbeatAt: "2026-03-11T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
    sessions,
  };
  return {
    load() {
      return Promise.resolve(structuredClone(snapshot));
    },
    save(_nextSnapshot: DaemonStatusSnapshot) {
      return Promise.resolve();
    },
  };
}

async function createSnippetSessionFixture(options: {
  katoDir: string;
  sessionId: string;
  providerSessionId: string;
  sourceName: string;
  sourceContents?: string;
}) {
  const sourceDir = `${options.katoDir}/sources`;
  await Deno.mkdir(sourceDir, { recursive: true });
  const sourceFilePath = `${sourceDir}/${options.sourceName}.jsonl`;
  await Deno.writeTextFile(sourceFilePath, options.sourceContents ?? "");

  const store = new PersistentSessionStateStore({
    katoDir: options.katoDir,
    now: () => new Date("2026-03-11T10:00:00.000Z"),
    makeSessionId: () => options.sessionId,
  });
  const metadata = await store.getOrCreateSessionMetadata({
    provider: "codex",
    providerSessionId: options.providerSessionId,
    sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });

  return {
    store,
    metadata,
  };
}

function makeTwinEvent(
  sessionId: string,
  emitIndex: number,
  text: string,
): SessionTwinEventV1 {
  return {
    schemaVersion: 1,
    session: {
      provider: "codex",
      providerSessionId: "provider-session",
      sessionId,
    },
    seq: 1,
    kind: "user.message",
    source: {
      providerEventType: "conversation.item.created",
      cursor: { kind: "byte-offset", value: 10 + emitIndex },
      emitIndex,
    },
    payload: { text },
  };
}

Deno.test("resolveSessionSnippet prefers trimmed live snippets over persisted twin history", async () => {
  await withTestTempDir("web-session-snippets-live-", async (rootDir) => {
    const katoDir = `${rootDir}/.kato`;
    const { metadata, store } = await createSnippetSessionFixture({
      katoDir,
      sessionId: "sess-live",
      providerSessionId: "provider-live",
      sourceName: "live",
    });
    await store.appendTwinEvents(metadata, [
      makeTwinEvent(metadata.sessionId, 0, "persisted twin snippet"),
    ]);

    const result = await resolveSessionSnippet({
      sessionId: metadata.sessionId,
      katoDir,
      statusStore: makeStatusStore([{
        provider: "codex",
        sessionId: metadata.sessionId,
        updatedAt: "2026-03-11T10:00:00.000Z",
        stale: false,
        snippet: "  live snippet wins  ",
      }]),
    });

    assertEquals(result, {
      sessionId: metadata.sessionId,
      status: "ready",
      snippet: "live snippet wins",
      source: "live",
    });
  });
});

Deno.test("resolveSessionSnippet returns a twin snippet when source replay is disabled", async () => {
  await withTestTempDir("web-session-snippets-twin-only-", async (rootDir) => {
    const katoDir = `${rootDir}/.kato`;
    const { metadata, store } = await createSnippetSessionFixture({
      katoDir,
      sessionId: "sess-twin-only",
      providerSessionId: "provider-twin-only",
      sourceName: "twin-only",
    });
    await store.appendTwinEvents(metadata, [
      makeTwinEvent(metadata.sessionId, 0, "  twin only snippet  "),
    ]);

    const result = await resolveSessionSnippet({
      sessionId: metadata.sessionId,
      katoDir,
      allowSourceReplay: false,
      statusStore: makeStatusStore([]),
    });

    assertEquals(result, {
      sessionId: metadata.sessionId,
      status: "ready",
      snippet: "twin only snippet",
      source: "twin",
    });
  });
});

Deno.test("resolveSessionSnippet redacts legacy twin snippets when source replay is disabled", async () => {
  await withTestTempDir(
    "web-session-snippets-twin-redact-",
    async (rootDir) => {
      const katoDir = `${rootDir}/.kato`;
      const { metadata, store } = await createSnippetSessionFixture({
        katoDir,
        sessionId: "sess-twin-redact",
        providerSessionId: "provider-twin-redact",
        sourceName: "twin-redact",
      });
      await store.appendTwinEvents(metadata, [
        makeTwinEvent(metadata.sessionId, 0, `legacy key ${PLANTED_AWS_KEY}`),
      ]);

      const result = await resolveSessionSnippet({
        sessionId: metadata.sessionId,
        katoDir,
        allowSourceReplay: false,
        statusStore: makeStatusStore([]),
      });

      assertEquals(result, {
        sessionId: metadata.sessionId,
        status: "ready",
        snippet: "legacy key [REDACTED:aws-access-key-id]",
        source: "twin",
      });
    },
  );
});

Deno.test("resolveSessionSnippet uses twin history before source replay when both are allowed", async () => {
  await withTestTempDir("web-session-snippets-twin-first-", async (rootDir) => {
    const katoDir = `${rootDir}/.kato`;
    const { metadata, store } = await createSnippetSessionFixture({
      katoDir,
      sessionId: "sess-twin-first",
      providerSessionId: "provider-twin-first",
      sourceName: "twin-first",
      sourceContents: "",
    });
    await store.appendTwinEvents(metadata, [
      makeTwinEvent(metadata.sessionId, 0, "twin history wins"),
    ]);

    const result = await resolveSessionSnippet({
      sessionId: metadata.sessionId,
      katoDir,
      statusStore: makeStatusStore([]),
    });

    assertEquals(result, {
      sessionId: metadata.sessionId,
      status: "ready",
      snippet: "twin history wins",
      source: "twin",
    });
  });
});

Deno.test("resolveSessionSnippet returns unavailable when the session metadata is missing", async () => {
  await withTestTempDir("web-session-snippets-missing-", async (rootDir) => {
    const result = await resolveSessionSnippet({
      sessionId: "missing-session",
      katoDir: `${rootDir}/.kato`,
      statusStore: makeStatusStore([]),
    });

    assertEquals(result, {
      sessionId: "missing-session",
      status: "unavailable",
    });
  });
});

Deno.test("resolveSessionSnippet returns unavailable when replay is disabled and no twin exists", async () => {
  await withTestTempDir("web-session-snippets-no-twin-", async (rootDir) => {
    const katoDir = `${rootDir}/.kato`;
    const { metadata } = await createSnippetSessionFixture({
      katoDir,
      sessionId: "sess-no-twin",
      providerSessionId: "provider-no-twin",
      sourceName: "no-twin",
    });

    const result = await resolveSessionSnippet({
      sessionId: metadata.sessionId,
      katoDir,
      allowSourceReplay: false,
      statusStore: makeStatusStore([]),
    });

    assertEquals(result, {
      sessionId: metadata.sessionId,
      status: "unavailable",
    });
  });
});

Deno.test("resolveSessionSnippet degrades to unavailable when twin reads fail", async () => {
  await withTestTempDir(
    "web-session-snippets-twin-read-error-",
    async (rootDir) => {
      const katoDir = `${rootDir}/.kato`;
      const { metadata } = await createSnippetSessionFixture({
        katoDir,
        sessionId: "sess-twin-read-error",
        providerSessionId: "provider-twin-read-error",
        sourceName: "twin-read-error",
      });
      await Deno.mkdir(metadata.twinPath, { recursive: true });

      const result = await resolveSessionSnippet({
        sessionId: metadata.sessionId,
        katoDir,
        allowSourceReplay: false,
        statusStore: makeStatusStore([]),
      });

      assertEquals(result, {
        sessionId: metadata.sessionId,
        status: "unavailable",
      });
    },
  );
});

Deno.test("resolveSessionSnippet returns unavailable when source replay finds no snippet", async () => {
  await withTestTempDir(
    "web-session-snippets-empty-source-",
    async (rootDir) => {
      const katoDir = `${rootDir}/.kato`;
      const { metadata } = await createSnippetSessionFixture({
        katoDir,
        sessionId: "sess-empty-source",
        providerSessionId: "provider-empty-source",
        sourceName: "empty-source",
        sourceContents: "",
      });

      const result = await resolveSessionSnippet({
        sessionId: metadata.sessionId,
        katoDir,
        statusStore: makeStatusStore([]),
      });

      assertEquals(result, {
        sessionId: metadata.sessionId,
        status: "unavailable",
      });
    },
  );
});

Deno.test("resolveSessionSnippet degrades to unavailable when source replay fails", async () => {
  await withTestTempDir(
    "web-session-snippets-source-replay-error-",
    async (rootDir) => {
      const katoDir = `${rootDir}/.kato`;
      const { metadata } = await createSnippetSessionFixture({
        katoDir,
        sessionId: "sess-source-replay-error",
        providerSessionId: "provider-source-replay-error",
        sourceName: "source-replay-error",
      });
      await Deno.remove(metadata.sourceFilePath);
      await Deno.mkdir(metadata.sourceFilePath, { recursive: true });

      const result = await resolveSessionSnippet({
        sessionId: metadata.sessionId,
        katoDir,
        statusStore: makeStatusStore([]),
      });

      assertEquals(result, {
        sessionId: metadata.sessionId,
        status: "unavailable",
      });
    },
  );
});
