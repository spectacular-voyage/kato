import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  createDefaultRuntimeConfig,
  PersistentSessionStateStore,
  RuntimeConfigFileStore,
} from "../apps/runtime/src/mod.ts";
import { loadMaintenanceTwinsData } from "../apps/web/src/loaders/maintenance_twins.ts";
import { loadSessionsPageData } from "../apps/web/src/loaders/sessions.ts";
import { ingestPersistedSession } from "../apps/web/src/session_ingestion.ts";
import { withTestTempDir } from "./test_temp.ts";

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const CLAUDE_FIXTURE = join(THIS_DIR, "fixtures", "claude-session.jsonl");

async function copyFixtureWithMtime(
  targetPath: string,
  isoTimestamp: string,
): Promise<void> {
  await Deno.copyFile(CLAUDE_FIXTURE, targetPath);
  const timestamp = new Date(isoTimestamp);
  await Deno.utime(targetPath, timestamp, timestamp);
}

async function initializeSessionIngestionFixture(
  homeDir: string,
): Promise<{ katoDir: string; runtimeDir: string; sharedDir: string }> {
  const katoDir = join(homeDir, ".kato");
  const runtimeDir = join(katoDir, "daemon");
  const sharedDir = join(katoDir, "shared");
  await Deno.mkdir(runtimeDir, { recursive: true });
  await Deno.mkdir(sharedDir, { recursive: true });
  await Deno.writeTextFile(
    join(sharedDir, "status.json"),
    JSON.stringify({
      schemaVersion: 2,
      generatedAt: "2026-03-11T10:00:00.000Z",
      heartbeatAt: "2026-03-11T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: {
        activeRecordings: 0,
        destinations: 0,
      },
      sessions: [],
    }),
  );

  const configStore = new RuntimeConfigFileStore(
    join(runtimeDir, "kato-daemon-config.yaml"),
  );
  await configStore.ensureInitialized(
    createDefaultRuntimeConfig({
      runtimeDir,
      katoDir,
      globalAutoGenerateTwins: false,
      providerAutoGenerateTwins: {
        claude: false,
        codex: false,
        gemini: false,
      },
    }),
  );

  return { katoDir, runtimeDir, sharedDir };
}

Deno.test("ingestPersistedSession moves a session from not ingested to idle and supports continuation", async () => {
  await withTestTempDir("web-session-ingestion-", async (homeDir) => {
    const { katoDir } = await initializeSessionIngestionFixture(homeDir);
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-11T10:00:00.000Z"),
      makeSessionId: () => "sess-kato-001",
    });
    const sessionFilePath = join(homeDir, "provider-session-1.jsonl");
    await copyFixtureWithMtime(
      sessionFilePath,
      "2026-03-11T10:00:00.000Z",
    );
    await store.getOrCreateSessionMetadata({
      provider: "claude",
      providerSessionId: "provider-session-1",
      sourceFilePath: sessionFilePath,
      initialCursor: { kind: "byte-offset", value: 0 },
    });

    const before = await loadSessionsPageData({ katoDir });
    const beforeTwins = await loadMaintenanceTwinsData({ katoDir });
    assertEquals(before.rows.length, 1);
    assertEquals(before.rows[0]?.state, "inactive");
    assertEquals(beforeTwins.rows[0]?.twinState, "absent");
    assertEquals(beforeTwins.rows[0]?.twinAction, "create");

    const result = await ingestPersistedSession({
      sessionId: "sess-kato-001",
      katoDir,
      now: () => new Date("2026-03-11T10:05:00.000Z"),
    });
    assertExists(result);
    assertEquals(result.provider, "claude");
    assertEquals(result.sessionShortId, "sess-kat");
    assertEquals(result.parsedEvents > 0, true);
    assertEquals(result.appendedTwinEvents > 0, true);

    const after = await loadSessionsPageData({ katoDir });
    const afterTwins = await loadMaintenanceTwinsData({ katoDir });
    assertEquals(after.rows.length, 1);
    assertEquals(after.rows[0]?.state, "stale");
    assertEquals(after.staleSessionCount, 1);
    assertEquals(after.inactiveSessionCount, 0);
    assertEquals(afterTwins.rows[0]?.twinState, "current");
    assertEquals(afterTwins.rows[0]?.twinAction, "none");

    const reloaded = (await store.listSessionMetadata())[0];
    assertExists(reloaded);
    assertEquals(reloaded.nextTwinSeq > 1, true);
    assertEquals(typeof reloaded.ingestionActivatedAt, "string");

    const continuedAt = new Date("2026-03-11T10:10:00.000Z");
    await Deno.utime(sessionFilePath, continuedAt, continuedAt);

    const afterSourceUpdate = await loadSessionsPageData({ katoDir });
    const afterSourceUpdateTwins = await loadMaintenanceTwinsData({
      katoDir,
    });
    assertEquals(afterSourceUpdate.rows.length, 1);
    assertEquals(afterSourceUpdate.rows[0]?.state, "stale");
    assertEquals(afterSourceUpdate.staleSessionCount, 1);
    assertEquals(afterSourceUpdate.inactiveSessionCount, 0);
    assertEquals(afterSourceUpdateTwins.rows[0]?.twinState, "behind");
    assertEquals(afterSourceUpdateTwins.rows[0]?.twinAction, "update");
  });
});

Deno.test("ingestPersistedSession includes sidechain events for Claude subagent sources", async () => {
  await withTestTempDir("web-session-ingestion-subagent-", async (homeDir) => {
    const { katoDir } = await initializeSessionIngestionFixture(homeDir);
    const subagentDir = join(
      homeDir,
      "project",
      "parent-session",
      "subagents",
    );
    await Deno.mkdir(subagentDir, { recursive: true });
    const sessionFilePath = join(subagentDir, "agent-child.jsonl");
    await Deno.writeTextFile(
      sessionFilePath,
      [
        JSON.stringify({
          type: "user",
          uuid: "subagent-user",
          isSidechain: true,
          sessionId: "parent-session",
          timestamp: "2026-03-11T10:00:00.000Z",
          message: {
            role: "user",
            content: "summarize the workflow",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "subagent-assistant",
          parentUuid: "subagent-user",
          isSidechain: true,
          sessionId: "parent-session",
          timestamp: "2026-03-11T10:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Summary complete." }],
          },
        }),
      ].join("\n") + "\n",
    );
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-11T10:00:00.000Z"),
      makeSessionId: () => "sess-kato-subagent",
    });
    await store.getOrCreateSessionMetadata({
      provider: "claude",
      providerSessionId: "agent-child",
      sourceFilePath: sessionFilePath,
      initialCursor: { kind: "byte-offset", value: 0 },
    });

    const result = await ingestPersistedSession({
      sessionId: "sess-kato-subagent",
      katoDir,
      now: () => new Date("2026-03-11T10:05:00.000Z"),
    });

    assertEquals(result.parsedEvents, 2);
    assertEquals(result.appendedTwinEvents, 2);
  });
});

Deno.test("loadSessionsPageData keeps background twin history inactive until ingestion is explicitly activated", async () => {
  await withTestTempDir(
    "web-session-ingestion-background-state-",
    async (homeDir) => {
      const { katoDir } = await initializeSessionIngestionFixture(homeDir);
      const store = new PersistentSessionStateStore({
        katoDir,
        now: () => new Date("2026-03-11T10:00:00.000Z"),
        makeSessionId: () => "sess-kato-002",
      });
      const sessionFilePath = join(homeDir, "provider-session-2.jsonl");
      await copyFixtureWithMtime(
        sessionFilePath,
        "2026-03-11T10:00:00.000Z",
      );
      const metadata = await store.getOrCreateSessionMetadata({
        provider: "claude",
        providerSessionId: "provider-session-2",
        sourceFilePath: sessionFilePath,
        initialCursor: { kind: "byte-offset", value: 0 },
      });
      const sourceMtimeMs = (await Deno.stat(sessionFilePath)).mtime
        ?.getTime();
      metadata.nextTwinSeq = 3;
      metadata.commandCursor = 2;
      metadata.lastObservedMtimeMs = sourceMtimeMs;
      await store.saveSessionMetadata(metadata, { touchUpdatedAt: true });

      const page = await loadSessionsPageData({ katoDir });
      const twins = await loadMaintenanceTwinsData({ katoDir });
      assertEquals(page.rows.length, 1);
      assertEquals(page.rows[0]?.state, "inactive");
      assertEquals(page.staleSessionCount, 0);
      assertEquals(page.inactiveSessionCount, 1);
      assertEquals(twins.rows[0]?.twinState, "absent");
      assertEquals(twins.rows[0]?.twinAction, "create");
    },
  );
});

Deno.test("ingestPersistedSession clamps byte-offset cursors when the source file has shrunk", async () => {
  await withTestTempDir("web-session-ingestion-clamp-", async (homeDir) => {
    const { katoDir } = await initializeSessionIngestionFixture(homeDir);
    const sessionFilePath = join(homeDir, "provider-session-clamped.jsonl");
    await Deno.writeTextFile(sessionFilePath, "");
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-11T10:00:00.000Z"),
      makeSessionId: () => "sess-kato-003",
    });
    const metadata = await store.getOrCreateSessionMetadata({
      provider: "claude",
      providerSessionId: "provider-session-3",
      sourceFilePath: sessionFilePath,
      initialCursor: { kind: "byte-offset", value: 42 },
    });
    metadata.ingestCursor = { kind: "byte-offset", value: 42 };
    await store.saveSessionMetadata(metadata);

    const result = await ingestPersistedSession({
      sessionId: "sess-kato-003",
      katoDir,
      now: () => new Date("2026-03-11T10:05:00.000Z"),
    });

    assertEquals(result.parsedEvents, 0);
    const reloaded = (await store.listSessionMetadata())[0];
    assertExists(reloaded);
    assertEquals(reloaded.ingestCursor, {
      kind: "byte-offset",
      value: 0,
    });
  });
});

Deno.test("ingestPersistedSession recreates a missing twin from source start instead of resuming from ingestCursor", async () => {
  await withTestTempDir("web-session-twin-recreate-", async (homeDir) => {
    const { katoDir } = await initializeSessionIngestionFixture(homeDir);
    const sessionFilePath = join(
      homeDir,
      "provider-session-recreate.jsonl",
    );
    await copyFixtureWithMtime(
      sessionFilePath,
      "2026-03-11T10:00:00.000Z",
    );
    const fileSize = (await Deno.stat(sessionFilePath)).size;
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-11T10:00:00.000Z"),
      makeSessionId: () => "sess-kato-004",
    });
    const metadata = await store.getOrCreateSessionMetadata({
      provider: "claude",
      providerSessionId: "provider-session-4",
      sourceFilePath: sessionFilePath,
      initialCursor: { kind: "byte-offset", value: fileSize },
    });
    metadata.ingestCursor = { kind: "byte-offset", value: fileSize };
    metadata.nextTwinSeq = 5;
    metadata.recentFingerprints = ["stale-fingerprint"];
    await store.saveSessionMetadata(metadata);

    const result = await ingestPersistedSession({
      sessionId: "sess-kato-004",
      katoDir,
      now: () => new Date("2026-03-11T10:05:00.000Z"),
    });

    assertEquals(result.twinAction, "create");
    assertEquals(result.parsedEvents > 0, true);
    assertEquals(result.appendedTwinEvents > 0, true);

    const reloaded = (await store.listSessionMetadata())[0];
    assertExists(reloaded);
    const twinEvents = await store.readTwinEvents(reloaded, 1);
    assertEquals(twinEvents.length > 0, true);
    assertEquals(twinEvents[0]?.seq, 1);
  });
});

Deno.test("ingestPersistedSession keeps existing activation when an up-to-date twin has no new events", async () => {
  await withTestTempDir("web-session-ingestion-noop-update-", async (
    homeDir,
  ) => {
    const { katoDir } = await initializeSessionIngestionFixture(homeDir);
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-11T10:00:00.000Z"),
      makeSessionId: () => "sess-kato-005",
    });
    const sessionFilePath = join(homeDir, "provider-session-noop.jsonl");
    await copyFixtureWithMtime(
      sessionFilePath,
      "2026-03-11T10:00:00.000Z",
    );
    await store.getOrCreateSessionMetadata({
      provider: "claude",
      providerSessionId: "provider-session-5",
      sourceFilePath: sessionFilePath,
      initialCursor: { kind: "byte-offset", value: 0 },
    });

    const firstResult = await ingestPersistedSession({
      sessionId: "sess-kato-005",
      katoDir,
      now: () => new Date("2026-03-11T10:05:00.000Z"),
    });
    assertEquals(firstResult.twinAction, "create");
    assertEquals(firstResult.appendedTwinEvents > 0, true);

    const afterFirstIngest = (await store.listSessionMetadata())[0];
    assertExists(afterFirstIngest);
    const firstActivatedAt = afterFirstIngest.ingestionActivatedAt;
    const firstNextTwinSeq = afterFirstIngest.nextTwinSeq;
    const firstCursor = afterFirstIngest.ingestCursor;

    const secondResult = await ingestPersistedSession({
      sessionId: "sess-kato-005",
      katoDir,
      now: () => new Date("2026-03-11T10:06:00.000Z"),
    });

    assertEquals(secondResult.twinAction, "update");
    assertEquals(secondResult.parsedEvents, 0);
    assertEquals(secondResult.appendedTwinEvents, 0);
    assertEquals(secondResult.droppedAsDuplicate, 0);

    const reloaded = (await store.listSessionMetadata())[0];
    assertExists(reloaded);
    assertEquals(reloaded.ingestionActivatedAt, firstActivatedAt);
    assertEquals(reloaded.nextTwinSeq, firstNextTwinSeq);
    assertEquals(reloaded.ingestCursor, firstCursor);
  });
});

Deno.test("ingestPersistedSession rejects opaque cursors when update twins would need resume", async () => {
  await withTestTempDir("web-session-ingestion-opaque-", async (
    homeDir,
  ) => {
    const { katoDir } = await initializeSessionIngestionFixture(homeDir);
    const store = new PersistentSessionStateStore({
      katoDir,
      now: () => new Date("2026-03-11T10:00:00.000Z"),
      makeSessionId: () => "sess-kato-006",
    });
    const sessionFilePath = join(homeDir, "provider-session-opaque.jsonl");
    await copyFixtureWithMtime(
      sessionFilePath,
      "2026-03-11T10:00:00.000Z",
    );
    const metadata = await store.getOrCreateSessionMetadata({
      provider: "claude",
      providerSessionId: "provider-session-6",
      sourceFilePath: sessionFilePath,
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    metadata.ingestCursor = { kind: "opaque", value: "resume-token" };
    metadata.nextTwinSeq = 2;
    await store.saveSessionMetadata(metadata);
    await Deno.writeTextFile(metadata.twinPath, "");

    await assertRejects(
      () =>
        ingestPersistedSession({
          sessionId: "sess-kato-006",
          katoDir,
          now: () => new Date("2026-03-11T10:05:00.000Z"),
        }),
      Error,
      "Opaque ingestion cursors cannot be resumed manually",
    );
  });
});
