import type { Message, ProviderStatus } from "@kato/shared";
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
  if (!value) {
    return undefined;
  }

  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) {
    return undefined;
  }
  return timeMs;
}

interface SessionMessageProcessingState {
  seenMessageSignatures: Set<string>;
}

interface ProcessInChatRecordingUpdatesOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionMessageStates: Map<string, SessionMessageProcessingState>;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}

interface ApplyControlCommandsForMessageOptions {
  provider: string;
  sessionId: string;
  messages: Message[];
  messageIndex: number;
  message: Message;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}

function makeSessionProcessingKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function makeMessageSignature(message: Message): string {
  return [
    message.id,
    message.role,
    message.timestamp,
    message.model ?? "",
    message.content,
  ].join("\u0000");
}

function unwrapMatchingDelimiters(value: string): string {
  if (value.length < 2) {
    return value;
  }

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
  if (!rawArgument) {
    return undefined;
  }

  let normalized = rawArgument.trim();
  if (normalized.length === 0) {
    return undefined;
  }

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

async function applyControlCommandsForMessage(
  options: ApplyControlCommandsForMessageOptions,
): Promise<void> {
  const {
    provider,
    sessionId,
    messages,
    messageIndex,
    message,
    recordingPipeline,
    operationalLogger,
    auditLogger,
  } = options;

  if (message.role !== "user") {
    return;
  }

  const detection = detectInChatControlCommands(message.content);
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
        messageId: message.id,
        parseErrors,
      },
    );
    await auditLogger.record(
      "recording.command.parse_error",
      "In-chat control command parse error",
      {
        provider,
        sessionId,
        messageId: message.id,
        parseErrors,
      },
    );
    return;
  }

  const snapshotSlice = messages.slice(0, messageIndex + 1);

  for (const command of detection.commands) {
    const targetPath = normalizeCommandTargetPath(command.argument);

    if (command.name !== "stop" && !targetPath) {
      await operationalLogger.warn(
        "recording.command.invalid_target",
        "Skipping in-chat control command because target path is invalid",
        {
          provider,
          sessionId,
          messageId: message.id,
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
          messageId: message.id,
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
          seedMessages: snapshotSlice,
          title: sessionId,
        });
      } else if (command.name === "capture") {
        await recordingPipeline.captureSnapshot({
          provider,
          sessionId,
          targetPath: targetPath!,
          messages: snapshotSlice,
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
          messages: snapshotSlice,
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
          messageId: message.id,
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
          messageId: message.id,
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
          messageId: message.id,
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
          messageId: message.id,
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
    sessionMessageStates,
    recordingPipeline,
    operationalLogger,
    auditLogger,
  } = options;

  const snapshots = sessionSnapshotStore.list();
  const activeSessionKeys = new Set<string>();

  for (const snapshot of snapshots) {
    const provider = readString(snapshot.provider);
    const sessionId = readString(snapshot.sessionId);
    if (!provider || !sessionId) {
      continue;
    }

    const sessionKey = makeSessionProcessingKey(provider, sessionId);
    activeSessionKeys.add(sessionKey);

    const signatures = snapshot.messages.map(makeMessageSignature);
    const currentSignatureSet = new Set(signatures);

    const existingState = sessionMessageStates.get(sessionKey);
    if (!existingState) {
      sessionMessageStates.set(sessionKey, {
        seenMessageSignatures: currentSignatureSet,
      });
      continue;
    }

    for (
      const seenSignature of Array.from(existingState.seenMessageSignatures)
    ) {
      if (!currentSignatureSet.has(seenSignature)) {
        existingState.seenMessageSignatures.delete(seenSignature);
      }
    }

    for (let i = 0; i < snapshot.messages.length; i += 1) {
      const message = snapshot.messages[i];
      if (!message) {
        continue;
      }

      const signature = signatures[i] ?? makeMessageSignature(message);
      if (existingState.seenMessageSignatures.has(signature)) {
        continue;
      }
      existingState.seenMessageSignatures.add(signature);

      await applyControlCommandsForMessage({
        provider,
        sessionId,
        messages: snapshot.messages,
        messageIndex: i,
        message,
        recordingPipeline,
        operationalLogger,
        auditLogger,
      });

      try {
        await recordingPipeline.appendToActiveRecording({
          provider,
          sessionId,
          messages: [message],
          title: sessionId,
        });
      } catch (error) {
        await operationalLogger.error(
          "recording.append.failed",
          "Failed to append message to active recording",
          {
            provider,
            sessionId,
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        await auditLogger.record(
          "recording.append.failed",
          "Failed to append message to active recording",
          {
            provider,
            sessionId,
            messageId: message.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  for (const sessionKey of Array.from(sessionMessageStates.keys())) {
    if (!activeSessionKeys.has(sessionKey)) {
      sessionMessageStates.delete(sessionKey);
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
  const sessionMessageStates = new Map<string, SessionMessageProcessingState>();

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

    if (sessionSnapshotStore) {
      try {
        await processInChatRecordingUpdates({
          sessionSnapshotStore,
          sessionMessageStates,
          recordingPipeline,
          operationalLogger,
          auditLogger,
        });
      } catch (error) {
        await operationalLogger.error(
          "recording.command.processing_failed",
          "In-chat recording command processing failed",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        await auditLogger.record(
          "recording.command.processing_failed",
          "In-chat recording command processing failed",
          {
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
