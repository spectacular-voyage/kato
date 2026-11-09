import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DaemonStatusSnapshot } from "@kato/shared";
import {
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  InMemorySessionSnapshotStore,
  PersistentSessionStateStore,
  type ProviderIngestionRunner,
  runDaemonRuntimeLoop,
} from "../apps/daemon/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

async function seedSessions(
  store: PersistentSessionStateStore,
  homeDir: string,
  providerSessionIds: string[],
): Promise<void> {
  for (const providerSessionId of providerSessionIds) {
    await store.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId,
      sourceFilePath: join(homeDir, `${providerSessionId}.jsonl`),
      initialCursor: { kind: "byte-offset", value: 0 },
    });
  }
}

Deno.test("listSessionMetadataForKeys reads only the requested sessions, fresh from disk", async () => {
  await withTestTempDir("session-metadata-keys-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    let nextId = 0;
    const daemonStore = new PersistentSessionStateStore({
      katoDir,
      makeSessionId: () => `kato-${++nextId}`,
    });
    await seedSessions(daemonStore, homeDir, ["a", "b", "c"]);
    // Warm the daemon store's caches, as a running daemon would have.
    assertEquals((await daemonStore.listSessionMetadata()).length, 3);

    assertEquals(await daemonStore.listSessionMetadataForKeys([]), []);
    assertEquals(
      await daemonStore.listSessionMetadataForKeys(["codex:missing"]),
      [],
    );
    const picked = await daemonStore.listSessionMetadataForKeys([
      "codex:c",
      "codex:a",
    ]);
    assertEquals(picked.map((entry) => entry.sessionKey).sort(), [
      "codex:a",
      "codex:c",
    ]);

    // A write from another process (e.g. the web console) is visible.
    const webStore = new PersistentSessionStateStore({ katoDir });
    const [webCopy] = await webStore.listSessionMetadataForKeys(["codex:b"]);
    assert(webCopy);
    webCopy.workingDirectory = "/srv/web-edited";
    await webStore.saveSessionMetadata(webCopy);
    const [fresh] = await daemonStore.listSessionMetadataForKeys(["codex:b"]);
    assertEquals(fresh?.workingDirectory, "/srv/web-edited");

    // Returned entries are copies.
    fresh!.workingDirectory = "/mutated";
    const [again] = await daemonStore.listSessionMetadataForKeys(["codex:b"]);
    assertEquals(again?.workingDirectory, "/srv/web-edited");
  });
});

class CountingSessionStateStore extends PersistentSessionStateStore {
  fullListings = 0;
  keyedListings = 0;
  override listSessionMetadata() {
    this.fullListings += 1;
    return super.listSessionMetadata();
  }
  override listSessionMetadataForKeys(sessionKeys: Iterable<string>) {
    this.keyedListings += 1;
    return super.listSessionMetadataForKeys(sessionKeys);
  }
}

Deno.test("runDaemonRuntimeLoop does not re-list every session's metadata on each busy poll", async () => {
  await withTestTempDir("session-metadata-hot-loop-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");
    let nextId = 0;
    const sessionStateStore = new CountingSessionStateStore({
      katoDir,
      makeSessionId: () => `kato-${++nextId}`,
    });
    await seedSessions(
      sessionStateStore,
      homeDir,
      Array.from({ length: 20 }, (_, i) => `idle-${i}`),
    );

    const sessionSnapshotStore = new InMemorySessionSnapshotStore();
    let current: DaemonStatusSnapshot = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load: () => Promise.resolve(structuredClone(current)),
      save(snapshot) {
        current = structuredClone(snapshot);
        return Promise.resolve();
      },
    };

    // A busy session: every poll reports an update.
    let polls = 0;
    const runner: ProviderIngestionRunner = {
      provider: "codex",
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      poll() {
        polls += 1;
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "busy",
          cursor: { kind: "byte-offset", value: polls },
          events: [],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: new Date().toISOString(),
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      },
    };

    const ITERATIONS = 30;
    let listCalls = 0;
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        listCalls += 1;
        return Promise.resolve(
          listCalls >= ITERATIONS
            ? [{
              requestId: "stop-1",
              requestedAt: new Date().toISOString(),
              command: "stop" as const,
            }]
            : [],
        );
      },
      enqueue() {
        throw new Error("enqueue should not be called");
      },
      markProcessed: () => Promise.resolve(),
    };

    sessionStateStore.fullListings = 0;
    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      sessionSnapshotStore,
      sessionStateStore,
      ingestionRunners: [runner],
      now: () => new Date(),
      pid: 4242,
      heartbeatIntervalMs: 60_000,
      pollIntervalMs: 1,
    });

    assert(polls >= ITERATIONS - 1, `expected ~${ITERATIONS} polls`);
    // The recording pass reads only the busy session's metadata each poll.
    assert(sessionStateStore.keyedListings >= polls - 1);
    // Full listings: the startup heartbeat and the exit snapshot, not one or
    // two per poll.
    assert(
      sessionStateStore.fullListings <= 4,
      `full metadata listings: ${sessionStateStore.fullListings} over ${polls} polls`,
    );
  });
});
