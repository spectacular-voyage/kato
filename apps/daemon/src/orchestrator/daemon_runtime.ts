import type { Message } from "@kato/shared";
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

export interface DaemonRuntimeLoopOptions {
  statusStore?: DaemonStatusSnapshotStoreLike;
  controlStore?: DaemonControlRequestStoreLike;
  recordingPipeline?: RecordingPipelineLike;
  loadSessionSnapshot?: (
    sessionId: string,
  ) => Promise<{ provider: string; messages: Message[] }>;
  loadSessionMessages?: (sessionId: string) => Promise<Message[]>;
  exportEnabled?: boolean;
  now?: () => Date;
  pid?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

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

export async function runDaemonRuntimeLoop(
  options: DaemonRuntimeLoopOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? Deno.pid;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ??
    DEFAULT_HEARTBEAT_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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

  let shouldStop = false;
  let nextHeartbeatAt = now().getTime() + heartbeatIntervalMs;

  while (!shouldStop) {
    const requests = await controlStore.list();
    for (const request of requests) {
      shouldStop = await handleControlRequest({
        request,
        controlStore,
        recordingPipeline,
        loadSessionSnapshot: options.loadSessionSnapshot,
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
      snapshot = {
        ...snapshot,
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

  const exitIso = now().toISOString();
  snapshot = {
    ...snapshot,
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
  ) => Promise<{ provider: string; messages: Message[] }>;
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
      await operationalLogger.warn(
        "daemon.control.export.unhandled",
        "Export request skipped because session message loader is unavailable",
        {
          requestId: request.requestId,
          sessionId,
          outputPath,
        },
      );
    } else {
      try {
        let provider = "unknown";
        let messages: Message[];
        if (loadSessionSnapshot) {
          const snapshot = await loadSessionSnapshot(sessionId);
          provider = readString(snapshot.provider) ?? "unknown";
          messages = snapshot.messages;
        } else {
          messages = await loadSessionMessages!(sessionId);
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
