import type { Message, ProviderStatus } from "@kato/shared";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import {
  resolveDefaultAllowedWriteRoots,
  WritePathPolicyGate,
} from "../policy/mod.ts";
import {
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
} from "./ingestion_runtime.ts";

interface SessionExportSnapshot {
  provider: string;
  messages: Message[];
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
  loadSessionMessages?: (sessionId: string) => Promise<Message[]>;
  exportEnabled?: boolean;
  now?: () => Date;
  pid?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  providerStatusStaleAfterMs?: number;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROVIDER_STATUS_STALE_AFTER_MS = 5 * 60_000;

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
  if (!value) {
    return undefined;
  }

  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) {
    return undefined;
  }
  return timeMs;
}

function toProviderStatuses(
  sessionSnapshots: RuntimeSessionSnapshot[],
  now: Date,
  staleAfterMs: number,
): ProviderStatus[] {
  const nowMs = now.getTime();
  const byProvider = new Map<
    string,
    { activeSessions: number; lastMessageAtMs?: number; lastMessageAt?: string }
  >();

  for (const snapshot of sessionSnapshots) {
    const provider = readString(snapshot.provider);
    if (!provider) {
      continue;
    }

    const updatedAtMs = readTimeMs(snapshot.metadata.updatedAt);
    if (updatedAtMs === undefined) {
      continue;
    }
    if (nowMs - updatedAtMs > staleAfterMs) {
      continue;
    }

    const current = byProvider.get(provider) ?? {
      activeSessions: 0,
    };
    current.activeSessions += 1;

    const lastMessageAt = snapshot.metadata.lastMessageAt;
    const lastMessageAtMs = readTimeMs(lastMessageAt);
    if (
      lastMessageAt &&
      lastMessageAtMs !== undefined &&
      (current.lastMessageAtMs === undefined ||
        lastMessageAtMs > current.lastMessageAtMs)
    ) {
      current.lastMessageAtMs = lastMessageAtMs;
      current.lastMessageAt = lastMessageAt;
    }

    byProvider.set(provider, current);
  }

  return Array.from(byProvider.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, status]) => ({
      provider,
      activeSessions: status.activeSessions,
      ...(status.lastMessageAt ? { lastMessageAt: status.lastMessageAt } : {}),
    }));
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
        if (!snapshot) {
          return Promise.resolve(undefined);
        }
        return Promise.resolve({
          provider: snapshot.provider,
          messages: snapshot.messages,
        });
      }
      : undefined);

  let snapshot = createDefaultStatusSnapshot(now());
  snapshot = {
    ...snapshot,
    daemonRunning: true,
    daemonPid: pid,
  };
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
  let nextHeartbeatAt = now().getTime() + heartbeatIntervalMs;

  while (!shouldStop) {
    for (const runner of ingestionRunners) {
      try {
        const result = await runner.poll();
        if (result.sessionsUpdated > 0 || result.messagesObserved > 0) {
          await operationalLogger.info(
            "provider.ingestion.poll",
            "Provider ingestion poll observed updates",
            {
              provider: result.provider,
              sessionsUpdated: result.sessionsUpdated,
              messagesObserved: result.messagesObserved,
              polledAt: result.polledAt,
            },
          );
        }
      } catch (error) {
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

    const requests = await controlStore.list();
    for (const request of requests) {
      shouldStop = await handleControlRequest({
        request,
        controlStore,
        recordingPipeline,
        loadSessionSnapshot,
        loadSessionMessages: options.loadSessionMessages,
        exportEnabled,
        operationalLogger,
        auditLogger,
      });
      if (shouldStop) {
        break;
      }
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
      const providers = sessionSnapshotStore
        ? toProviderStatuses(
          sessionSnapshotStore.list(),
          now(),
          providerStatusStaleAfterMs,
        )
        : snapshot.providers;
      snapshot = {
        ...snapshot,
        providers,
        generatedAt: currentIso,
        heartbeatAt: currentIso,
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
  const providers = sessionSnapshotStore
    ? toProviderStatuses(
      sessionSnapshotStore.list(),
      now(),
      providerStatusStaleAfterMs,
    )
    : snapshot.providers;
  snapshot = {
    ...snapshot,
    providers,
    generatedAt: exitIso,
    heartbeatAt: exitIso,
    daemonRunning: false,
  };
  delete snapshot.daemonPid;
  await statusStore.save(snapshot);

  await operationalLogger.info(
    "daemon.runtime.stopped",
    "Daemon runtime loop stopped",
    { pid },
  );
}

interface HandleControlRequestOptions {
  request: DaemonControlRequest;
  controlStore: DaemonControlRequestStoreLike;
  recordingPipeline: RecordingPipelineLike;
  loadSessionSnapshot?: (
    sessionId: string,
  ) => Promise<SessionExportSnapshot | undefined>;
  loadSessionMessages?: (sessionId: string) => Promise<Message[]>;
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
    loadSessionMessages,
    exportEnabled,
    operationalLogger,
    auditLogger,
  } = options;

  await operationalLogger.info(
    "daemon.control.received",
    "Daemon runtime received control request",
    {
      requestId: request.requestId,
      command: request.command,
    },
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
        {
          requestId: request.requestId,
        },
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

    if (!sessionId || !outputPath) {
      await operationalLogger.warn(
        "daemon.control.export.invalid",
        "Export request payload is missing required fields",
        {
          requestId: request.requestId,
          payload,
        },
      );
    } else if (!loadSessionSnapshot && !loadSessionMessages) {
      // Step 4 wiring: export requests are deferred until provider ingestion
      // supplies a session message loader in the daemon runtime.
      await warnExportSkipped(
        "daemon.control.export.unhandled",
        "Export request skipped because session message loader is unavailable",
        { requestId: request.requestId, sessionId, outputPath },
        operationalLogger,
        auditLogger,
      );
    } else {
      try {
        let provider: string;
        let messages: Message[];
        if (loadSessionSnapshot) {
          const snapshot = await loadSessionSnapshot(sessionId);
          if (!snapshot) {
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

          const snapshotProvider = readString(snapshot.provider);
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

          provider = snapshotProvider;
          messages = snapshot.messages;
        } else {
          provider = "unknown";
          messages = await loadSessionMessages!(sessionId);
          await warnExportSkipped(
            "daemon.control.export.legacy_loader",
            "Export request used legacy message loader without provider identity",
            { requestId: request.requestId, sessionId, outputPath },
            operationalLogger,
            auditLogger,
          );
        }

        if (messages.length === 0) {
          await warnExportSkipped(
            "daemon.control.export.empty",
            "Export request skipped because session snapshot had no messages",
            { requestId: request.requestId, sessionId, outputPath, provider },
            operationalLogger,
            auditLogger,
          );
          await controlStore.markProcessed(request.requestId);
          return false;
        }

        await recordingPipeline.exportSnapshot({
          provider,
          sessionId,
          targetPath: outputPath,
          messages,
          title: sessionId,
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
