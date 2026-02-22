import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
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

  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(resolveDefaultStatusPath(), now);
  const controlStore = options.controlStore ??
    new DaemonControlRequestFileStore(resolveDefaultControlPath(), now);

  const operationalLogger = options.operationalLogger ??
    makeDefaultOperationalLogger(now);
  const auditLogger = options.auditLogger ?? makeDefaultAuditLogger(now);

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
        now,
        controlStore,
        operationalLogger,
        auditLogger,
      });
      if (shouldStop) {
        break;
      }
    }

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
  now: () => Date;
  controlStore: DaemonControlRequestStoreLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}

async function handleControlRequest(
  options: HandleControlRequestOptions,
): Promise<boolean> {
  const {
    request,
    controlStore,
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

  await controlStore.markProcessed(request.requestId);

  if (request.command === "stop") {
    return true;
  }

  return false;
}
