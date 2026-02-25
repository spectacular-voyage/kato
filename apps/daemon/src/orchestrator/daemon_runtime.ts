import type {
  ConversationEvent,
  DaemonSessionStatus,
  ProviderStatus,
} from "@kato/shared";
import { projectSessionStatus, sortSessionsByRecency } from "@kato/shared";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import {
  detectInChatControlCommands,
  resolveDefaultAllowedWriteRoots,
  WritePathPolicyGate,
} from "../policy/mod.ts";
import {
  type ActiveRecording,
  RecordingPipeline,
  type RecordingPipelineLike,
} from "../writer/mod.ts";
import {
  createDefaultStatusSnapshot,
  type DaemonControlRequest,
  DaemonControlRequestFileStore,
  type DaemonControlRequestStoreLike,
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  resolveDefaultControlPath,
  resolveDefaultStatusPath,
} from "./control_plane.ts";
import type {
  ProviderIngestionRunner,
  RuntimeSessionSnapshot,
  SessionSnapshotStore,
  SnapshotMemoryStats,
} from "./ingestion_runtime.ts";
import { SessionSnapshotMemoryBudgetExceededError } from "./ingestion_runtime.ts";

interface SessionExportSnapshot {
  provider: string;
  events: ConversationEvent[];
}

export interface DaemonRuntimeLoopOptions {
  statusStore?: DaemonStatusSnapshotStoreLike;
  controlStore?: DaemonControlRequestStoreLike;
  recordingPipeline?: RecordingPipelineLike;
  ingestionRunners?: ProviderIngestionRunner[];
  sessionSnapshotStore?: SessionSnapshotStore;
  loadSessionSnapshot?: (
    sessionId: string,
  ) => Promise<SessionExportSnapshot | undefined>;
  exportEnabled?: boolean;
  now?: () => Date;
  pid?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  providerStatusStaleAfterMs?: number;
  daemonMaxMemoryMb?: number;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROVIDER_STATUS_STALE_AFTER_MS = 5 * 60_000;
const MARKDOWN_LINK_PATH_PATTERN = /^\[[^\]]+\]\((.+)\)$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeDefaultOperationalLogger(now: () => Date): StructuredLogger {
  return new StructuredLogger([new NoopSink()], {
    channel: "operational",
    minLevel: "info",
    now,
  });
}

function makeDefaultAuditLogger(now: () => Date): AuditLogger {
  return new AuditLogger(
    new StructuredLogger([new NoopSink()], {
      channel: "security-audit",
      minLevel: "info",
      now,
    }),
  );
}

function readTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) return undefined;
  return timeMs;
}

interface SessionEventProcessingState {
  seenEventSignatures: Set<string>;
}

interface ProcessInChatRecordingUpdatesOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionEventStates: Map<string, SessionEventProcessingState>;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}

interface ApplyControlCommandsForEventOptions {
  provider: string;
  sessionId: string;
  events: ConversationEvent[];
  eventIndex: number;
  event: ConversationEvent & { kind: "message.user" };
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}

function makeSessionProcessingKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function makeRuntimeEventSignature(event: ConversationEvent): string {
  const base = `${event.kind}\0${event.source.providerEventType}\0${event.source.providerEventId ?? ""
    }\0${event.timestamp}`;
  switch (event.kind) {
    case "message.user":
    case "message.assistant":
    case "message.system":
      return `${base}\0${event.content}`;
    case "tool.call":
      return `${base}\0${event.toolCallId}\0${event.name}\0${event.description ?? ""
        }\0${event.input !== undefined ? JSON.stringify(event.input) : ""}`;
    case "tool.result":
      return `${base}\0${event.toolCallId}\0${event.result}`;
    case "thinking":
      return `${base}\0${event.content}`;
    case "decision":
      return `${base}\0${event.decisionId}`;
    case "provider.info":
      return `${base}\0${event.content}`;
    default:
      return base;
  }
}

function unwrapMatchingDelimiters(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "`" && last === "`")
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function normalizeCommandTargetPath(
  rawArgument: string | undefined,
): string | undefined {
  if (!rawArgument) return undefined;

  let normalized = rawArgument.trim();
  if (normalized.length === 0) return undefined;

  const markdownMatch = normalized.match(MARKDOWN_LINK_PATH_PATTERN);
  if (markdownMatch?.[1]) {
    normalized = markdownMatch[1].trim();
  }

  normalized = unwrapMatchingDelimiters(normalized);
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1).trim();
  }
  normalized = unwrapMatchingDelimiters(normalized);

  return normalized.length > 0 ? normalized : undefined;
}

async function applyControlCommandsForEvent(
  options: ApplyControlCommandsForEventOptions,
): Promise<void> {
  const {
    provider,
    sessionId,
    events,
    eventIndex,
    event,
    recordingPipeline,
    operationalLogger,
    auditLogger,
  } = options;

  const detection = detectInChatControlCommands(event.content);
  if (detection.commands.length === 0 && detection.errors.length === 0) {
    return;
  }

  if (detection.errors.length > 0) {
    const parseErrors = detection.errors.map((error) => ({
      line: error.line,
      reason: error.reason,
    }));
    await operationalLogger.warn(
      "recording.command.parse_error",
      "Skipping in-chat control commands because at least one command line is invalid",
      {
        provider,
        sessionId,
        eventId: event.eventId,
        parseErrors,
      },
    );
    await auditLogger.record(
      "recording.command.parse_error",
      "In-chat control command parse error",
      {
        provider,
        sessionId,
        eventId: event.eventId,
        parseErrors,
      },
    );
    return;
  }

  const snapshotSlice = events.slice(0, eventIndex + 1);

  for (const command of detection.commands) {
    const targetPath = normalizeCommandTargetPath(command.argument);

    if (command.name !== "stop" && !targetPath) {
      await operationalLogger.warn(
        "recording.command.invalid_target",
        "Skipping in-chat control command because target path is invalid",
        {
          provider,
          sessionId,
          eventId: event.eventId,
          command: command.name,
          rawArgument: command.argument,
        },
      );
      await auditLogger.record(
        "recording.command.invalid_target",
        "In-chat control command target path invalid",
        {
          provider,
          sessionId,
          eventId: event.eventId,
          command: command.name,
          rawArgument: command.argument,
        },
      );
      continue;
    }

    try {
      if (command.name === "record") {
        await recordingPipeline.startOrRotateRecording({
          provider,
          sessionId,
          targetPath: targetPath!,
          seedEvents: snapshotSlice,
          title: sessionId,
        });
      } else if (command.name === "capture") {
        await recordingPipeline.captureSnapshot({
          provider,
          sessionId,
          targetPath: targetPath!,
          events: snapshotSlice,
          title: sessionId,
        });
        await recordingPipeline.startOrRotateRecording({
          provider,
          sessionId,
          targetPath: targetPath!,
          title: sessionId,
        });
      } else if (command.name === "export") {
        await recordingPipeline.exportSnapshot({
          provider,
          sessionId,
          targetPath: targetPath!,
          events: snapshotSlice,
          title: sessionId,
        });
      } else {
        recordingPipeline.stopRecording(provider, sessionId);
      }

      await operationalLogger.info(
        "recording.command.applied",
        "Applied in-chat control command",
        {
          provider,
          sessionId,
          eventId: event.eventId,
          command: command.name,
          ...(targetPath ? { targetPath } : {}),
        },
      );
      await auditLogger.record(
        "recording.command.applied",
        "In-chat control command applied",
        {
          provider,
          sessionId,
          eventId: event.eventId,
          command: command.name,
          ...(targetPath ? { targetPath } : {}),
        },
      );
    } catch (error) {
      await operationalLogger.error(
        "recording.command.failed",
        "Failed to apply in-chat control command",
        {
          provider,
          sessionId,
          eventId: event.eventId,
          command: command.name,
          ...(targetPath ? { targetPath } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await auditLogger.record(
        "recording.command.failed",
        "In-chat control command failed",
        {
          provider,
          sessionId,
          eventId: event.eventId,
          command: command.name,
          ...(targetPath ? { targetPath } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

async function processInChatRecordingUpdates(
  options: ProcessInChatRecordingUpdatesOptions,
): Promise<void> {
  const {
    sessionSnapshotStore,
    sessionEventStates,
    recordingPipeline,
    operationalLogger,
    auditLogger,
  } = options;

  const snapshots = sessionSnapshotStore.list();
  const activeSessionKeys = new Set<string>();

  for (const snapshot of snapshots) {
    const provider = readString(snapshot.provider);
    const sessionId = readString(snapshot.sessionId);
    if (!provider || !sessionId) continue;

    const sessionKey = makeSessionProcessingKey(provider, sessionId);
    activeSessionKeys.add(sessionKey);

    const signatures = snapshot.events.map(makeRuntimeEventSignature);
    const currentSignatureSet = new Set(signatures);

    const existingState = sessionEventStates.get(sessionKey);
    if (!existingState) {
      sessionEventStates.set(sessionKey, {
        seenEventSignatures: currentSignatureSet,
      });
      continue;
    }

    for (const seenSignature of Array.from(existingState.seenEventSignatures)) {
      if (!currentSignatureSet.has(seenSignature)) {
        existingState.seenEventSignatures.delete(seenSignature);
      }
    }

    for (let i = 0; i < snapshot.events.length; i += 1) {
      const event = snapshot.events[i];
      if (!event) continue;

      const signature = signatures[i] ?? makeRuntimeEventSignature(event);
      if (existingState.seenEventSignatures.has(signature)) continue;
      existingState.seenEventSignatures.add(signature);

      // Only apply control commands from message.user events.
      if (event.kind === "message.user") {
        await applyControlCommandsForEvent({
          provider,
          sessionId,
          events: snapshot.events,
          eventIndex: i,
          event: event as ConversationEvent & { kind: "message.user" },
          recordingPipeline,
          operationalLogger,
          auditLogger,
        });
      }

      try {
        await recordingPipeline.appendToActiveRecording({
          provider,
          sessionId,
          events: [event],
          title: sessionId,
        });
      } catch (error) {
        await operationalLogger.error(
          "recording.append.failed",
          "Failed to append event to active recording",
          {
            provider,
            sessionId,
            eventId: event.eventId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        await auditLogger.record(
          "recording.append.failed",
          "Failed to append event to active recording",
          {
            provider,
            sessionId,
            eventId: event.eventId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  for (const sessionKey of Array.from(sessionEventStates.keys())) {
    if (!activeSessionKeys.has(sessionKey)) {
      sessionEventStates.delete(sessionKey);
    }
  }
}

function toProviderStatuses(
  sessionSnapshots: RuntimeSessionSnapshot[],
  now: Date,
  staleAfterMs: number,
): ProviderStatus[] {
  const nowMs = now.getTime();
  const byProvider = new Map<
    string,
    { activeSessions: number; lastEventAtMs?: number; lastEventAt?: string }
  >();

  for (const snapshot of sessionSnapshots) {
    const provider = readString(snapshot.provider);
    if (!provider) continue;

    const updatedAtMs = readTimeMs(snapshot.metadata.updatedAt);
    if (updatedAtMs === undefined) continue;
    if (nowMs - updatedAtMs > staleAfterMs) continue;

    const current = byProvider.get(provider) ?? { activeSessions: 0 };
    current.activeSessions += 1;

    const lastEventAt = snapshot.metadata.lastEventAt;
    const lastEventAtMs = readTimeMs(lastEventAt);
    if (
      lastEventAt &&
      lastEventAtMs !== undefined &&
      (current.lastEventAtMs === undefined ||
        lastEventAtMs > current.lastEventAtMs)
    ) {
      current.lastEventAtMs = lastEventAtMs;
      current.lastEventAt = lastEventAt;
    }

    byProvider.set(provider, current);
  }

  return Array.from(byProvider.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, status]) => ({
      provider,
      activeSessions: status.activeSessions,
      ...(status.lastEventAt ? { lastMessageAt: status.lastEventAt } : {}),
    }));
}

function toSessionStatuses(
  sessionSnapshots: RuntimeSessionSnapshot[],
  activeRecordings: ActiveRecording[],
  now: Date,
  staleAfterMs: number,
): DaemonSessionStatus[] {
  const recordingByKey = new Map<string, ActiveRecording>();
  for (const rec of activeRecordings) {
    recordingByKey.set(makeSessionProcessingKey(rec.provider, rec.sessionId), rec);
  }

  const statuses = sessionSnapshots.map((snap) => {
    const rec = recordingByKey.get(
      makeSessionProcessingKey(snap.provider, snap.sessionId),
    );
    return projectSessionStatus({
      session: {
        provider: snap.provider,
        sessionId: snap.sessionId,
        updatedAt: snap.metadata.updatedAt,
        lastEventAt: snap.metadata.lastEventAt,
        fileModifiedAtMs: snap.metadata.fileModifiedAtMs,
        events: snap.events,
      },
      recording: rec
        ? {
          provider: rec.provider,
          sessionId: rec.sessionId,
          outputPath: rec.outputPath,
          startedAt: rec.startedAt,
          lastWriteAt: rec.lastWriteAt,
        }
        : undefined,
      now,
      staleAfterMs,
    });
  });

  return sortSessionsByRecency(statuses);
}

function emptySnapshotMemoryStats(): SnapshotMemoryStats {
  return {
    estimatedBytes: 0,
    sessionCount: 0,
    eventCount: 0,
    evictionsTotal: 0,
    bytesReclaimedTotal: 0,
    evictionsByReason: {},
    overBudget: false,
  };
}

function cloneSnapshotMemoryStats(
  stats: SnapshotMemoryStats,
): SnapshotMemoryStats {
  return {
    estimatedBytes: stats.estimatedBytes,
    sessionCount: stats.sessionCount,
    eventCount: stats.eventCount,
    evictionsTotal: stats.evictionsTotal,
    bytesReclaimedTotal: stats.bytesReclaimedTotal,
    evictionsByReason: { ...stats.evictionsByReason },
    overBudget: stats.overBudget,
  };
}

function hasSnapshotMemoryChanged(
  previous: SnapshotMemoryStats | undefined,
  current: SnapshotMemoryStats,
): boolean {
  if (!previous) {
    return true;
  }
  if (
    previous.estimatedBytes !== current.estimatedBytes ||
    previous.sessionCount !== current.sessionCount ||
    previous.eventCount !== current.eventCount ||
    previous.evictionsTotal !== current.evictionsTotal ||
    previous.bytesReclaimedTotal !== current.bytesReclaimedTotal ||
    previous.overBudget !== current.overBudget
  ) {
    return true;
  }

  const previousEntries = Object.entries(previous.evictionsByReason);
  const currentEntries = Object.entries(current.evictionsByReason);
  if (previousEntries.length !== currentEntries.length) {
    return true;
  }
  for (const [reason, value] of currentEntries) {
    if ((previous.evictionsByReason[reason] ?? 0) !== value) {
      return true;
    }
  }

  return false;
}

function computeSnapshotEvictionDelta(
  previous: SnapshotMemoryStats | undefined,
  current: SnapshotMemoryStats,
): {
  evictionsTotal: number;
  bytesReclaimedTotal: number;
  evictionsByReason: Record<string, number>;
} {
  const previousEvictionsTotal = previous?.evictionsTotal ?? 0;
  const previousBytesReclaimedTotal = previous?.bytesReclaimedTotal ?? 0;
  const evictionsByReason: Record<string, number> = {};

  for (const [reason, count] of Object.entries(current.evictionsByReason)) {
    const priorCount = previous?.evictionsByReason[reason] ?? 0;
    if (count > priorCount) {
      evictionsByReason[reason] = count - priorCount;
    }
  }

  return {
    evictionsTotal: Math.max(
      0,
      current.evictionsTotal - previousEvictionsTotal,
    ),
    bytesReclaimedTotal: Math.max(
      0,
      current.bytesReclaimedTotal - previousBytesReclaimedTotal,
    ),
    evictionsByReason,
  };
}

async function logMemoryTelemetry(options: {
  operationalLogger: StructuredLogger;
  daemonMaxMemoryBytes: number;
  processMemory: Deno.MemoryUsage;
  snapshotMemory: SnapshotMemoryStats;
  previousSnapshotMemory?: SnapshotMemoryStats;
  phase: "heartbeat" | "shutdown";
  forceSampleLog?: boolean;
}): Promise<SnapshotMemoryStats> {
  const {
    operationalLogger,
    daemonMaxMemoryBytes,
    processMemory,
    snapshotMemory,
    previousSnapshotMemory,
    phase,
    forceSampleLog = false,
  } = options;

  if (
    forceSampleLog ||
    hasSnapshotMemoryChanged(previousSnapshotMemory, snapshotMemory)
  ) {
    await operationalLogger.debug(
      "daemon.memory.sample",
      "Daemon memory sample updated",
      {
        phase,
        daemonMaxMemoryBytes,
        process: {
          rss: processMemory.rss,
          heapTotal: processMemory.heapTotal,
          heapUsed: processMemory.heapUsed,
          external: processMemory.external,
        },
        snapshots: snapshotMemory,
      },
    );
  }

  const evictionDelta = computeSnapshotEvictionDelta(
    previousSnapshotMemory,
    snapshotMemory,
  );
  if (evictionDelta.evictionsTotal > 0) {
    await operationalLogger.info(
      "daemon.memory.evicted",
      "Daemon snapshot store evicted sessions",
      {
        phase,
        evictions: evictionDelta.evictionsTotal,
        bytesReclaimed: evictionDelta.bytesReclaimedTotal,
        evictionsByReason: evictionDelta.evictionsByReason,
        snapshotSessionCount: snapshotMemory.sessionCount,
        snapshotEstimatedBytes: snapshotMemory.estimatedBytes,
      },
    );
  }

  return cloneSnapshotMemoryStats(snapshotMemory);
}

export async function runDaemonRuntimeLoop(
  options: DaemonRuntimeLoopOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? Deno.pid;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ??
    DEFAULT_HEARTBEAT_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const providerStatusStaleAfterMs = options.providerStatusStaleAfterMs ??
    DEFAULT_PROVIDER_STATUS_STALE_AFTER_MS;
  const exportEnabled = options.exportEnabled ?? true;
  const daemonMaxMemoryBytes = (options.daemonMaxMemoryMb ?? 200) * 1024 *
    1024;

  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(resolveDefaultStatusPath(), now);
  const controlStore = options.controlStore ??
    new DaemonControlRequestFileStore(resolveDefaultControlPath(), now);
  const operationalLogger = options.operationalLogger ??
    makeDefaultOperationalLogger(now);
  const auditLogger = options.auditLogger ?? makeDefaultAuditLogger(now);
  const recordingPipeline = options.recordingPipeline ??
    new RecordingPipeline({
      pathPolicyGate: new WritePathPolicyGate({
        allowedRoots: resolveDefaultAllowedWriteRoots(),
      }),
      now,
      operationalLogger,
      auditLogger,
    });
  const ingestionRunners = options.ingestionRunners ?? [];
  const sessionSnapshotStore = options.sessionSnapshotStore;
  const loadSessionSnapshot = options.loadSessionSnapshot ??
    (sessionSnapshotStore
      ? (sessionId: string) => {
        const snapshot = sessionSnapshotStore.get(sessionId);
        if (!snapshot) return Promise.resolve(undefined);
        return Promise.resolve({
          provider: snapshot.provider,
          events: snapshot.events,
        });
      }
      : undefined);

  let snapshot = createDefaultStatusSnapshot(now());
  snapshot = { ...snapshot, daemonRunning: true, daemonPid: pid };
  await statusStore.save(snapshot);

  await operationalLogger.info(
    "daemon.runtime.started",
    "Daemon runtime loop started",
    { pid },
  );

  for (const runner of ingestionRunners) {
    try {
      await runner.start();
    } catch (error) {
      await operationalLogger.error(
        "provider.ingestion.start.failed",
        "Provider ingestion runner failed to start",
        {
          provider: runner.provider,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  let shouldStop = false;
  let fatalRuntimeError: Error | undefined;
  let nextHeartbeatAt = now().getTime() + heartbeatIntervalMs;
  const sessionEventStates = new Map<string, SessionEventProcessingState>();
  let previousSnapshotMemory: SnapshotMemoryStats | undefined;

  while (!shouldStop) {
    for (const runner of ingestionRunners) {
      try {
        const result = await runner.poll();
        if (result.sessionsUpdated > 0 || result.eventsObserved > 0) {
          await operationalLogger.debug(
            "provider.ingestion.poll",
            "Provider ingestion poll observed updates",
            {
              provider: result.provider,
              sessionsUpdated: result.sessionsUpdated,
              eventsObserved: result.eventsObserved,
              polledAt: result.polledAt,
            },
          );
        }
      } catch (error) {
        if (error instanceof SessionSnapshotMemoryBudgetExceededError) {
          fatalRuntimeError = error;
          shouldStop = true;
          await operationalLogger.error(
            "daemon.memory_budget.exceeded",
            "Daemon memory budget exceeded by single session",
            {
              provider: runner.provider,
              sessionId: error.sessionId,
              estimatedBytes: error.estimatedBytes,
              daemonMaxMemoryBytes: error.daemonMaxMemoryBytes,
              error: error.message,
            },
          );
          await auditLogger.record(
            "daemon.memory_budget.exceeded",
            "Daemon memory budget exceeded by single session",
            {
              provider: runner.provider,
              sessionId: error.sessionId,
              estimatedBytes: error.estimatedBytes,
              daemonMaxMemoryBytes: error.daemonMaxMemoryBytes,
              error: error.message,
            },
          );
          break;
        }
        await operationalLogger.error(
          "provider.ingestion.poll.failed",
          "Provider ingestion runner poll failed",
          {
            provider: runner.provider,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    if (shouldStop) {
      break;
    }

    if (sessionSnapshotStore) {
      try {
        await processInChatRecordingUpdates({
          sessionSnapshotStore,
          sessionEventStates,
          recordingPipeline,
          operationalLogger,
          auditLogger,
        });
      } catch (error) {
        await operationalLogger.error(
          "recording.command.processing_failed",
          "In-chat recording command processing failed",
          { error: error instanceof Error ? error.message : String(error) },
        );
        await auditLogger.record(
          "recording.command.processing_failed",
          "In-chat recording command processing failed",
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    const requests = await controlStore.list();
    for (const request of requests) {
      shouldStop = await handleControlRequest({
        request,
        controlStore,
        recordingPipeline,
        loadSessionSnapshot,
        exportEnabled,
        operationalLogger,
        auditLogger,
      });
      if (shouldStop) break;
    }

    const recordingSummary = recordingPipeline.getRecordingSummary();
    snapshot = {
      ...snapshot,
      recordings: {
        activeRecordings: recordingSummary.activeRecordings,
        destinations: recordingSummary.destinations,
      },
    };

    const currentTimeMs = now().getTime();
    if (currentTimeMs >= nextHeartbeatAt) {
      const currentIso = now().toISOString();
      const heartbeatNow = now();
      const sessionList = sessionSnapshotStore?.list() ?? [];
      const providers = sessionSnapshotStore
        ? toProviderStatuses(
          sessionList,
          heartbeatNow,
          providerStatusStaleAfterMs,
        )
        : snapshot.providers;
      const sessions = sessionSnapshotStore
        ? toSessionStatuses(
          sessionList,
          recordingPipeline.listActiveRecordings(),
          heartbeatNow,
          providerStatusStaleAfterMs,
        )
        : snapshot.sessions;

      const processMemory = Deno.memoryUsage();
      const snapshotMemory = sessionSnapshotStore?.getMemoryStats?.() ??
        emptySnapshotMemoryStats();
      previousSnapshotMemory = await logMemoryTelemetry({
        operationalLogger,
        daemonMaxMemoryBytes,
        processMemory,
        snapshotMemory,
        previousSnapshotMemory,
        phase: "heartbeat",
      });

      snapshot = {
        ...snapshot,
        providers,
        sessions,
        generatedAt: currentIso,
        heartbeatAt: currentIso,
        memory: {
          daemonMaxMemoryBytes,
          process: {
            rss: processMemory.rss,
            heapTotal: processMemory.heapTotal,
            heapUsed: processMemory.heapUsed,
            external: processMemory.external,
          },
          snapshots: snapshotMemory,
        },
      };
      await statusStore.save(snapshot);
      nextHeartbeatAt = currentTimeMs + heartbeatIntervalMs;
    }

    if (!shouldStop) {
      await sleep(pollIntervalMs);
    }
  }

  for (const runner of ingestionRunners) {
    try {
      await runner.stop();
    } catch (error) {
      await operationalLogger.error(
        "provider.ingestion.stop.failed",
        "Provider ingestion runner failed to stop cleanly",
        {
          provider: runner.provider,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  const exitIso = now().toISOString();
  const exitNow = now();
  const exitSessionList = sessionSnapshotStore?.list() ?? [];
  const providers = sessionSnapshotStore
    ? toProviderStatuses(
      exitSessionList,
      exitNow,
      providerStatusStaleAfterMs,
    )
    : snapshot.providers;
  const sessions = sessionSnapshotStore
    ? toSessionStatuses(
      exitSessionList,
      recordingPipeline.listActiveRecordings(),
      exitNow,
      providerStatusStaleAfterMs,
    )
    : snapshot.sessions;

  const processMemory = Deno.memoryUsage();
  const snapshotMemory = sessionSnapshotStore?.getMemoryStats?.() ??
    emptySnapshotMemoryStats();
  previousSnapshotMemory = await logMemoryTelemetry({
    operationalLogger,
    daemonMaxMemoryBytes,
    processMemory,
    snapshotMemory,
    previousSnapshotMemory,
    phase: "shutdown",
    forceSampleLog: true,
  });

  snapshot = {
    ...snapshot,
    providers,
    sessions,
    generatedAt: exitIso,
    heartbeatAt: exitIso,
    daemonRunning: false,
    memory: {
      daemonMaxMemoryBytes,
      process: {
        rss: processMemory.rss,
        heapTotal: processMemory.heapTotal,
        heapUsed: processMemory.heapUsed,
        external: processMemory.external,
      },
      snapshots: snapshotMemory,
    },
  };
  delete snapshot.daemonPid;
  await statusStore.save(snapshot);

  await operationalLogger.info(
    "daemon.runtime.stopped",
    "Daemon runtime loop stopped",
    {
      pid,
      ...(fatalRuntimeError ? { fatalError: fatalRuntimeError.message } : {}),
    },
  );

  if (fatalRuntimeError) {
    throw fatalRuntimeError;
  }
}

interface HandleControlRequestOptions {
  request: DaemonControlRequest;
  controlStore: DaemonControlRequestStoreLike;
  recordingPipeline: RecordingPipelineLike;
  loadSessionSnapshot?: (
    sessionId: string,
  ) => Promise<SessionExportSnapshot | undefined>;
  exportEnabled: boolean;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function warnExportSkipped(
  event: string,
  message: string,
  details: {
    requestId: string;
    sessionId?: string;
    outputPath?: string;
    [key: string]: unknown;
  },
  operationalLogger: StructuredLogger,
  auditLogger: AuditLogger,
): Promise<void> {
  await operationalLogger.warn(event, message, details);
  await auditLogger.record(event, message, details);
}

async function handleControlRequest(
  options: HandleControlRequestOptions,
): Promise<boolean> {
  const {
    request,
    controlStore,
    recordingPipeline,
    loadSessionSnapshot,
    exportEnabled,
    operationalLogger,
    auditLogger,
  } = options;

  await operationalLogger.info(
    "daemon.control.received",
    "Daemon runtime received control request",
    { requestId: request.requestId, command: request.command },
  );

  await auditLogger.record(
    "daemon.control.received",
    "Daemon runtime consumed control request",
    {
      requestId: request.requestId,
      command: request.command,
      requestedAt: request.requestedAt,
    },
  );

  if (request.command === "export") {
    if (!exportEnabled) {
      await operationalLogger.warn(
        "daemon.control.export.disabled",
        "Export request skipped because feature flag is disabled",
        { requestId: request.requestId },
      );
      await controlStore.markProcessed(request.requestId);
      return false;
    }

    const payload = request.payload;
    const sessionId = isRecord(payload)
      ? readString(payload["sessionId"])
      : undefined;
    const outputPath = isRecord(payload)
      ? readString(payload["resolvedOutputPath"]) ??
      readString(payload["outputPath"])
      : undefined;
    const formatRaw = isRecord(payload)
      ? readString(payload["format"])
      : undefined;
    const format: "markdown" | "jsonl" | undefined =
      formatRaw === "markdown" || formatRaw === "jsonl" ? formatRaw : undefined;

    if (!sessionId || !outputPath) {
      await operationalLogger.warn(
        "daemon.control.export.invalid",
        "Export request payload is missing required fields",
        { requestId: request.requestId, payload },
      );
    } else if (!loadSessionSnapshot) {
      await warnExportSkipped(
        "daemon.control.export.unhandled",
        "Export request skipped because session snapshot loader is unavailable",
        { requestId: request.requestId, sessionId, outputPath },
        operationalLogger,
        auditLogger,
      );
    } else {
      try {
        const snapshotData = await loadSessionSnapshot(sessionId);
        if (!snapshotData) {
          await warnExportSkipped(
            "daemon.control.export.session_missing",
            "Export request skipped because session snapshot was not found",
            { requestId: request.requestId, sessionId, outputPath },
            operationalLogger,
            auditLogger,
          );
          await controlStore.markProcessed(request.requestId);
          return false;
        }

        const snapshotProvider = readString(snapshotData.provider);
        if (!snapshotProvider) {
          await warnExportSkipped(
            "daemon.control.export.invalid_snapshot",
            "Export request skipped because session snapshot provider is invalid",
            { requestId: request.requestId, sessionId, outputPath },
            operationalLogger,
            auditLogger,
          );
          await controlStore.markProcessed(request.requestId);
          return false;
        }

        if (snapshotData.events.length === 0) {
          await warnExportSkipped(
            "daemon.control.export.empty",
            "Export request skipped because session snapshot had no events",
            {
              requestId: request.requestId,
              sessionId,
              outputPath,
              provider: snapshotProvider,
            },
            operationalLogger,
            auditLogger,
          );
          await controlStore.markProcessed(request.requestId);
          return false;
        }

        await recordingPipeline.exportSnapshot({
          provider: snapshotProvider,
          sessionId,
          targetPath: outputPath,
          events: snapshotData.events,
          title: sessionId,
          ...(format ? { format } : {}),
        });
      } catch (error) {
        await operationalLogger.error(
          "daemon.control.export.failed",
          "Export request failed in daemon runtime",
          {
            requestId: request.requestId,
            sessionId,
            outputPath,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  await controlStore.markProcessed(request.requestId);

  if (request.command === "stop") {
    return true;
  }

  return false;
}
