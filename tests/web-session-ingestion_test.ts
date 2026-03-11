import { assertEquals, assertExists } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  createDefaultRuntimeConfig,
  PersistentSessionStateStore,
  RuntimeConfigFileStore,
} from "../apps/runtime/src/mod.ts";
import { loadMaintenanceTwinsData } from "../apps/web/src/loaders/maintenance_twins.ts";
import { loadSessionsPageData } from "../apps/web/src/loaders/sessions.ts";
import { ingestPersistedSession } from "../apps/web/src/session_ingestion.ts";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
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

Deno.test("ingestPersistedSession moves a session from not ingested to idle and supports continuation", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-session-ingestion-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

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
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("loadSessionsPageData keeps background twin history inactive until ingestion is explicitly activated", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir(
        "web-session-ingestion-background-state-",
        async (homeDir) => {
          setRuntimeEnv({
            HOME: homeDir,
            USERPROFILE: undefined,
            KATO_RUNTIME_DIR: undefined,
          });

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
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("ingestPersistedSession clamps byte-offset cursors when the source file has shrunk", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-session-ingestion-clamp-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

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
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});

Deno.test("ingestPersistedSession recreates a missing twin from source start instead of resuming from ingestCursor", async () => {
  await withLockedEnvironment(async () => {
    const env = snapshotRuntimeEnv();

    try {
      await withTestTempDir("web-session-twin-recreate-", async (homeDir) => {
        setRuntimeEnv({
          HOME: homeDir,
          USERPROFILE: undefined,
          KATO_RUNTIME_DIR: undefined,
        });

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
    } finally {
      restoreRuntimeEnv(env);
    }
  });
});
