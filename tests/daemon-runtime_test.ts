import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { isAbsolute, join } from "@std/path";
import type { ConversationEvent, DaemonStatusSnapshot } from "@kato/shared";
import {
  AuditLogger,
  type DaemonControlRequestStoreLike,
  type DaemonStatusSnapshotStoreLike,
  InMemorySessionSnapshotStore,
  type LogRecord,
  mapConversationEventsToTwin,
  PersistentSessionStateStore,
  type ProviderIngestionRunner,
  type RecordingPipelineLike,
  runDaemonRuntimeLoop,
  SessionSnapshotMemoryBudgetExceededError,
  type SessionSnapshotStore,
  StructuredLogger,
} from "../apps/daemon/src/mod.ts";
import {
  makeTestTempDir,
  makeTestTempPath,
  removePathIfPresent as removeDirIfPresent,
} from "./test_temp.ts";

function makeEvent(
  id: string,
  kind: "message.user" | "message.assistant",
  content: string,
  timestamp = "2026-02-22T19:00:00.000Z",
): ConversationEvent {
  return {
    eventId: id,
    provider: "codex",
    sessionId: "session-1",
    timestamp,
    kind,
    role: kind === "message.user" ? "user" : "assistant",
    content,
    source: {
      providerEventType: kind === "message.user" ? "user" : "assistant",
      providerEventId: id,
    },
  } as unknown as ConversationEvent;
}

class CaptureSink {
  records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }
}

interface PersistentInChatScenarioOptions {
  events: ConversationEvent[];
  recordingPipeline: RecordingPipelineLike;
  prepopulate?: (
    sessionStateStore: PersistentSessionStateStore,
  ) => Promise<void>;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

async function runPersistentInChatScenario(
  options: PersistentInChatScenarioOptions,
): Promise<{
  stateDir: string;
  currentStatus: DaemonStatusSnapshot;
  metadataList: Awaited<
    ReturnType<PersistentSessionStateStore["listSessionMetadata"]>
  >;
}> {
  const stateDir = await makeTestTempDir("daemon-runtime-inchat-redesign-");

  const nowIso = "2026-02-22T10:00:00.000Z";
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: nowIso,
    heartbeatAt: nowIso,
    daemonRunning: false,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
  };
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now: () => new Date(nowIso),
  });
  const sessionStateStore = new PersistentSessionStateStore({
    katoDir: join(stateDir, ".kato"),
    now: () => new Date(nowIso),
    makeSessionId: () => "kato-session-inchat-redesign-1234",
  });
  if (options.prepopulate) {
    await options.prepopulate(sessionStateStore);
  }

  let pollCount = 0;
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      return Promise.resolve();
    },
    poll() {
      pollCount += 1;
      if (pollCount === 1) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-1",
          cursor: { kind: "byte-offset", value: 1 },
          events: options.events,
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: nowIso,
          sessionsUpdated: 1,
          eventsObserved: options.events.length,
        });
      }
      return Promise.resolve({
        provider: "codex",
        polledAt: "2026-02-22T10:00:01.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop-inchat-redesign",
    requestedAt: "2026-02-22T10:00:02.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(
        pollCount >= 2 ? requests.map((request) => ({ ...request })) : [],
      );
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called");
    },
    markProcessed(requestId: string) {
      const idx = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (idx >= 0) {
        requests.splice(0, idx + 1);
      }
      return Promise.resolve();
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline: options.recordingPipeline,
    ingestionRunners: [ingestionRunner],
    sessionSnapshotStore,
    sessionStateStore,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
    now: () => new Date(nowIso),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  const metadataList = await sessionStateStore.listSessionMetadata();
  return { stateDir, currentStatus, metadataList };
}

type ScenarioMetadataList = Awaited<
  ReturnType<PersistentSessionStateStore["listSessionMetadata"]>
>;

async function makeWritableScenarioDir(prefix: string): Promise<string> {
  return await makeTestTempDir(prefix);
}

function makePersistentInChatRecordingPipeline(
  overrides: Partial<RecordingPipelineLike> = {},
): RecordingPipelineLike {
  const nowIso = "2026-02-22T10:00:00.000Z";
  return {
    activateRecording(input) {
      return Promise.resolve({
        recordingId: input.recordingId ?? "rec-default",
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath: input.targetPath,
        startedAt: nowIso,
        lastWriteAt: nowIso,
      });
    },
    captureSnapshot(input) {
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    exportSnapshot(input) {
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      return Promise.resolve({
        appended: false,
        deduped: false,
      });
    },
    appendToDestination(input) {
      return Promise.resolve({
        mode: "append",
        outputPath: input.targetPath,
        wrote: true,
        deduped: false,
      });
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
    ...overrides,
  };
}

async function prepopulateScenarioSessionMetadata(
  sessionStateStore: PersistentSessionStateStore,
  mutate: (metadata: ScenarioMetadataList[number]) => void,
): Promise<void> {
  const metadata = await sessionStateStore.getOrCreateSessionMetadata({
    provider: "codex",
    providerSessionId: "session-1",
    sourceFilePath: "/tmp/mock-source.jsonl",
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  mutate(metadata);
  await sessionStateStore.saveSessionMetadata(metadata);
}

function findScenarioMetadata(metadataList: ScenarioMetadataList) {
  const session = metadataList.find((entry) =>
    entry.providerSessionId === "session-1"
  );
  assertExists(session);
  return session;
}

Deno.test("runDaemonRuntimeLoop persistent in-chat ::init with explicit path sets pointer and prepares file", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-init-explicit-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "init-explicit.md");
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent("u-init-explicit", "message.user", `::init ${destination}`),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.destination, destination);
    assertEquals(session.recordings[0]?.desiredState, "off");
    assertEquals(
      session.recordings.filter((recording) => recording.desiredState === "on")
        .length,
      0,
    );

    const stat = await Deno.stat(destination);
    assert(stat.isFile);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat bare ::init in S0 sets pointer and prepares destination", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-init-bare-",
  );
  let stateDir: string | undefined;

  try {
    const rewrittenDestination = join(scenarioDir, "bare-init-default.md");
    const validateTargets: string[] = [];
    const result = await runPersistentInChatScenario({
      events: [makeEvent("u-init-bare", "message.user", "::init")],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        validateDestinationPath(input) {
          validateTargets.push(input.targetPath);
          return Promise.resolve(rewrittenDestination);
        },
      }),
    });
    stateDir = result.stateDir;

    assertEquals(validateTargets.length, 1);
    assert(isAbsolute(validateTargets[0] ?? ""));

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, rewrittenDestination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.destination, rewrittenDestination);
    assertEquals(session.recordings[0]?.desiredState, "off");

    const stat = await Deno.stat(rewrittenDestination);
    assert(stat.isFile);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::init with existing pointer and file leaves content unchanged", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-init-noop-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "existing.md");
    const initialContent = "preexisting body\n";
    await Deno.writeTextFile(destination, initialContent);

    const result = await runPersistentInChatScenario({
      events: [makeEvent("u-init-noop", "message.user", "::init")],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-existing",
              destination,
              desiredState: "off",
              writeCursor: 0,
              periods: [],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.recordingId, "rec-existing");

    const content = await Deno.readTextFile(destination);
    assertEquals(content, initialContent);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::init in S2 deactivates old recording and moves pointer", async () => {
  const scenarioDir = await makeWritableScenarioDir("daemon-runtime-init-s2-");
  let stateDir: string | undefined;

  try {
    const oldDestination = join(scenarioDir, "old.md");
    const newDestination = join(scenarioDir, "new.md");

    const result = await runPersistentInChatScenario({
      events: [
        makeEvent("u-init-s2", "message.user", `::init ${newDestination}`),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = oldDestination;
            metadata.recordings = [{
              recordingId: "rec-old",
              destination: oldDestination,
              desiredState: "on",
              writeCursor: 0,
              periods: [{
                startedCursor: 0,
                startedAt: "2026-02-22T09:59:00.000Z",
              }],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, newDestination);
    assertEquals(session.recordings.length, 2);

    const oldRecording = session.recordings.find((entry) =>
      entry.destination === oldDestination
    );
    const newRecording = session.recordings.find((entry) =>
      entry.destination === newDestination
    );
    assertExists(oldRecording);
    assertExists(newRecording);
    assertEquals(oldRecording.desiredState, "off");
    assertEquals(oldRecording.periods[0]?.stoppedCursor, 1);
    assertEquals(newRecording.desiredState, "off");
    assertEquals(
      session.recordings.filter((entry) => entry.desiredState === "on").length,
      0,
    );
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat failed ::init leaves pointer unchanged", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-init-fail-",
  );
  let stateDir: string | undefined;

  try {
    const oldDestination = join(scenarioDir, "old.md");
    const rejectedDestination = join(scenarioDir, "rejected.md");

    const result = await runPersistentInChatScenario({
      events: [
        makeEvent(
          "u-init-fail",
          "message.user",
          `::init ${rejectedDestination}`,
        ),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        validateDestinationPath() {
          throw new Error("validation failed");
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = oldDestination;
            metadata.recordings = [{
              recordingId: "rec-old",
              destination: oldDestination,
              desiredState: "off",
              writeCursor: 0,
              periods: [],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, oldDestination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.destination, oldDestination);
    await assertRejects(
      () => Deno.stat(rejectedDestination),
      Deno.errors.NotFound,
    );
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat failed ::record leaves pointer unchanged", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-record-fail-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "pointer.md");
    let appendCalls = 0;
    const result = await runPersistentInChatScenario({
      events: [makeEvent("u-record-fail", "message.user", "::record")],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        appendToDestination() {
          appendCalls += 1;
          throw new Error("append failed");
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-pointer",
              destination,
              desiredState: "off",
              writeCursor: 0,
              periods: [],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    assertEquals(appendCalls, 1);
    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.desiredState, "off");
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::record in S1 starts active at pointer", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-record-s1-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "pointer.md");
    const result = await runPersistentInChatScenario({
      events: [makeEvent("u-record-s1", "message.user", "::record")],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-pointer",
              destination,
              desiredState: "off",
              writeCursor: 0,
              periods: [],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    const recording = session.recordings.find((entry) =>
      entry.destination === destination
    );
    assertExists(recording);
    assertEquals(recording.desiredState, "on");
    assertEquals(recording.writeCursor, 1);
    assertEquals(recording.periods.length, 1);
    assertEquals(recording.periods[0]?.startedCursor, 1);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::record in S2 is a no-op", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-record-s2-noop-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "active.md");
    let appendCalls = 0;
    const result = await runPersistentInChatScenario({
      events: [makeEvent("u-record-s2-noop", "message.user", "::record")],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        appendToDestination() {
          appendCalls += 1;
          return Promise.resolve({
            mode: "append",
            outputPath: destination,
            wrote: true,
            deduped: false,
          });
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-active",
              destination,
              desiredState: "on",
              writeCursor: 1,
              periods: [{
                startedCursor: 0,
                startedAt: "2026-02-22T09:59:00.000Z",
              }],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    assertEquals(appendCalls, 0);
    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.desiredState, "on");
    assertEquals(session.recordings[0]?.periods.length, 1);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::stop in S2 preserves pointer", async () => {
  const scenarioDir = await makeWritableScenarioDir("daemon-runtime-stop-s2-");
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "active.md");
    const result = await runPersistentInChatScenario({
      events: [makeEvent("u-stop-s2", "message.user", "::stop")],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-active",
              destination,
              desiredState: "on",
              writeCursor: 1,
              periods: [{
                startedCursor: 0,
                startedAt: "2026-02-22T09:59:00.000Z",
              }],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.desiredState, "off");
    assertEquals(session.recordings[0]?.periods[0]?.stoppedCursor, 1);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::record after ::stop resumes pointer destination", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-stop-record-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "resume.md");
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent("u-stop", "message.user", "::stop"),
        makeEvent("u-record", "message.user", "::record"),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-resume",
              destination,
              desiredState: "on",
              writeCursor: 0,
              periods: [{
                startedCursor: 0,
                startedAt: "2026-02-22T09:59:00.000Z",
              }],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    const recording = session.recordings[0];
    assertExists(recording);
    assertEquals(recording.desiredState, "on");
    assertEquals(recording.periods.length, 2);
    assertEquals(recording.periods[0]?.stoppedCursor, 1);
    assertEquals(recording.periods[1]?.startedCursor, 2);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::capture without argument captures to pointer", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-capture-no-arg-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "pointer.md");
    const captureTargets: string[] = [];
    const captureRecordingIds: string[][] = [];
    const result = await runPersistentInChatScenario({
      events: [makeEvent("u-capture-pointer", "message.user", "::capture")],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        captureSnapshot(input) {
          captureTargets.push(input.targetPath);
          captureRecordingIds.push(input.recordingIds ?? []);
          return Promise.resolve({
            outputPath: input.targetPath,
            writeResult: {
              mode: "overwrite",
              outputPath: input.targetPath,
              wrote: true,
              deduped: false,
            },
            format: "markdown" as const,
          });
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-pointer",
              destination,
              desiredState: "off",
              writeCursor: 0,
              periods: [],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    assertEquals(captureTargets, [destination]);
    assertEquals(captureRecordingIds, [["rec-pointer"]]);

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.recordingId, "rec-pointer");
    assertEquals(session.recordings[0]?.desiredState, "on");
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat same destination reuses one recordingId", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-idempotent-id-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "same.md");
    const captureRecordingIds: string[][] = [];
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent("u-init-same", "message.user", `::init ${destination}`),
        makeEvent("u-capture-same", "message.user", `::capture ${destination}`),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        captureSnapshot(input) {
          captureRecordingIds.push(input.recordingIds ?? []);
          return Promise.resolve({
            outputPath: input.targetPath,
            writeResult: {
              mode: "overwrite",
              outputPath: input.targetPath,
              wrote: true,
              deduped: false,
            },
            format: "markdown" as const,
          });
        },
      }),
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    const recordings = session.recordings.filter((entry) =>
      entry.destination === destination
    );
    assertEquals(recordings.length, 1);
    assertEquals(captureRecordingIds.length, 1);
    assertEquals(captureRecordingIds[0], [recordings[0]?.recordingId]);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat distinct destinations allocate distinct recordingIds", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-distinct-ids-",
  );
  let stateDir: string | undefined;

  try {
    const destinationA = join(scenarioDir, "a.md");
    const destinationB = join(scenarioDir, "b.md");
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent("u-init-a", "message.user", `::init ${destinationA}`),
        makeEvent("u-capture-b", "message.user", `::capture ${destinationB}`),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    const recordingA = session.recordings.find((entry) =>
      entry.destination === destinationA
    );
    const recordingB = session.recordings.find((entry) =>
      entry.destination === destinationB
    );
    assertExists(recordingA);
    assertExists(recordingB);
    assert(recordingA.recordingId !== recordingB.recordingId);
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::capture in S2 deactivates prior active destination", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-capture-switch-",
  );
  let stateDir: string | undefined;

  try {
    const oldDestination = join(scenarioDir, "old.md");
    const newDestination = join(scenarioDir, "new.md");
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent(
          "u-capture-switch",
          "message.user",
          `::capture ${newDestination}`,
        ),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = oldDestination;
            metadata.recordings = [{
              recordingId: "rec-old",
              destination: oldDestination,
              desiredState: "on",
              writeCursor: 1,
              periods: [{
                startedCursor: 0,
                startedAt: "2026-02-22T09:59:00.000Z",
              }],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    const oldRecording = session.recordings.find((entry) =>
      entry.destination === oldDestination
    );
    const newRecording = session.recordings.find((entry) =>
      entry.destination === newDestination
    );
    assertExists(oldRecording);
    assertExists(newRecording);
    assertEquals(oldRecording.desiredState, "off");
    assertEquals(newRecording.desiredState, "on");
    assertEquals(
      session.recordings.filter((entry) => entry.desiredState === "on").length,
      1,
    );
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::init frontmatter includes stable recordingId", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-init-frontmatter-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "frontmatter.md");
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent(
          "u-init-frontmatter",
          "message.user",
          `::init ${destination}`,
        ),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    const recording = session.recordings.find((entry) =>
      entry.destination === destination
    );
    assertExists(recording);

    const content = await Deno.readTextFile(destination);
    assert(content.includes(recording.recordingId));
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::export leaves pointer and active state unchanged", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-export-invariant-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "active.md");
    const exportTarget = join(scenarioDir, "export.md");
    const exportTargets: string[] = [];
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent("u-export", "message.user", `::export ${exportTarget}`),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        exportSnapshot(input) {
          exportTargets.push(input.targetPath);
          return Promise.resolve({
            outputPath: input.targetPath,
            writeResult: {
              mode: "overwrite",
              outputPath: input.targetPath,
              wrote: true,
              deduped: false,
            },
            format: "markdown" as const,
          });
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-active",
              destination,
              desiredState: "on",
              writeCursor: 1,
              periods: [{
                startedCursor: 0,
                startedAt: "2026-02-22T09:59:00.000Z",
              }],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    assertEquals(exportTargets, [exportTarget]);
    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.desiredState, "on");
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat executes one-message ::stop then ::init then ::record in order", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-sequential-",
  );
  let stateDir: string | undefined;

  try {
    const oldDestination = join(scenarioDir, "old.md");
    const newDestination = join(scenarioDir, "new.md");
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent(
          "u-sequential",
          "message.user",
          `::stop\n::init ${newDestination}\n::record`,
        ),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline(),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = oldDestination;
            metadata.recordings = [{
              recordingId: "rec-old",
              destination: oldDestination,
              desiredState: "on",
              writeCursor: 1,
              periods: [{
                startedCursor: 0,
                startedAt: "2026-02-22T09:59:00.000Z",
              }],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, newDestination);
    const oldRecording = session.recordings.find((entry) =>
      entry.destination === oldDestination
    );
    const newRecording = session.recordings.find((entry) =>
      entry.destination === newDestination
    );
    assertExists(oldRecording);
    assertExists(newRecording);
    assertEquals(oldRecording.desiredState, "off");
    assertEquals(newRecording.desiredState, "on");
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::record seed excludes lines before command boundary", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-record-boundary-exclude-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "boundary.md");
    const seedContents: string[] = [];
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent(
          "u-record-boundary-exclude",
          "message.user",
          "line before\n::record\nline after",
        ),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        appendToDestination(input) {
          const firstEvent = input.events[0];
          const content = firstEvent && "content" in firstEvent
            ? String(firstEvent.content ?? "")
            : "";
          seedContents.push(content);
          return Promise.resolve({
            mode: "append",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          });
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-boundary",
              destination,
              desiredState: "off",
              writeCursor: 0,
              periods: [],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    assertEquals(seedContents.length, 1);
    assert(!seedContents[0]?.includes("line before"));
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat ::record seed includes the ::record command line", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-record-boundary-include-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "boundary.md");
    const seedContents: string[] = [];
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent(
          "u-record-boundary-include",
          "message.user",
          "::record\nline after",
        ),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        appendToDestination(input) {
          const firstEvent = input.events[0];
          const content = firstEvent && "content" in firstEvent
            ? String(firstEvent.content ?? "")
            : "";
          seedContents.push(content);
          return Promise.resolve({
            mode: "append",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          });
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-boundary",
              destination,
              desiredState: "off",
              writeCursor: 0,
              periods: [],
            }];
          },
        );
      },
    });
    stateDir = result.stateDir;

    assertEquals(seedContents.length, 1);
    assert(seedContents[0]?.startsWith("::record"));
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop persistent in-chat rejects relative arguments for ::init, ::capture, and ::export", async () => {
  const scenarioDir = await makeWritableScenarioDir(
    "daemon-runtime-relative-args-",
  );
  let stateDir: string | undefined;

  try {
    const destination = join(scenarioDir, "active.md");
    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const auditLogger = new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date("2026-02-22T10:00:00.000Z"),
      }),
    );

    let captureCalls = 0;
    let exportCalls = 0;
    const result = await runPersistentInChatScenario({
      events: [
        makeEvent(
          "u-rel-init",
          "message.user",
          "::init notes/relative-init.md",
        ),
        makeEvent(
          "u-rel-capture",
          "message.user",
          "::capture notes/relative-capture.md",
        ),
        makeEvent(
          "u-rel-export",
          "message.user",
          "::export notes/relative-export.md",
        ),
      ],
      recordingPipeline: makePersistentInChatRecordingPipeline({
        captureSnapshot() {
          captureCalls += 1;
          throw new Error("capture should not run for relative args");
        },
        exportSnapshot() {
          exportCalls += 1;
          throw new Error("export should not run for relative args");
        },
      }),
      prepopulate: async (sessionStateStore) => {
        await prepopulateScenarioSessionMetadata(
          sessionStateStore,
          (metadata) => {
            metadata.primaryRecordingDestination = destination;
            metadata.recordings = [{
              recordingId: "rec-active",
              destination,
              desiredState: "on",
              writeCursor: 3,
              periods: [{ startedCursor: 0 }],
            }];
          },
        );
      },
      operationalLogger,
      auditLogger,
    });
    stateDir = result.stateDir;

    assertEquals(captureCalls, 0);
    assertEquals(exportCalls, 0);

    const invalidTargetLogs = sink.records.filter((record) =>
      record.event === "recording.command.invalid_target" &&
      record.channel === "operational"
    );
    assertEquals(invalidTargetLogs.length, 3);
    const invalidCommands = new Set(
      invalidTargetLogs.map((record) =>
        String(record.attributes?.command ?? "")
      ),
    );
    assert(invalidCommands.has("init"));
    assert(invalidCommands.has("capture"));
    assert(invalidCommands.has("export"));
    assert(
      invalidTargetLogs.every((record) =>
        String(record.attributes?.reason ?? "").includes("absolute")
      ),
    );

    const session = findScenarioMetadata(result.metadataList);
    assertEquals(session.primaryRecordingDestination, destination);
    assertEquals(session.recordings.length, 1);
    assertEquals(session.recordings[0]?.desiredState, "on");
  } finally {
    await removeDirIfPresent(stateDir);
    await removeDirIfPresent(scenarioDir);
  }
});

Deno.test("runDaemonRuntimeLoop processes stop requests and updates status", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-1",
    requestedAt: "2026-02-22T10:00:00.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertExists(statusHistory[0]);
  assertEquals(statusHistory[0]?.daemonRunning, true);
  assertEquals(statusHistory[0]?.daemonPid, 4242);

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last?.daemonRunning, false);
  assertEquals(last?.daemonPid, undefined);
  assertEquals(requests.length, 0);
});

Deno.test("runDaemonRuntimeLoop routes export requests through recording pipeline", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "session-42",
        resolvedOutputPath: ".kato/test-runtime/session-42.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{
    provider: string;
    sessionId: string;
    targetPath: string;
    eventCount: number;
  }> = [];

  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({
        provider: input.provider,
        sessionId: input.sessionId,
        targetPath: input.targetPath,
        eventCount: input.events.length,
      });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const loadedSessions: string[] = [];
  const sessionMessages = [
    makeEvent(
      "m1",
      "message.assistant",
      "export me",
      "2026-02-22T10:00:00.000Z",
    ),
  ];

  const tempDir = await makeTestTempDir("daemon-runtime-exports-");

  try {
    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      loadSessionSnapshot(sessionId: string) {
        loadedSessions.push(sessionId);
        return Promise.resolve({
          provider: "unknown",
          events: sessionMessages,
        });
      },
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
      exportsLogPath: join(tempDir, "exports.jsonl"),
    });

    const exportsLines =
      (await Deno.readTextFile(join(tempDir, "exports.jsonl")))
        .trim()
        .split("\n");
    assertEquals(exportsLines.length, 1);
    const entry = JSON.parse(exportsLines[0]!) as {
      requestId: string;
      status: string;
      provider: string;
    };
    assertEquals(entry.requestId, "req-export");
    assertEquals(entry.status, "succeeded");
    assertEquals(entry.provider, "unknown");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }

  assertEquals(loadedSessions, ["session-42"]);
  assertEquals(exported.length, 1);
  assertEquals(exported[0], {
    provider: "unknown",
    sessionId: "session-42",
    targetPath: ".kato/test-runtime/session-42.md",
    eventCount: 1,
  });
  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last?.daemonRunning, false);
});

Deno.test("runDaemonRuntimeLoop uses provider-aware session snapshots when available", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "session-with-provider",
        resolvedOutputPath: ".kato/test-runtime/session-with-provider.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ provider: string; sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({
        provider: input.provider,
        sessionId: input.sessionId,
      });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const loadedSnapshots: string[] = [];
  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(sessionId: string) {
      loadedSnapshots.push(sessionId);
      return Promise.resolve({
        provider: "codex",
        events: [
          makeEvent(
            "m1",
            "message.assistant",
            "export me",
            "2026-02-22T10:00:00.000Z",
          ),
        ],
      });
    },
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(loadedSnapshots, ["session-with-provider"]);
  assertEquals(exported, [{
    provider: "codex",
    sessionId: "session-with-provider",
  }]);
});

Deno.test("runDaemonRuntimeLoop resolves export short session selectors via session state metadata", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-export-resolve-");

  try {
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          schemaVersion: 1,
          generatedAt: "2026-02-22T10:00:00.000Z",
          heartbeatAt: "2026-02-22T10:00:00.000Z",
          daemonRunning: false,
          providers: [],
          recordings: {
            activeRecordings: 0,
            destinations: 0,
          },
        });
      },
      save(_snapshot) {
        return Promise.resolve();
      },
    };

    const requests = [
      {
        requestId: "req-export-short",
        requestedAt: "2026-02-22T10:00:00.000Z",
        command: "export" as const,
        payload: {
          sessionId: "2ee6e8b4",
          resolvedOutputPath: ".kato/test-runtime/session-short.md",
        },
      },
      {
        requestId: "req-export-prefixed-short",
        requestedAt: "2026-02-22T10:00:01.000Z",
        command: "export" as const,
        payload: {
          sessionId: "codex/2ee6e8b4",
          resolvedOutputPath: ".kato/test-runtime/session-prefixed-short.md",
        },
      },
      {
        requestId: "req-stop",
        requestedAt: "2026-02-22T10:00:02.000Z",
        command: "stop" as const,
      },
    ];

    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called in this test");
      },
      markProcessed(requestId: string) {
        const index = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (index >= 0) {
          requests.splice(0, index + 1);
        }
        return Promise.resolve();
      },
    };

    const exportedSessionIds: string[] = [];
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot(input) {
        exportedSessionIds.push(input.sessionId);
        return Promise.resolve({
          outputPath: input.targetPath,
          writeResult: {
            mode: "overwrite",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          },
          format: "markdown" as const,
        });
      },
      appendToActiveRecording() {
        throw new Error("not used");
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return {
          activeRecordings: 0,
          destinations: 0,
        };
      },
    };

    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "2ee6e8b4-1111-2222-3333-444444444444",
    });
    await sessionStateStore.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "provider-session-42",
      sourceFilePath: "/tmp/provider-session-42.jsonl",
      initialCursor: { kind: "byte-offset", value: 0 },
    });

    const loadedSnapshots: string[] = [];
    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      sessionStateStore,
      loadSessionSnapshot(sessionId: string) {
        loadedSnapshots.push(sessionId);
        return Promise.resolve({
          provider: "codex",
          events: [makeEvent("m1", "message.assistant", "export me")],
        });
      },
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(loadedSnapshots, [
      "provider-session-42",
      "provider-session-42",
    ]);
    assertEquals(exportedSessionIds, ["2ee6e8b4", "codex/2ee6e8b4"]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop skips export when session snapshot is missing", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "missing-session",
        resolvedOutputPath: ".kato/test-runtime/missing-session.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const processed: string[] = [];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      processed.push(requestId);
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({ sessionId: input.sessionId });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(_sessionId: string) {
      return Promise.resolve(undefined);
    },
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(exported.length, 0);
  assertEquals(processed.includes("req-export"), true);
  assertEquals(processed.includes("req-stop"), true);
  assertEquals(
    sink.records.some((record) =>
      record.event === "daemon.control.export.session_missing" &&
      record.channel === "operational"
    ),
    true,
  );
});

Deno.test("runDaemonRuntimeLoop skips export when session snapshot has no events", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "empty-session",
        resolvedOutputPath: ".kato/test-runtime/empty-session.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const processed: string[] = [];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      processed.push(requestId);
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({ sessionId: input.sessionId });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(_sessionId: string) {
      return Promise.resolve({
        provider: "codex",
        events: [],
      });
    },
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(exported.length, 0);
  assertEquals(processed.includes("req-export"), true);
  assertEquals(processed.includes("req-stop"), true);
  assertEquals(
    sink.records.some((record) =>
      record.event === "daemon.control.export.empty" &&
      record.channel === "operational"
    ),
    true,
  );
});

Deno.test("runDaemonRuntimeLoop skips export requests when export feature is disabled", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [
    {
      requestId: "req-export",
      requestedAt: "2026-02-22T10:00:00.000Z",
      command: "export" as const,
      payload: {
        sessionId: "session-42",
        resolvedOutputPath: ".kato/test-runtime/session-42.md",
      },
    },
    {
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    },
  ];
  const processed: string[] = [];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      processed.push(requestId);
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const exported: Array<{ sessionId: string }> = [];
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot(input) {
      exported.push({ sessionId: input.sessionId });
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const loadedSessions: string[] = [];
  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot(sessionId: string) {
      loadedSessions.push(sessionId);
      return Promise.resolve({
        provider: "unknown",
        events: [],
      });
    },
    exportEnabled: false,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(loadedSessions.length, 0);
  assertEquals(exported.length, 0);
  assertEquals(processed.includes("req-export"), true);
  assertEquals(processed.includes("req-stop"), true);
});

Deno.test("runDaemonRuntimeLoop starts, polls, and stops ingestion runners", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const calls: string[] = [];
  const runner: ProviderIngestionRunner = {
    provider: "claude",
    start() {
      calls.push("start");
      return Promise.resolve();
    },
    poll() {
      calls.push("poll");
      return Promise.resolve({
        provider: "claude",
        polledAt: "2026-02-22T10:00:00.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      calls.push("stop");
      return Promise.resolve();
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    ingestionRunners: [runner],
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(calls, ["start", "poll", "stop"]);
});

Deno.test("runDaemonRuntimeLoop populates status.providers from session snapshot store", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore: SessionSnapshotStore = {
    upsert() {
      throw new Error("not used");
    },
    get() {
      return undefined;
    },
    list() {
      return [
        {
          provider: "codex",
          sessionId: "s1",
          cursor: { kind: "byte-offset", value: 12 },
          events: [
            makeEvent(
              "m1",
              "message.assistant",
              "hello",
              "2026-02-22T10:00:00.000Z",
            ),
          ],
          conversationSchemaVersion: 2,
          metadata: {
            updatedAt: "2026-02-22T10:00:00.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:00.000Z",
          },
        },
        {
          provider: "codex",
          sessionId: "s2",
          cursor: { kind: "byte-offset", value: 24 },
          events: [
            makeEvent(
              "m2",
              "message.assistant",
              "world",
              "2026-02-22T10:00:05.000Z",
            ),
          ],
          conversationSchemaVersion: 2,
          metadata: {
            updatedAt: "2026-02-22T10:00:05.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:05.000Z",
          },
        },
        {
          provider: "claude",
          sessionId: "s3",
          cursor: { kind: "byte-offset", value: 8 },
          events: [
            makeEvent(
              "m3",
              "message.assistant",
              "hi",
              "2026-02-22T10:00:03.000Z",
            ),
          ],
          conversationSchemaVersion: 2,
          metadata: {
            updatedAt: "2026-02-22T10:00:03.000Z",
            eventCount: 1,
            truncatedEvents: 0,
            lastEventAt: "2026-02-22T10:00:03.000Z",
          },
        },
      ];
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:06.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.providers, [
    {
      provider: "claude",
      activeSessions: 1,
      lastMessageAt: "2026-02-22T10:00:03.000Z",
    },
    {
      provider: "codex",
      activeSessions: 2,
      lastMessageAt: "2026-02-22T10:00:05.000Z",
    },
  ]);
});

// Note: `lastMessageAt` is the external ProviderStatus field name (status.json API surface,
// intentionally kept for backward compatibility). Internally the snapshot store uses `lastEventAt`.
Deno.test("runDaemonRuntimeLoop omits lastMessageAt when provider sessions have no message timestamps", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore: SessionSnapshotStore = {
    upsert() {
      throw new Error("not used");
    },
    get() {
      return undefined;
    },
    list() {
      return [{
        provider: "codex",
        sessionId: "s1",
        cursor: { kind: "byte-offset", value: 12 },
        events: [
          makeEvent(
            "m1",
            "message.assistant",
            "hello",
            "2026-02-22T10:00:00.000Z",
          ),
        ],
        conversationSchemaVersion: 2,
        metadata: {
          updatedAt: "2026-02-22T10:00:00.000Z",
          eventCount: 1,
          truncatedEvents: 0,
        },
      }];
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:06.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.providers, [{
    provider: "codex",
    activeSessions: 1,
  }]);
});

Deno.test("runDaemonRuntimeLoop omits stale provider snapshots from status.providers", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore: SessionSnapshotStore = {
    upsert() {
      throw new Error("not used");
    },
    get() {
      return undefined;
    },
    list() {
      return [{
        provider: "codex",
        sessionId: "stale",
        cursor: { kind: "byte-offset", value: 10 },
        events: [
          makeEvent(
            "m1",
            "message.assistant",
            "stale",
            "2026-02-22T09:00:00.000Z",
          ),
        ],
        conversationSchemaVersion: 2,
        metadata: {
          updatedAt: "2026-02-22T09:00:00.000Z",
          eventCount: 1,
          truncatedEvents: 0,
          lastEventAt: "2026-02-22T09:00:00.000Z",
        },
      }];
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    providerStatusStaleAfterMs: 1_000,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.providers, []);
});

Deno.test("runDaemonRuntimeLoop excludes stale recordings from status.recordings.activeRecordings", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-recording-status-");
  try {
    const statusHistory: DaemonStatusSnapshot[] = [];
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: {
        activeRecordings: 0,
        destinations: 0,
      },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
        };
        statusHistory.push({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop-stale-recording-count",
      requestedAt: "2026-02-22T10:00:01.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called in this test");
      },
      markProcessed(requestId: string) {
        const index = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (index >= 0) {
          requests.splice(0, index + 1);
        }
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    sessionSnapshotStore.upsert({
      provider: "codex",
      sessionId: "session-stale",
      cursor: { kind: "byte-offset", value: 1 },
      events: [{
        eventId: "stale-message",
        provider: "codex",
        sessionId: "session-stale",
        timestamp: "2026-02-22T08:00:00.000Z",
        kind: "message.user",
        role: "user",
        content: "old message",
        source: {
          providerEventType: "user",
          providerEventId: "stale-message",
        },
      } as ConversationEvent],
    });
    sessionSnapshotStore.upsert({
      provider: "codex",
      sessionId: "session-active",
      cursor: { kind: "byte-offset", value: 1 },
      events: [{
        eventId: "active-message",
        provider: "codex",
        sessionId: "session-active",
        timestamp: "2026-02-22T10:00:00.000Z",
        kind: "message.user",
        role: "user",
        content: "fresh message",
        source: {
          providerEventType: "user",
          providerEventId: "active-message",
        },
      } as ConversationEvent],
    });
    let sessionStateNow = new Date("2026-02-22T08:00:00.000Z");
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => sessionStateNow,
      makeSessionId: () => "kato-session-recording-status-1234",
    });

    const staleMetadata = await sessionStateStore.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-stale",
      sourceFilePath: "/tmp/session-stale.jsonl",
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    staleMetadata.recordings = [{
      recordingId: "recording-stale-1",
      destination: "/tmp/stale.md",
      desiredState: "on",
      writeCursor: 0,
      periods: [{ startedCursor: 0 }],
    }];
    await sessionStateStore.saveSessionMetadata(staleMetadata);

    sessionStateNow = new Date("2026-02-22T10:00:00.000Z");
    const activeMetadata = await sessionStateStore.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-active",
      sourceFilePath: "/tmp/session-active.jsonl",
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    activeMetadata.recordings = [{
      recordingId: "recording-active-1",
      destination: "/tmp/active.md",
      desiredState: "on",
      writeCursor: 0,
      periods: [{ startedCursor: 0 }],
    }];
    await sessionStateStore.saveSessionMetadata(activeMetadata);

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      sessionSnapshotStore,
      sessionStateStore,
      providerStatusStaleAfterMs: 60_000,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    const last = statusHistory[statusHistory.length - 1];
    assertExists(last);
    assertEquals(last.recordings.activeRecordings, 1);
    assertEquals(last.recordings.destinations, 1);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop applies in-chat ::record commands from newly ingested messages", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const inChatCommandDir = makeTestTempPath("in-chat-record-commands-");
  const oldPath = join(inChatCommandDir, "old.md");
  const newPath = join(inChatCommandDir, "new.md");
  await removeDirIfPresent(inChatCommandDir);
  await Deno.mkdir(inChatCommandDir, { recursive: true });
  try {
    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;

        const baselineMessage = makeEvent(
          "m1",
          "message.user",
          `::init ${oldPath}\n::record\nold command`,
          "2026-02-22T09:59:59.000Z",
        );
        const newCommandMessage = makeEvent(
          "m2",
          "message.user",
          `::init ${newPath}\n::record\nnew command`,
          "2026-02-22T10:00:01.000Z",
        );
        const assistantReply = makeEvent(
          "m3",
          "message.assistant",
          "recording now",
          "2026-02-22T10:00:02.000Z",
        );

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-1",
            cursor: { kind: "byte-offset", value: 10 },
            events: [baselineMessage],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }

        if (pollCount === 2) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-1",
            cursor: { kind: "byte-offset", value: 20 },
            events: [baselineMessage, newCommandMessage],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:01.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }

        if (pollCount === 3) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-1",
            cursor: { kind: "byte-offset", value: 30 },
            events: [baselineMessage, newCommandMessage, assistantReply],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:02.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }

        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:03.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:05.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        if (pollCount >= 3) {
          return Promise.resolve(requests.map((request) => ({ ...request })));
        }
        return Promise.resolve([]);
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called in this test");
      },
      markProcessed(requestId: string) {
        const index = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (index >= 0) {
          requests.splice(0, index + 1);
        }
        return Promise.resolve();
      },
    };

    const activatedTargets: string[] = [];
    const activatedRecordingIds: string[] = [];
    const appendedMessageIds: string[] = [];
    let activeRecording = false;
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording(input) {
        activeRecording = true;
        activatedTargets.push(input.targetPath);
        const recordingId = input.recordingId ?? "rec-1";
        activatedRecordingIds.push(recordingId);
        const nowIso = "2026-02-22T10:00:01.000Z";
        return Promise.resolve({
          recordingId,
          provider: input.provider,
          sessionId: input.sessionId,
          outputPath: input.targetPath,
          startedAt: nowIso,
          lastWriteAt: nowIso,
        });
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording(input) {
        if (!activeRecording) {
          return Promise.resolve({
            appended: false,
            deduped: false,
          });
        }

        for (const event of input.events) {
          appendedMessageIds.push(event.eventId);
        }
        return Promise.resolve({
          appended: true,
          deduped: false,
        });
      },
      stopRecording() {
        activeRecording = false;
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return {
          activeRecordings: activeRecording ? 1 : 0,
          destinations: activeRecording ? 1 : 0,
        };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(activatedTargets, [newPath]);
    assertEquals(activatedRecordingIds.length, 1);
    assert(activatedRecordingIds[0].length > 0);
    assertEquals(appendedMessageIds, ["m2", "m3"]);
    const newDestinationStat = await Deno.stat(newPath);
    assert(newDestinationStat.isFile);
    const newDestinationContent = await Deno.readTextFile(newPath);
    assert(newDestinationContent.includes(activatedRecordingIds[0]));
  } finally {
    await removeDirIfPresent(inChatCommandDir);
  }
});

Deno.test("runDaemonRuntimeLoop applies in-chat ::capture then activates recording on same path", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  let pollCount = 0;
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      return Promise.resolve();
    },
    poll() {
      pollCount += 1;

      const baselineMessage = makeEvent(
        "m1",
        "message.user",
        "plain baseline",
        "2026-02-22T10:00:00.000Z",
      );
      const captureCommandMessage = makeEvent(
        "m2",
        "message.user",
        "::capture /tmp/captured.md\ncapture now",
        "2026-02-22T10:00:01.000Z",
      );
      const assistantReply = makeEvent(
        "m3",
        "message.assistant",
        "captured and now recording",
        "2026-02-22T10:00:02.000Z",
      );

      if (pollCount === 1) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-capture",
          cursor: { kind: "byte-offset", value: 10 },
          events: [baselineMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:00.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 2) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-capture",
          cursor: { kind: "byte-offset", value: 20 },
          events: [baselineMessage, captureCommandMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 3) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-capture",
          cursor: { kind: "byte-offset", value: 30 },
          events: [baselineMessage, captureCommandMessage, assistantReply],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:02.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      return Promise.resolve({
        provider: "codex",
        polledAt: "2026-02-22T10:00:03.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:05.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      if (pollCount >= 3) {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const callOrder: string[] = [];
  const captureTargets: string[] = [];
  const activatedTargets: string[] = [];
  const appendedMessageIds: string[] = [];
  let activeRecording = false;
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording(input) {
      callOrder.push("record");
      activeRecording = true;
      activatedTargets.push(input.targetPath);
      const nowIso = "2026-02-22T10:00:01.000Z";
      return Promise.resolve({
        recordingId: "rec-capture",
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath: input.targetPath,
        startedAt: nowIso,
        lastWriteAt: nowIso,
      });
    },
    captureSnapshot(input) {
      callOrder.push("capture");
      captureTargets.push(input.targetPath);
      return Promise.resolve({
        outputPath: input.targetPath,
        writeResult: {
          mode: "overwrite",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        },
        format: "markdown" as const,
      });
    },
    exportSnapshot() {
      throw new Error("not used");
    },
    appendToActiveRecording(input) {
      if (!activeRecording) {
        return Promise.resolve({
          appended: false,
          deduped: false,
        });
      }

      for (const event of input.events) {
        appendedMessageIds.push(event.eventId);
      }
      return Promise.resolve({
        appended: true,
        deduped: false,
      });
    },
    stopRecording() {
      activeRecording = false;
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: activeRecording ? 1 : 0,
        destinations: activeRecording ? 1 : 0,
      };
    },
  };

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    ingestionRunners: [ingestionRunner],
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(callOrder, ["capture", "record"]);
  assertEquals(captureTargets, ["/tmp/captured.md"]);
  assertEquals(activatedTargets, ["/tmp/captured.md"]);
  assertEquals(appendedMessageIds, ["m2", "m3"]);
});

Deno.test(
  "runDaemonRuntimeLoop applies in-chat ::capture on first seen snapshot when event is newer than daemon start",
  async () => {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: {
        activeRecordings: 0,
        destinations: 0,
      },
    };

    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
        };
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-first-seen-capture",
            cursor: { kind: "byte-offset", value: 10 },
            events: [
              makeEvent(
                "m1",
                "message.user",
                "::capture /tmp/first-seen.md",
                "2026-02-22T10:00:01.000Z",
              ),
            ],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:01.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }

        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:02.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:03.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        if (pollCount >= 2) {
          return Promise.resolve(requests.map((request) => ({ ...request })));
        }
        return Promise.resolve([]);
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called in this test");
      },
      markProcessed(requestId: string) {
        const index = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (index >= 0) {
          requests.splice(0, index + 1);
        }
        return Promise.resolve();
      },
    };

    const callOrder: string[] = [];
    const captureTargets: string[] = [];
    const activatedTargets: string[] = [];
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording(input) {
        callOrder.push("record");
        activatedTargets.push(input.targetPath);
        const nowIso = "2026-02-22T10:00:01.000Z";
        return Promise.resolve({
          recordingId: "rec-first-seen",
          provider: input.provider,
          sessionId: input.sessionId,
          outputPath: input.targetPath,
          startedAt: nowIso,
          lastWriteAt: nowIso,
        });
      },
      captureSnapshot(input) {
        callOrder.push("capture");
        captureTargets.push(input.targetPath);
        return Promise.resolve({
          outputPath: input.targetPath,
          writeResult: {
            mode: "overwrite",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          },
          format: "markdown" as const,
        });
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({
          appended: false,
          deduped: false,
        });
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return {
          activeRecordings: 0,
          destinations: 0,
        };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(callOrder, ["capture", "record"]);
    assertEquals(captureTargets, ["/tmp/first-seen.md"]);
    assertEquals(activatedTargets, ["/tmp/first-seen.md"]);
  },
);

Deno.test(
  "runDaemonRuntimeLoop does not replay in-chat commands older than daemon start on first seen snapshot",
  async () => {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: {
        activeRecordings: 0,
        destinations: 0,
      },
    };

    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
        };
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-prestart-capture",
            cursor: { kind: "byte-offset", value: 10 },
            events: [
              makeEvent(
                "old-capture",
                "message.user",
                "::capture notes/old-command.md",
                "2026-02-22T09:59:59.000Z",
              ),
            ],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:01.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }

        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:02.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:03.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        if (pollCount >= 2) {
          return Promise.resolve(requests.map((request) => ({ ...request })));
        }
        return Promise.resolve([]);
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called in this test");
      },
      markProcessed(requestId: string) {
        const index = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (index >= 0) {
          requests.splice(0, index + 1);
        }
        return Promise.resolve();
      },
    };

    let captureCalls = 0;
    let recordCalls = 0;
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        recordCalls += 1;
        throw new Error("should not be called");
      },
      captureSnapshot() {
        captureCalls += 1;
        throw new Error("should not be called");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({
          appended: false,
          deduped: false,
        });
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return {
          activeRecordings: 0,
          destinations: 0,
        };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(captureCalls, 0);
    assertEquals(recordCalls, 0);
  },
);

Deno.test("runDaemonRuntimeLoop fails closed when in-chat command parsing reports errors", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  let pollCount = 0;
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      return Promise.resolve();
    },
    poll() {
      pollCount += 1;

      const baselineMessage = makeEvent(
        "base",
        "message.user",
        "hello",
        "2026-02-22T10:00:00.000Z",
      );
      const invalidCommandMessage = makeEvent(
        "invalid",
        "message.user",
        "::export\n::record notes/should-not-run.md",
        "2026-02-22T10:00:01.000Z",
      );

      if (pollCount === 1) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-parse-error",
          cursor: { kind: "byte-offset", value: 10 },
          events: [baselineMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:00.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      if (pollCount === 2) {
        sessionSnapshotStore.upsert({
          provider: "codex",
          sessionId: "session-parse-error",
          cursor: { kind: "byte-offset", value: 20 },
          events: [baselineMessage, invalidCommandMessage],
        });
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 1,
          eventsObserved: 1,
        });
      }

      return Promise.resolve({
        provider: "codex",
        polledAt: "2026-02-22T10:00:02.000Z",
        sessionsUpdated: 0,
        eventsObserved: 0,
      });
    },
    stop() {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:05.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      if (pollCount >= 2) {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  let activateCalls = 0;
  const recordingPipeline: RecordingPipelineLike = {
    activateRecording() {
      activateCalls += 1;
      throw new Error("should not be called");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot() {
      throw new Error("not used");
    },
    appendToActiveRecording() {
      return Promise.resolve({
        appended: false,
        deduped: false,
      });
    },
    stopRecording() {
      return true;
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return {
        activeRecordings: 0,
        destinations: 0,
      };
    },
  };

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    recordingPipeline,
    ingestionRunners: [ingestionRunner],
    sessionSnapshotStore,
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assertEquals(activateCalls, 0);
  assert(
    sink.records.some((record) =>
      record.event === "recording.command.parse_error" &&
      record.channel === "operational"
    ),
  );
  assert(
    sink.records.some((record) =>
      record.event === "recording.command.parse_error" &&
      record.channel === "security-audit"
    ),
  );
});

Deno.test("runDaemonRuntimeLoop populates memory stats in status snapshot", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
        memory: snapshot.memory ? { ...snapshot.memory } : undefined,
      };
      statusHistory.push({
        ...currentStatus,
      });
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 50,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });

  // Add some data to verify stats
  sessionSnapshotStore.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e1", "message.user", "test")],
  });

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    now: () => new Date("2026-02-22T10:00:06.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
    daemonMaxMemoryMb: 50,
  });

  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertExists(last.memory);
  assertEquals(last.memory?.daemonMaxMemoryBytes, 50 * 1024 * 1024);
  assertExists(last.memory?.process);
  assertExists(last.memory?.snapshots);
  assertEquals(last.memory?.snapshots.sessionCount, 1);
  assertEquals(last.memory?.snapshots.overBudget, false);
});

Deno.test("runDaemonRuntimeLoop logs memory samples and evictions", async () => {
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: {
          activeRecordings: 0,
          destinations: 0,
        },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop",
    requestedAt: "2026-02-22T10:00:01.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(requestId: string) {
      const index = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (index >= 0) {
        requests.splice(0, index + 1);
      }
      return Promise.resolve();
    },
  };

  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    daemonMaxMemoryMb: 50,
    retention: { maxSessions: 1, maxEventsPerSession: 100 },
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  sessionSnapshotStore.upsert({
    provider: "p1",
    sessionId: "s1",
    cursor: { kind: "byte-offset", value: 0 },
    events: [makeEvent("e1", "message.user", "first")],
  });
  sessionSnapshotStore.upsert({
    provider: "p1",
    sessionId: "s2",
    cursor: { kind: "byte-offset", value: 1 },
    events: [makeEvent("e2", "message.user", "second")],
  });

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionSnapshotStore,
    operationalLogger,
    auditLogger,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
    daemonMaxMemoryMb: 50,
  });

  assert(
    sink.records.some((record) =>
      record.event === "daemon.memory.sample" &&
      record.channel === "operational"
    ),
  );
  const evictionRecord = sink.records.find((record) =>
    record.event === "daemon.memory.evicted" &&
    record.channel === "operational"
  );
  assertExists(evictionRecord);
  const evictions = evictionRecord.attributes?.["evictions"];
  assertEquals(typeof evictions, "number");
  assert((evictions as number) > 0);
});

Deno.test("runDaemonRuntimeLoop shuts down cleanly on fatal memory-budget error", async () => {
  const statusHistory: DaemonStatusSnapshot[] = [];
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };

  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      statusHistory.push({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
      return Promise.resolve();
    },
  };

  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called in this test");
    },
    markProcessed(_requestId: string) {
      throw new Error("markProcessed should not be called in this test");
    },
  };

  const sink = new CaptureSink();
  const operationalLogger = new StructuredLogger([sink], {
    channel: "operational",
    minLevel: "debug",
    now: () => new Date("2026-02-22T10:00:00.000Z"),
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([sink], {
      channel: "security-audit",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    }),
  );

  const calls: string[] = [];
  const ingestionRunner: ProviderIngestionRunner = {
    provider: "codex",
    start() {
      calls.push("start");
      return Promise.resolve();
    },
    poll() {
      calls.push("poll");
      return Promise.reject(
        new SessionSnapshotMemoryBudgetExceededError(
          "session-over-budget",
          1024,
          512,
        ),
      );
    },
    stop() {
      calls.push("stop");
      return Promise.resolve();
    },
  };

  await assertRejects(
    () =>
      runDaemonRuntimeLoop({
        statusStore,
        controlStore,
        ingestionRunners: [ingestionRunner],
        now: () => new Date("2026-02-22T10:00:00.000Z"),
        pid: 4242,
        heartbeatIntervalMs: 50,
        pollIntervalMs: 10,
        operationalLogger,
        auditLogger,
      }),
    SessionSnapshotMemoryBudgetExceededError,
  );

  assertEquals(calls, ["start", "poll", "stop"]);
  const last = statusHistory[statusHistory.length - 1];
  assertExists(last);
  assertEquals(last.daemonRunning, false);
  assert(
    sink.records.some((record) =>
      record.event === "daemon.memory_budget.exceeded" &&
      record.channel === "operational"
    ),
  );
  assert(
    sink.records.some((record) =>
      record.event === "daemon.memory_budget.exceeded" &&
      record.channel === "security-audit"
    ),
  );
});

Deno.test("runDaemonRuntimeLoop persists recording state via sessionStateStore", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-persistent-");
  try {
    const statusHistory: DaemonStatusSnapshot[] = [];
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
          ...(currentStatus.sessions
            ? { sessions: [...currentStatus.sessions] }
            : {}),
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
          ...(snapshot.sessions ? { sessions: [...snapshot.sessions] } : {}),
        };
        statusHistory.push(currentStatus);
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-persist-1234",
    });
    const persistentDestination = join(stateDir, "persistent-recording.md");

    const makeLocalEvent = (
      id: string,
      kind: "message.user" | "message.assistant",
      content: string,
      timestamp: string,
    ): ConversationEvent => ({
      eventId: id,
      provider: "codex",
      sessionId: "session-persist",
      timestamp,
      kind,
      role: kind === "message.user" ? "user" : "assistant",
      content,
      source: {
        providerEventType: kind === "message.user" ? "user" : "assistant",
        providerEventId: id,
      },
    } as ConversationEvent);

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        const startCommand = makeLocalEvent(
          "u-start",
          "message.user",
          `::init ${persistentDestination}\n::record`,
          "2026-02-22T10:00:00.000Z",
        );
        const assistantMessage = makeLocalEvent(
          "a-1",
          "message.assistant",
          "captured assistant event",
          "2026-02-22T10:00:01.000Z",
        );
        const stopCommand = makeLocalEvent(
          "u-stop",
          "message.user",
          "::stop",
          "2026-02-22T10:00:02.000Z",
        );

        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-persist",
            cursor: { kind: "byte-offset", value: 1 },
            events: [startCommand],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }
        if (pollCount === 2) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-persist",
            cursor: { kind: "byte-offset", value: 2 },
            events: [startCommand, assistantMessage],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:01.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }
        if (pollCount === 3) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-persist",
            cursor: { kind: "byte-offset", value: 3 },
            events: [startCommand, assistantMessage, stopCommand],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:02.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:03.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop",
      requestedAt: "2026-02-22T10:00:05.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 4 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const appendCalls: number[] = [];
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      appendToDestination(input) {
        appendCalls.push(input.events.length);
        return Promise.resolve({
          mode: "append",
          outputPath: input.targetPath,
          wrote: true,
          deduped: false,
        });
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(appendCalls, [1, 1]);
    const metadataList = await sessionStateStore.listSessionMetadata();
    assertEquals(metadataList.length, 1);
    const recording = metadataList[0]?.recordings[0];
    assertExists(recording);
    assertEquals(recording?.desiredState, "off");
    assertEquals(recording?.writeCursor, 2);

    const lastStatus = statusHistory[statusHistory.length - 1];
    assertExists(lastStatus);
    const session = lastStatus.sessions?.[0];
    assertExists(session);
    assertEquals(session?.providerSessionId, "session-persist");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop captures from twin start when snapshot is truncated", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-capture-twin-start-");

  try {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
        };
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      retention: {
        maxSessions: 200,
        maxEventsPerSession: 2,
      },
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-capture-twin-start-1234",
    });

    const provider = "codex";
    const providerSessionId = "session-capture-twin-start";
    const makeLocalEvent = (
      id: string,
      kind: "message.user" | "message.assistant",
      content: string,
      timestamp: string,
    ): ConversationEvent => ({
      eventId: id,
      provider,
      sessionId: providerSessionId,
      timestamp,
      kind,
      role: kind === "message.user" ? "user" : "assistant",
      content,
      source: {
        providerEventType: kind === "message.user" ? "user" : "assistant",
        providerEventId: id,
      },
    } as ConversationEvent);

    const firstUserMessage = makeLocalEvent(
      "u-history-1",
      "message.user",
      "early context",
      "2026-02-22T10:00:00.000Z",
    );
    const firstAssistantMessage = makeLocalEvent(
      "a-history-1",
      "message.assistant",
      "early reply",
      "2026-02-22T10:00:01.000Z",
    );
    const captureCommand = makeLocalEvent(
      "u-capture-tail",
      "message.user",
      "::capture /tmp/capture-from-twin.md",
      "2026-02-22T10:00:02.000Z",
    );
    const fullConversation = [
      firstUserMessage,
      firstAssistantMessage,
      captureCommand,
    ];

    const metadata = await sessionStateStore.getOrCreateSessionMetadata({
      provider,
      providerSessionId,
      sourceFilePath: "/tmp/mock-source.jsonl",
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    const twinEvents = mapConversationEventsToTwin({
      provider,
      providerSessionId,
      sessionId: metadata.sessionId,
      events: fullConversation,
      mode: "live",
      capturedAt: "2026-02-22T10:00:03.000Z",
    });
    await sessionStateStore.appendTwinEvents(metadata, twinEvents);

    sessionSnapshotStore.upsert({
      provider,
      sessionId: providerSessionId,
      cursor: { kind: "byte-offset", value: 3 },
      events: fullConversation,
    });

    const requests = [{
      requestId: "req-stop-capture-from-twin-start",
      requestedAt: "2026-02-22T10:00:05.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(requests.map((request) => ({ ...request })));
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    let capturedSummary: Array<{ kind: string; content?: string }> = [];
    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        throw new Error("not used");
      },
      captureSnapshot(input) {
        capturedSummary = input.events.map((event) => {
          if (
            event.kind === "message.user" ||
            event.kind === "message.assistant" ||
            event.kind === "message.system" ||
            event.kind === "thinking" ||
            event.kind === "provider.info"
          ) {
            return { kind: event.kind, content: event.content };
          }
          return { kind: event.kind };
        });
        return Promise.resolve({
          outputPath: input.targetPath,
          writeResult: {
            mode: "overwrite",
            outputPath: input.targetPath,
            wrote: true,
            deduped: false,
          },
          format: "markdown" as const,
        });
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      appendToDestination() {
        return Promise.resolve({
          mode: "append",
          outputPath: "/tmp/capture-from-twin.md",
          wrote: true,
          deduped: false,
        });
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    assertEquals(capturedSummary, [
      { kind: "message.user", content: "early context" },
      { kind: "message.assistant", content: "early reply" },
      { kind: "message.user", content: "::capture /tmp/capture-from-twin.md" },
    ]);
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop performs session twin cleanup at shutdown", async () => {
  let currentStatus: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-22T10:00:00.000Z",
    heartbeatAt: "2026-02-22T10:00:00.000Z",
    daemonRunning: false,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
  };
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        ...currentStatus,
        providers: [...currentStatus.providers],
        recordings: { ...currentStatus.recordings },
      });
    },
    save(snapshot) {
      currentStatus = {
        ...snapshot,
        providers: [...snapshot.providers],
        recordings: { ...snapshot.recordings },
      };
      return Promise.resolve();
    },
  };

  const requests = [{
    requestId: "req-stop-cleanup",
    requestedAt: "2026-02-22T10:00:00.000Z",
    command: "stop" as const,
  }];
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      return Promise.resolve(requests.map((request) => ({ ...request })));
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called");
    },
    markProcessed(requestId: string) {
      const idx = requests.findIndex((request) =>
        request.requestId === requestId
      );
      if (idx >= 0) {
        requests.splice(0, idx + 1);
      }
      return Promise.resolve();
    },
  };

  const callOrder: string[] = [];
  const sessionStateStore = {
    listSessionMetadata() {
      callOrder.push("list");
      return Promise.resolve([]);
    },
    deleteSessionTwinFiles() {
      callOrder.push("cleanup");
      return Promise.resolve({ deleted: 0, failed: 0 });
    },
  } as unknown as PersistentSessionStateStore;

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionStateStore,
    cleanSessionStatesOnShutdown: true,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 50,
    pollIntervalMs: 10,
  });

  assert(callOrder.length > 0);
  assertEquals(callOrder[0], "list");
  assert(callOrder.includes("cleanup"));
});

Deno.test("runDaemonRuntimeLoop caches session metadata lookups between refresh intervals", async () => {
  let metadataReads = 0;
  let controlPolls = 0;
  const statusStore: DaemonStatusSnapshotStoreLike = {
    load() {
      return Promise.resolve({
        schemaVersion: 1,
        generatedAt: "2026-02-22T10:00:00.000Z",
        heartbeatAt: "2026-02-22T10:00:00.000Z",
        daemonRunning: false,
        providers: [],
        recordings: { activeRecordings: 0, destinations: 0 },
      });
    },
    save(_snapshot) {
      return Promise.resolve();
    },
  };
  const controlStore: DaemonControlRequestStoreLike = {
    list() {
      controlPolls += 1;
      if (controlPolls >= 5) {
        return Promise.resolve([{
          requestId: "req-stop-cache-test",
          requestedAt: "2026-02-22T10:00:00.000Z",
          command: "stop" as const,
        }]);
      }
      return Promise.resolve([]);
    },
    enqueue(_request) {
      throw new Error("enqueue should not be called");
    },
    markProcessed(_requestId: string) {
      return Promise.resolve();
    },
  };
  const sessionStateStore = {
    listSessionMetadata() {
      metadataReads += 1;
      return Promise.resolve([]);
    },
  } as unknown as PersistentSessionStateStore;

  await runDaemonRuntimeLoop({
    statusStore,
    controlStore,
    sessionStateStore,
    now: () => new Date("2026-02-22T10:00:00.000Z"),
    pid: 4242,
    heartbeatIntervalMs: 1_000,
    pollIntervalMs: 1,
    sessionMetadataRefreshIntervalMs: 10_000,
  });

  assert(controlPolls >= 5);
  assertEquals(metadataReads, 3);
});

Deno.test("runDaemonRuntimeLoop treats ::stop with an argument as a parse error and leaves state unchanged", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-ambiguous-stop-");
  try {
    const sink = new CaptureSink();
    const operationalLogger = new StructuredLogger([sink], {
      channel: "operational",
      minLevel: "debug",
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const auditLogger = new AuditLogger(
      new StructuredLogger([sink], {
        channel: "security-audit",
        minLevel: "debug",
        now: () => new Date("2026-02-22T10:00:00.000Z"),
      }),
    );

    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
        };
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-ambiguous-stop-1234",
    });
    const metadata = await sessionStateStore.getOrCreateSessionMetadata({
      provider: "codex",
      providerSessionId: "session-ambiguous-stop",
      sourceFilePath: "/tmp/mock-session.jsonl",
      initialCursor: { kind: "byte-offset", value: 0 },
    });
    metadata.recordings = [
      {
        recordingId: "deadbeef-1111-1111-1111-111111111111",
        destination: "deadbeef",
        desiredState: "on",
        writeCursor: 0,
        periods: [{ startedCursor: 0 }],
      },
      {
        recordingId: "deadbeef-2222-2222-2222-222222222222",
        destination: "/tmp/other-destination.md",
        desiredState: "on",
        writeCursor: 0,
        periods: [{ startedCursor: 0 }],
      },
    ];
    await sessionStateStore.saveSessionMetadata(metadata);

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-ambiguous-stop",
            cursor: { kind: "byte-offset", value: 1 },
            events: [{
              eventId: "u-stop-ambiguous",
              provider: "codex",
              sessionId: "session-ambiguous-stop",
              timestamp: "2026-02-22T10:00:00.000Z",
              kind: "message.user",
              role: "user",
              content: "::stop deadbeef",
              source: {
                providerEventType: "user",
                providerEventId: "u-stop-ambiguous",
              },
            } as ConversationEvent],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop-ambiguous-case",
      requestedAt: "2026-02-22T10:00:02.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 2 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
      operationalLogger,
      auditLogger,
    });

    const after = await sessionStateStore.listSessionMetadata();
    const item = after.find((entry) =>
      entry.providerSessionId === "session-ambiguous-stop"
    );
    assertExists(item);
    assertEquals(
      item!.recordings.map((recording) => recording.desiredState),
      ["on", "on"],
    );
    assert(
      sink.records.some((record) =>
        record.event === "recording.command.parse_error" &&
        record.channel === "operational"
      ),
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop uses default destination for empty ::record", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-default-destination-");
  try {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
        };
        return Promise.resolve();
      },
    };

    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "defaultdest-session-abcdef12",
    });

    let pollCount = 0;
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-default-destination",
            cursor: { kind: "byte-offset", value: 1 },
            events: [{
              eventId: "u-start-default",
              provider: "codex",
              sessionId: "session-default-destination",
              timestamp: "2026-02-22T10:00:00.000Z",
              kind: "message.user",
              role: "user",
              content: "::record",
              source: {
                providerEventType: "user",
                providerEventId: "u-start-default",
              },
            } as ConversationEvent, {
              eventId: "a-default-1",
              provider: "codex",
              sessionId: "session-default-destination",
              timestamp: "2026-02-22T10:00:01.000Z",
              kind: "message.assistant",
              role: "assistant",
              content: "assistant output",
              source: {
                providerEventType: "assistant",
                providerEventId: "a-default-1",
              },
            } as ConversationEvent],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 2,
          });
        }
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop-default-destination",
      requestedAt: "2026-02-22T10:00:02.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 2 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      appendToDestination() {
        return Promise.resolve({
          mode: "append",
          outputPath: "/tmp/default-path.md",
          wrote: true,
          deduped: false,
        });
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    const metadata = await sessionStateStore.listSessionMetadata();
    const session = metadata.find((entry) =>
      entry.providerSessionId === "session-default-destination"
    );
    assertExists(session);
    const recording = session!.recordings[0];
    assertExists(recording);
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    const expectedRoot = home
      ? join(home, ".kato", "recordings")
      : join(".kato", "recordings");
    assert(
      recording!.destination.startsWith(expectedRoot),
      `expected recording destination to start with ${expectedRoot}, got ${
        recording!.destination
      }`,
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("runDaemonRuntimeLoop initializes missing session metadata from default cursor", async () => {
  const stateDir = await makeTestTempDir("daemon-runtime-default-cursor-");
  try {
    let currentStatus: DaemonStatusSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-02-22T10:00:00.000Z",
      heartbeatAt: "2026-02-22T10:00:00.000Z",
      daemonRunning: false,
      providers: [],
      recordings: { activeRecordings: 0, destinations: 0 },
    };
    const statusStore: DaemonStatusSnapshotStoreLike = {
      load() {
        return Promise.resolve({
          ...currentStatus,
          providers: [...currentStatus.providers],
          recordings: { ...currentStatus.recordings },
        });
      },
      save(snapshot) {
        currentStatus = {
          ...snapshot,
          providers: [...snapshot.providers],
          recordings: { ...snapshot.recordings },
        };
        return Promise.resolve();
      },
    };

    let pollCount = 0;
    const sessionSnapshotStore = new InMemorySessionSnapshotStore({
      now: () => new Date("2026-02-22T10:00:00.000Z"),
    });
    const sessionStateStore = new PersistentSessionStateStore({
      katoDir: join(stateDir, ".kato"),
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      makeSessionId: () => "kato-session-default-cursor-1234",
    });
    const ingestionRunner: ProviderIngestionRunner = {
      provider: "codex",
      start() {
        return Promise.resolve();
      },
      poll() {
        pollCount += 1;
        if (pollCount === 1) {
          sessionSnapshotStore.upsert({
            provider: "codex",
            sessionId: "session-default-cursor",
            cursor: { kind: "byte-offset", value: 42 },
            events: [makeEvent("a1", "message.assistant", "assistant-1")],
          });
          return Promise.resolve({
            provider: "codex",
            polledAt: "2026-02-22T10:00:00.000Z",
            sessionsUpdated: 1,
            eventsObserved: 1,
          });
        }
        return Promise.resolve({
          provider: "codex",
          polledAt: "2026-02-22T10:00:01.000Z",
          sessionsUpdated: 0,
          eventsObserved: 0,
        });
      },
      stop() {
        return Promise.resolve();
      },
    };

    const requests = [{
      requestId: "req-stop-default-cursor",
      requestedAt: "2026-02-22T10:00:02.000Z",
      command: "stop" as const,
    }];
    const controlStore: DaemonControlRequestStoreLike = {
      list() {
        return Promise.resolve(
          pollCount >= 2 ? requests.map((request) => ({ ...request })) : [],
        );
      },
      enqueue(_request) {
        throw new Error("enqueue should not be called");
      },
      markProcessed(requestId: string) {
        const idx = requests.findIndex((request) =>
          request.requestId === requestId
        );
        if (idx >= 0) {
          requests.splice(0, idx + 1);
        }
        return Promise.resolve();
      },
    };

    const recordingPipeline: RecordingPipelineLike = {
      activateRecording() {
        throw new Error("not used");
      },
      captureSnapshot() {
        throw new Error("not used");
      },
      exportSnapshot() {
        throw new Error("not used");
      },
      appendToActiveRecording() {
        return Promise.resolve({ appended: false, deduped: false });
      },
      stopRecording() {
        return true;
      },
      getActiveRecording() {
        return undefined;
      },
      listActiveRecordings() {
        return [];
      },
      getRecordingSummary() {
        return { activeRecordings: 0, destinations: 0 };
      },
    };

    await runDaemonRuntimeLoop({
      statusStore,
      controlStore,
      recordingPipeline,
      ingestionRunners: [ingestionRunner],
      sessionSnapshotStore,
      sessionStateStore,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 10,
    });

    const metadata = await sessionStateStore.listSessionMetadata();
    const session = metadata.find((entry) =>
      entry.providerSessionId === "session-default-cursor"
    );
    assertExists(session);
    assertEquals(session!.ingestCursor, { kind: "byte-offset", value: 0 });
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});
