import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import type { SessionTwinEventV1 } from "@kato/shared";
import {
  makeDefaultSessionCursor,
  PersistentSessionStateStore,
} from "../apps/daemon/src/mod.ts";
import { resolveTestTempPath, withTestTempDir } from "./test_temp.ts";

const SESSION_STATE_SOURCE_PATH = resolveTestTempPath(
  "session-state-store",
  "codex-session-1.jsonl",
);
const SESSION_STATE_LEGACY_SOURCE_PATH = resolveTestTempPath(
  "session-state-store",
  "codex-legacy-session-1.jsonl",
);
const SESSION_STATE_INDEX_HEALING_SOURCE_PATH = resolveTestTempPath(
  "session-state-store",
  "codex-index-healing-session-1.jsonl",
);
const SESSION_STATE_UPDATED_AT_SOURCE_PATH = resolveTestTempPath(
  "session-state-store",
  "codex-session-updated-at.jsonl",
);
const SESSION_STATE_WORKSPACE_OUTPUT_SOURCE_PATH = resolveTestTempPath(
  "session-state-store",
  "codex-session-workspace-output.jsonl",
);

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
      sourceFilePath: SESSION_STATE_SOURCE_PATH,
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
      sourceFilePath: SESSION_STATE_SOURCE_PATH,
      initialCursor: makeDefaultSessionCursor("codex"),
    });
    assertEquals(metadata.twinPath, location.twinPath);
  });
});

Deno.test(
  "PersistentSessionStateStore creates and backfills parent relationships without touching session activity",
  async () => {
    await withTempDir("session-state-store-parent-", async (dir) => {
      const katoDir = join(dir, ".kato");
      let nextSessionId = 0;
      const store = new PersistentSessionStateStore({
        katoDir,
        now: () => new Date("2026-07-10T20:00:00.000Z"),
        makeSessionId: () => `session-child-kato-id-${++nextSessionId}`,
      });

      const createdWithParent = await store.getOrCreateSessionMetadata({
        provider: "codex",
        providerSessionId: "provider-child-new",
        parentProviderSessionId: "  provider-parent  ",
        sourceFilePath: join(dir, "child-new.jsonl"),
        initialCursor: { kind: "byte-offset", value: 7 },
      });
      assertEquals(
        createdWithParent.parentProviderSessionId,
        "provider-parent",
      );

      const createdWithBlankParent = await store.getOrCreateSessionMetadata({
        provider: "codex",
        providerSessionId: "provider-child-blank-parent",
        parentProviderSessionId: "   ",
        sourceFilePath: join(dir, "child-blank-parent.jsonl"),
        initialCursor: { kind: "byte-offset", value: 11 },
      });
      assertEquals(createdWithBlankParent.parentProviderSessionId, undefined);
      const initiallyReloaded = await new PersistentSessionStateStore({
        katoDir,
      }).listSessionMetadata();
      assertEquals(
        initiallyReloaded.find((metadata) =>
          metadata.providerSessionId === "provider-child-new"
        )?.parentProviderSessionId,
        "provider-parent",
      );
      const reloadedBlankParent = initiallyReloaded.find((metadata) =>
        metadata.providerSessionId === "provider-child-blank-parent"
      );
      assertExists(reloadedBlankParent);
      assertEquals(reloadedBlankParent.parentProviderSessionId, undefined);

      const legacy = await store.getOrCreateSessionMetadata({
        provider: "codex",
        providerSessionId: "provider-child-legacy",
        sourceFilePath: join(dir, "child-legacy.jsonl"),
        initialCursor: { kind: "byte-offset", value: 17 },
      });
      legacy.nextTwinSeq = 9;
      legacy.recentFingerprints = ["fingerprint-1"];
      await store.saveSessionMetadata(legacy);

      const result = await store.reconcileSessionParentProviderSessionId({
        provider: "codex",
        providerSessionId: "provider-child-legacy",
        sourceFilePath: legacy.sourceFilePath,
        parentProviderSessionId: "provider-parent",
      });
      assertEquals(result, "updated");

      const reloaded = (await store.listSessionMetadata()).find((metadata) =>
        metadata.providerSessionId === "provider-child-legacy"
      );
      assertExists(reloaded);
      assertEquals(reloaded.parentProviderSessionId, "provider-parent");
      assertEquals(reloaded.sessionId, legacy.sessionId);
      assertEquals(reloaded.updatedAt, legacy.updatedAt);
      assertEquals(reloaded.ingestCursor, legacy.ingestCursor);
      assertEquals(reloaded.nextTwinSeq, 9);
      assertEquals(reloaded.recentFingerprints, ["fingerprint-1"]);

      assertEquals(
        await store.reconcileSessionParentProviderSessionId({
          provider: "codex",
          providerSessionId: "provider-child-legacy",
          sourceFilePath: legacy.sourceFilePath,
          parentProviderSessionId: "provider-parent",
        }),
        "unchanged",
      );
      assertEquals(
        await store.reconcileSessionParentProviderSessionId({
          provider: "codex",
          providerSessionId: "provider-child-legacy",
          sourceFilePath: legacy.sourceFilePath,
          parentProviderSessionId: "  provider-parent  ",
        }),
        "unchanged",
      );
      assertEquals(
        await store.reconcileSessionParentProviderSessionId({
          provider: "codex",
          providerSessionId: "provider-child-legacy",
          sourceFilePath: legacy.sourceFilePath,
          parentProviderSessionId: "   ",
        }),
        "unchanged",
      );
      assertEquals(
        (await store.listSessionMetadata()).find((metadata) =>
          metadata.providerSessionId === "provider-child-legacy"
        )?.parentProviderSessionId,
        "provider-parent",
      );
      assertEquals(
        await store.reconcileSessionParentProviderSessionId({
          provider: "codex",
          providerSessionId: "provider-child-legacy",
          sourceFilePath: legacy.sourceFilePath,
          parentProviderSessionId: "  provider-parent-next  ",
        }),
        "updated",
      );
      assertEquals(
        (await store.listSessionMetadata()).find((metadata) =>
          metadata.providerSessionId === "provider-child-legacy"
        )?.parentProviderSessionId,
        "provider-parent-next",
      );
      assertEquals(
        await store.reconcileSessionParentProviderSessionId({
          provider: "codex",
          providerSessionId: "missing-child",
          sourceFilePath: join(dir, "missing-child.jsonl"),
          parentProviderSessionId: "provider-parent",
        }),
        "missing",
      );
    });
  },
);

Deno.test({
  name: "PersistentSessionStateStore migrates legacy colon storage keys",
  ignore: Deno.build.os === "windows",
  fn: async () => {
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
        sourceFilePath: SESSION_STATE_LEGACY_SOURCE_PATH,
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
      const legacyTwinPath = join(
        sessionsDir,
        `${legacyStorageKey}.twin.jsonl`,
      );

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
      const expectedTwinPayload = await Deno.readTextFile(legacyTwinPath);

      const restartedStore = new PersistentSessionStateStore({
        katoDir,
        now: () => new Date("2026-03-01T10:05:00.000Z"),
      });
      const restored = await restartedStore.getOrCreateSessionMetadata({
        ...identity,
        sourceFilePath: SESSION_STATE_LEGACY_SOURCE_PATH,
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
      const migratedTwinPayload = await Deno.readTextFile(
        canonicalLocation.twinPath,
      );
      assertEquals(migratedTwinPayload, expectedTwinPayload);

      const index = await restartedStore.loadDaemonControlIndex();
      const indexEntry = index.sessions.find((entry) =>
        entry.sessionKey === "codex:legacy-session-1"
      );
      assertExists(indexEntry);
      assertEquals(indexEntry.metadataPath, canonicalLocation.metadataPath);
      assertEquals(indexEntry.twinPath, canonicalLocation.twinPath);
    });
  },
});

Deno.test(
  "PersistentSessionStateStore heals stale daemon index entries for canonical metadata",
  async () => {
    await withTempDir("session-state-store-index-healing-", async (dir) => {
      const katoDir = join(dir, ".kato");
      const identity = {
        provider: "codex",
        providerSessionId: "index-healing-session-1",
      } as const;
      const initialStore = new PersistentSessionStateStore({
        katoDir,
        now: () => new Date("2026-03-01T11:00:00.000Z"),
        makeSessionId: () => "session-uuid-index-healing-1234",
      });
      const created = await initialStore.getOrCreateSessionMetadata({
        ...identity,
        sourceFilePath: SESSION_STATE_INDEX_HEALING_SOURCE_PATH,
        initialCursor: makeDefaultSessionCursor("codex"),
      });
      const canonicalLocation = initialStore.resolveLocation(identity);
      const sessionsDir = dirname(canonicalLocation.metadataPath);
      const daemonControlPath = join(katoDir, "daemon-control.json");
      await Deno.writeTextFile(
        daemonControlPath,
        `${
          JSON.stringify(
            {
              schemaVersion: 1,
              updatedAt: "2026-03-01T11:01:00.000Z",
              sessions: [
                {
                  sessionKey: created.sessionKey,
                  provider: created.provider,
                  providerSessionId: created.providerSessionId,
                  sessionId: created.sessionId,
                  sessionShortId: created.sessionId.slice(0, 8),
                  metadataPath: join(sessionsDir, "stale.meta.json"),
                  twinPath: join(sessionsDir, "stale.twin.jsonl"),
                  updatedAt: created.updatedAt,
                },
              ],
            },
            null,
            2,
          )
        }\n`,
      );

      const restartedStore = new PersistentSessionStateStore({
        katoDir,
        now: () => new Date("2026-03-01T11:05:00.000Z"),
      });
      const restored = await restartedStore.getOrCreateSessionMetadata({
        ...identity,
        sourceFilePath: SESSION_STATE_INDEX_HEALING_SOURCE_PATH,
        initialCursor: makeDefaultSessionCursor("codex"),
      });

      assertEquals(restored.twinPath, canonicalLocation.twinPath);
      const healedIndex = await restartedStore.loadDaemonControlIndex();
      const healedEntry = healedIndex.sessions.find((entry) =>
        entry.sessionKey === created.sessionKey
      );
      assertExists(healedEntry);
      assertEquals(healedEntry.metadataPath, canonicalLocation.metadataPath);
      assertEquals(healedEntry.twinPath, canonicalLocation.twinPath);
    });
  },
);

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
        sourceFilePath: SESSION_STATE_UPDATED_AT_SOURCE_PATH,
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
      sourceFilePath: SESSION_STATE_WORKSPACE_OUTPUT_SOURCE_PATH,
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
        writerRelativizeLocalLinks: false,
      },
      activeRecordingCycleId: "cycle-1",
      writeCursor: 42,
      createdAt: "2026-02-28T10:00:00.000Z",
      recordingCycles: [{
        recordingCycleId: "cycle-1",
        startedCursor: 5,
        startedAt: "2026-02-28T10:00:00.000Z",
        lastWriteAt: "2026-02-28T10:03:00.000Z",
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
    assertEquals(
      output.writerFeatureFlags.writerRelativizeLocalLinks,
      false,
    );
    assertEquals(output.activeRecordingCycleId, "cycle-1");
    assertEquals(output.recordingCycles.length, 1);
    assertEquals(output.recordingCycles[0]?.startedCursor, 5);
    assertEquals(
      output.recordingCycles[0]?.lastWriteAt,
      "2026-02-28T10:03:00.000Z",
    );
  });
});

Deno.test("PersistentSessionStateStore resetSessionTwinPersistence clears twin-only state", async () => {
  await withTempDir("session-state-store-reset-twin-", async (dir) => {
    const katoDir = join(dir, ".kato");
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-02T10:00:00.000Z"),
      makeSessionId: () => "session-uuid-reset-twin-1234",
    });

    const created = await store.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-reset-twin",
      sourceFilePath: SESSION_STATE_WORKSPACE_OUTPUT_SOURCE_PATH,
      initialCursor: makeDefaultSessionCursor("codex"),
    });
    const updated = structuredClone(created);
    updated.ingestionActivatedAt = "2026-03-02T10:05:00.000Z";
    updated.commandCursor = 11;
    updated.lastObservedMtimeMs = 123456789;
    updated.workspaceOutputs = [{
      workspaceId: "workspace-reset",
      workspaceAliasSnapshot: "Reset",
      desiredState: "on",
      currentDestination: {
        kind: "workspace-relative",
        relativePathFromWorkspaceRoot: "notes/reset.md",
      },
      currentResolvedPath: `${dir}/workspace/notes/reset.md`,
      sourceConfigPath: `${dir}/workspace/.kato-workspace-config.yaml`,
      workspaceRootSnapshot: `${dir}/workspace`,
      resolvedDefaultOutputDir: `${dir}/workspace/notes`,
      filenameTemplate: "{provider}.md",
      writerFeatureFlags: {
        writerIncludeCommentary: true,
        writerIncludeThinking: false,
        writerIncludeToolCalls: true,
        writerItalicizeUserMessages: false,
      },
      activeRecordingCycleId: "cycle-reset",
      writeCursor: 7,
      recordingCycles: [{
        recordingCycleId: "cycle-reset",
        startedCursor: 3,
      }],
    }];
    await store.saveSessionMetadata(updated);

    const appendResult = await store.appendTwinEvents(updated, [
      makeTwinEvent(updated.sessionId, 0, "hello"),
      {
        ...makeTwinEvent(updated.sessionId, 1, "user hello"),
        kind: "user.message",
        payload: { text: "user hello" },
      },
    ]);
    assertEquals(appendResult.appended.length, 2);

    const beforeReset = (await store.listSessionMetadata())[0];
    assertExists(beforeReset);
    assertEquals(beforeReset.nextTwinSeq, 3);
    assertEquals(beforeReset.recentFingerprints.length > 0, true);
    await Deno.stat(beforeReset.twinPath);

    const reset = await store.resetSessionTwinPersistence(beforeReset, {
      deleteTwinFile: true,
    });
    assertEquals(reset.nextTwinSeq, 1);
    assertEquals(reset.recentFingerprints, []);
    assertEquals(reset.ingestionActivatedAt, undefined);
    assertEquals(reset.commandCursor, 11);
    assertEquals(reset.lastObservedMtimeMs, 123456789);
    assertEquals(reset.workspaceOutputs?.length, 1);

    await assertRejects(
      () => Deno.stat(beforeReset.twinPath),
      Deno.errors.NotFound,
    );

    const reloaded = (await store.listSessionMetadata())[0];
    assertExists(reloaded);
    assertEquals(reloaded.nextTwinSeq, 1);
    assertEquals(reloaded.recentFingerprints, []);
    assertEquals(reloaded.ingestionActivatedAt, undefined);
    assertEquals(reloaded.commandCursor, 11);
    assertEquals(reloaded.workspaceOutputs?.length, 1);
  });
});
