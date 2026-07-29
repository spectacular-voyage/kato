import { assert, assertEquals } from "@std/assert";
import type { SessionTwinEventV1, SessionTwinKind } from "@kato/shared";
import { PersistentSessionStateStore } from "../apps/runtime/src/mod.ts";
import { loadSessionTwinViewData } from "../apps/web/src/loaders/session_twin_view.ts";
import { withTestTempDir } from "./test_temp.ts";

const PLANTED_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

async function createTwinFixture(options: {
  katoDir: string;
  sessionId: string;
  texts: Array<{ kind: SessionTwinKind; text: string }>;
}) {
  const sourceDir = `${options.katoDir}/sources`;
  await Deno.mkdir(sourceDir, { recursive: true });
  const sourceFilePath = `${sourceDir}/${options.sessionId}.jsonl`;
  await Deno.writeTextFile(sourceFilePath, "");

  const store = new PersistentSessionStateStore({
    katoDir: options.katoDir,
    now: () => new Date("2026-07-28T10:00:00.000Z"),
    makeSessionId: () => options.sessionId,
  });
  const metadata = await store.getOrCreateSessionMetadata({
    provider: "claude",
    providerSessionId: `provider-${options.sessionId}`,
    sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  const drafts: SessionTwinEventV1[] = options.texts.map((entry, index) => ({
    schemaVersion: 1,
    session: {
      provider: "claude",
      providerSessionId: metadata.providerSessionId,
      sessionId: metadata.sessionId,
    },
    seq: index + 1,
    kind: entry.kind,
    source: {
      providerEventType: "test",
      cursor: { kind: "byte-offset", value: 10 + index },
      emitIndex: index,
    },
    payload: { text: entry.text },
  }));
  const appendResult = await store.appendTwinEvents(metadata, drafts);
  assertEquals(appendResult.appended.length, options.texts.length);
  const refreshed = await store.getOrCreateSessionMetadata({
    provider: "claude",
    providerSessionId: metadata.providerSessionId,
    sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  return { store, metadata: refreshed };
}

Deno.test("readTwinEventsWindow pages by seq with hasOlder/hasNewer", async () => {
  await withTestTempDir("web-twin-window-", async (rootDir) => {
    const katoDir = `${rootDir}/.kato`;
    const { store, metadata } = await createTwinFixture({
      katoDir,
      sessionId: "sess-window",
      texts: [
        { kind: "user.message", text: "one" },
        { kind: "assistant.message", text: "two" },
        { kind: "user.message", text: "three" },
        { kind: "assistant.message", text: "four" },
        { kind: "user.message", text: "five" },
      ],
    });

    const newest = await store.readTwinEventsWindow(metadata, { limit: 2 });
    assertEquals(newest.events.map((event) => event.seq), [4, 5]);
    assertEquals(newest.hasOlder, true);
    assertEquals(newest.hasNewer, false);

    const middle = await store.readTwinEventsWindow(metadata, {
      beforeSeq: 4,
      limit: 2,
    });
    assertEquals(middle.events.map((event) => event.seq), [2, 3]);
    assertEquals(middle.hasOlder, true);
    assertEquals(middle.hasNewer, true);

    const forward = await store.readTwinEventsWindow(metadata, {
      afterSeq: 3,
      limit: 5,
    });
    assertEquals(forward.events.map((event) => event.seq), [4, 5]);
    assertEquals(forward.hasNewer, false);

    const everything = await store.readTwinEventsWindow(metadata, {});
    assertEquals(everything.events.length, 5);
    assertEquals(everything.hasOlder, false);
    assertEquals(everything.skippedLines, 0);
  });
});

Deno.test("readTwinEventsWindow counts malformed and duplicate lines as skipped", async () => {
  await withTestTempDir("web-twin-window-skip-", async (rootDir) => {
    const katoDir = `${rootDir}/.kato`;
    const { store, metadata } = await createTwinFixture({
      katoDir,
      sessionId: "sess-skip",
      texts: [
        { kind: "user.message", text: "hello" },
        { kind: "assistant.message", text: "world" },
      ],
    });
    const existing = await Deno.readTextFile(metadata.twinPath);
    const duplicate = existing.trim().split("\n")[0]!;
    await Deno.writeTextFile(
      metadata.twinPath,
      existing + "not-json\n" + duplicate + "\n",
    );

    const window = await store.readTwinEventsWindow(metadata, {});
    assertEquals(window.events.length, 2);
    assertEquals(window.skippedLines, 2);
    assertEquals(window.totalParsed, 2);
  });
});

Deno.test("loadSessionTwinViewData classifies events and redacts twin secrets", async () => {
  await withTestTempDir("web-twin-view-", async (rootDir) => {
    const katoDir = `${rootDir}/.kato`;
    const { metadata } = await createTwinFixture({
      katoDir,
      sessionId: "sess-view",
      texts: [
        {
          kind: "user.message",
          text: `my aws_access_key_id is ${PLANTED_AWS_KEY}`,
        },
        { kind: "assistant.thinking", text: "pondering" },
        { kind: "assistant.message", text: "done" },
      ],
    });

    const data = await loadSessionTwinViewData({
      sessionId: metadata.sessionId,
      katoDir,
    });
    assertEquals(data.status, "ready");
    assertEquals(data.header?.provider, "claude");
    assertEquals(data.events.length, 3);
    assertEquals(data.events[0]?.collapsed, false);
    assertEquals(data.events[1]?.collapsed, true);
    assertEquals(data.events[2]?.kind, "assistant.message");
    assert(
      !data.events[0]?.text.includes(PLANTED_AWS_KEY),
      `secret leaked: ${data.events[0]?.text}`,
    );

    const unknown = await loadSessionTwinViewData({
      sessionId: "sess-missing",
      katoDir,
    });
    assertEquals(unknown.status, "unknown-session");
  });
});
