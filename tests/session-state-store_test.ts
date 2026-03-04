import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import type { SessionTwinEventV1 } from "@kato/shared";
import {
  makeDefaultSessionCursor,
  PersistentSessionStateStore,
} from "../apps/daemon/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

async function withTempDir(
  prefix: string,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  await withTestTempDir(prefix, run);
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

Deno.test("PersistentSessionStateStore uses Windows-safe storage keys", async () => {
  await withTempDir("session-state-store-windows-safe-", async (dir) => {
    const katoDir = join(dir, ".kato");
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-01T10:00:00.000Z"),
      makeSessionId: () => "session-uuid-windows-safe-1234",
    });

    const location = store.resolveLocation({
      provider: "codex",
      providerSessionId: "session-1",
    });
    assertEquals(basename(location.metadataPath).includes(":"), false);
    assertEquals(basename(location.twinPath).includes(":"), false);
    assertEquals(basename(location.metadataPath).startsWith("5_codex_"), true);
    assertEquals(basename(location.twinPath).startsWith("5_codex_"), true);

    const metadata = await store.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-1",
      sourceFilePath: "/tmp/codex-session-1.jsonl",
      initialCursor: makeDefaultSessionCursor("codex"),
    });
    assertEquals(metadata.twinPath, location.twinPath);
  });
});

Deno.test("PersistentSessionStateStore migrates legacy colon storage keys", async () => {
  await withTempDir("session-state-store-legacy-key-", async (dir) => {
    const katoDir = join(dir, ".kato");
    const identity = {
      provider: "codex",
      providerSessionId: "legacy-session-1",
    } as const;

    const initialStore = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-01T10:00:00.000Z"),
      makeSessionId: () => "session-uuid-legacy-key-1234",
    });
    const created = await initialStore.getOrCreateSessionMetadata({
      ...identity,
      sourceFilePath: "/tmp/codex-legacy-session-1.jsonl",
      initialCursor: makeDefaultSessionCursor("codex"),
    });
    await initialStore.appendTwinEvents(created, [
      makeTwinEvent(created.sessionId, 0, "hello from legacy"),
    ]);

    const canonicalLocation = initialStore.resolveLocation(identity);
    const sessionsDir = dirname(canonicalLocation.metadataPath);
    const legacyStorageKey = `${encodeURIComponent(identity.provider)}:${
      encodeURIComponent(identity.providerSessionId)
    }`;
    const legacyMetadataPath = join(
      sessionsDir,
      `${legacyStorageKey}.meta.json`,
    );
    const legacyTwinPath = join(sessionsDir, `${legacyStorageKey}.twin.jsonl`);

    const currentMetadata = JSON.parse(
      await Deno.readTextFile(canonicalLocation.metadataPath),
    ) as {
      twinPath: string;
      [key: string]: unknown;
    };
    await Deno.rename(canonicalLocation.metadataPath, legacyMetadataPath);
    await Deno.rename(canonicalLocation.twinPath, legacyTwinPath);
    await Deno.writeTextFile(
      legacyMetadataPath,
      `${
        JSON.stringify(
          {
            ...currentMetadata,
            twinPath: legacyTwinPath,
          },
          null,
          2,
        )
      }\n`,
    );

    const restartedStore = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-01T10:05:00.000Z"),
    });
    const restored = await restartedStore.getOrCreateSessionMetadata({
      ...identity,
      sourceFilePath: "/tmp/codex-legacy-session-1.jsonl",
      initialCursor: makeDefaultSessionCursor("codex"),
    });

    assertEquals(restored.twinPath, canonicalLocation.twinPath);
    await Deno.stat(canonicalLocation.metadataPath);
    await Deno.stat(canonicalLocation.twinPath);
    await assertRejects(
      () => Deno.stat(legacyMetadataPath),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.stat(legacyTwinPath),
      Deno.errors.NotFound,
    );

    const index = await restartedStore.loadDaemonControlIndex();
    const indexEntry = index.sessions.find((entry) =>
      entry.sessionKey === "codex:legacy-session-1"
    );
    assertExists(indexEntry);
    assertEquals(indexEntry.metadataPath, canonicalLocation.metadataPath);
    assertEquals(indexEntry.twinPath, canonicalLocation.twinPath);
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

Deno.test("PersistentSessionStateStore persists workspace outputs", async () => {
  await withTempDir("session-state-store-workspace-output-", async (dir) => {
    const katoDir = join(dir, ".kato");
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-02-28T10:00:00.000Z"),
      makeSessionId: () => "session-uuid-workspace-output-1234",
    });

    const created = await store.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-workspace-output",
      sourceFilePath: "/tmp/codex-session-workspace-output.jsonl",
      initialCursor: makeDefaultSessionCursor("codex"),
    });

    const updated = structuredClone(created);
    updated.workspaceOutputs = [{
      workspaceId: "workspace-my-proj",
      workspaceAliasSnapshot: "My.Proj",
      desiredState: "on",
      currentDestination: {
        kind: "workspace-relative",
        relativePathFromWorkspaceRoot: "notes/session.md",
      },
      currentResolvedPath: `${dir}/workspace/notes/session.md`,
      sourceConfigPath: `${dir}/workspace/.kato-workspace-config.yaml`,
      workspaceRootSnapshot: `${dir}/workspace`,
      resolvedDefaultOutputDir: `${dir}/workspace/notes`,
      filenameTemplate: "{provider}-{sessionShortId}.md",
      writerFeatureFlags: {
        writerIncludeCommentary: false,
        writerIncludeThinking: true,
        writerIncludeToolCalls: false,
        writerItalicizeUserMessages: true,
      },
      activeRecordingCycleId: "cycle-1",
      writeCursor: 42,
      createdAt: "2026-02-28T10:00:00.000Z",
      recordingCycles: [{
        recordingCycleId: "cycle-1",
        startedCursor: 5,
        startedAt: "2026-02-28T10:00:00.000Z",
        startedBySeq: 3,
      }],
    }];

    await store.saveSessionMetadata(updated, { touchUpdatedAt: true });

    const reloadedStore = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-02-28T10:05:00.000Z"),
    });
    const reloaded = (await reloadedStore.listSessionMetadata())[0];
    assertExists(reloaded);
    assertExists(reloaded.workspaceOutputs);
    assertEquals(reloaded.workspaceOutputs.length, 1);
    const output = reloaded.workspaceOutputs[0];
    assertEquals(
      output.workspaceRootSnapshot,
      `${dir}/workspace`,
    );
    assertEquals(
      output.currentDestination.kind,
      "workspace-relative",
    );
    assertEquals(
      output.currentDestination.relativePathFromWorkspaceRoot,
      "notes/session.md",
    );
    assertEquals(
      output.writerFeatureFlags.writerIncludeCommentary,
      false,
    );
    assertEquals(
      output.writerFeatureFlags.writerIncludeThinking,
      true,
    );
    assertEquals(output.activeRecordingCycleId, "cycle-1");
    assertEquals(output.recordingCycles.length, 1);
    assertEquals(output.recordingCycles[0]?.startedCursor, 5);
  });
});
