import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import type { SessionTwinEventV1 } from "@kato/shared";
import {
  makeDefaultSessionCursor,
  PersistentSessionStateStore,
} from "../apps/daemon/src/mod.ts";

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

function makeTwinEvent(
  sessionId: string,
  emitIndex: number,
  text: string,
): SessionTwinEventV1 {
  return {
    schemaVersion: 1,
    session: {
      provider: "codex",
      providerSessionId: "session-1",
      sessionId,
    },
    seq: 1,
    kind: "assistant.message",
    source: {
      providerEventType: "response_item.message",
      cursor: { kind: "byte-offset", value: 10 },
      emitIndex,
    },
    payload: { text },
  };
}

Deno.test("PersistentSessionStateStore persists metadata and rebuilds daemon index", async () => {
  await withTempDir("session-state-store-", async (dir) => {
    const katoDir = join(dir, ".kato");
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-02-26T10:00:00.000Z"),
      makeSessionId: () => "session-uuid-12345678",
    });

    const metadata = await store.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-1",
      sourceFilePath: "/tmp/codex-session-1.jsonl",
      initialCursor: makeDefaultSessionCursor("codex"),
    });

    assertEquals(metadata.sessionKey, "codex:session-1");
    assertEquals(metadata.nextTwinSeq, 1);

    const append1 = await store.appendTwinEvents(metadata, [
      makeTwinEvent(metadata.sessionId, 0, "hello"),
      makeTwinEvent(metadata.sessionId, 1, "world"),
    ]);
    assertEquals(append1.appended.length, 2);
    assertEquals(append1.droppedAsDuplicate, 0);

    const append2 = await store.appendTwinEvents(metadata, [
      makeTwinEvent(metadata.sessionId, 0, "hello"),
      makeTwinEvent(metadata.sessionId, 1, "world"),
    ]);
    assertEquals(append2.appended.length, 0);
    assertEquals(append2.droppedAsDuplicate, 2);

    const latestMetadata = (await store.listSessionMetadata())[0];
    assertExists(latestMetadata);
    const twinEvents = await store.readTwinEvents(latestMetadata);
    assertEquals(twinEvents.map((event) => event.seq), [1, 2]);
    assertEquals(
      twinEvents.map((event) => (event.payload["text"] as string)),
      ["hello", "world"],
    );

    const controlPath = join(katoDir, "daemon-control.json");
    await Deno.writeTextFile(controlPath, "{ not-json");

    const coldStore = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-02-26T10:00:00.000Z"),
    });
    const rebuiltIndex = await coldStore.loadDaemonControlIndex();
    assertEquals(rebuiltIndex.sessions.length, 1);
    assertEquals(rebuiltIndex.sessions[0]?.sessionKey, "codex:session-1");
  });
});

Deno.test(
  "PersistentSessionStateStore only advances updatedAt for realtime twin appends",
  async () => {
    await withTempDir("session-state-store-updated-at-", async (dir) => {
      const katoDir = join(dir, ".kato");
      let nowIso = "2026-02-26T10:00:00.000Z";
      const store = new PersistentSessionStateStore({
        katoDir,
        now: () => new Date(nowIso),
        makeSessionId: () => "session-uuid-updatedat-1234",
      });

      const created = await store.getOrCreateSessionMetadata({
        provider: "codex",
        providerSessionId: "session-updated-at",
        sourceFilePath: "/tmp/codex-session-updated-at.jsonl",
        initialCursor: makeDefaultSessionCursor("codex"),
      });
      assertEquals(created.updatedAt, "2026-02-26T10:00:00.000Z");

      nowIso = "2026-02-26T10:05:00.000Z";
      const metadataOnlyUpdate = {
        ...created,
        ingestCursor: { kind: "byte-offset" as const, value: 123 },
      };
      await store.saveSessionMetadata(metadataOnlyUpdate);

      const afterMetadataSave = (await store.listSessionMetadata())
        .find((entry) => entry.sessionKey === created.sessionKey);
      assertExists(afterMetadataSave);
      assertEquals(afterMetadataSave.updatedAt, "2026-02-26T10:00:00.000Z");

      nowIso = "2026-02-26T10:10:00.000Z";
      const backfillAppend = await store.appendTwinEvents(
        afterMetadataSave,
        [makeTwinEvent(afterMetadataSave.sessionId, 0, "backfill-event")],
        { touchUpdatedAt: false },
      );
      assertEquals(backfillAppend.appended.length, 1);

      const afterBackfill = (await store.listSessionMetadata())
        .find((entry) => entry.sessionKey === created.sessionKey);
      assertExists(afterBackfill);
      assertEquals(afterBackfill.updatedAt, "2026-02-26T10:00:00.000Z");

      nowIso = "2026-02-26T10:15:00.000Z";
      const liveAppend = await store.appendTwinEvents(
        afterBackfill,
        [makeTwinEvent(afterBackfill.sessionId, 1, "live-event")],
        { touchUpdatedAt: true },
      );
      assertEquals(liveAppend.appended.length, 1);

      const afterLive = (await store.listSessionMetadata())
        .find((entry) => entry.sessionKey === created.sessionKey);
      assertExists(afterLive);
      assertEquals(afterLive.updatedAt, "2026-02-26T10:15:00.000Z");

      nowIso = "2026-02-26T10:20:00.000Z";
      const duplicateLiveAppend = await store.appendTwinEvents(
        afterLive,
        [makeTwinEvent(afterLive.sessionId, 1, "live-event")],
        { touchUpdatedAt: true },
      );
      assertEquals(duplicateLiveAppend.appended.length, 0);

      const afterDuplicate = (await store.listSessionMetadata())
        .find((entry) => entry.sessionKey === created.sessionKey);
      assertExists(afterDuplicate);
      assertEquals(afterDuplicate.updatedAt, "2026-02-26T10:15:00.000Z");
    });
  },
);
