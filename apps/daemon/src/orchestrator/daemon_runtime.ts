import type {
  ConversationEvent,
  DaemonFeatureFlags,
  MarkdownFrontmatterConfig,
  SecretsPolicyConfig,
  SessionMetadataV1,
  UserConfig,
} from "@kato/shared";
import { extractSnippet } from "@kato/shared";
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
  type RecordingOutputOverrides,
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
import {
  makeDefaultSessionCursor,
  type PersistentSessionStateStore,
} from "./session_state_store.ts";
import { loadPersistedSessionHistoryEvents } from "./provider_source_replay.ts";
import {
  summarizeRecordingStatus,
  toActiveRecordingsFromMetadata,
  toProviderStatuses,
  toSessionStatuses,
} from "./runtime_status_projection.ts";
import {
  handleExportControlRequest,
  type SessionExportSnapshot,
} from "./runtime_export_request.ts";
import {
  emptySnapshotMemoryStats,
  logMemoryTelemetry,
} from "./runtime_memory_telemetry.ts";
import { resolveWorkspaceDefaultOutputDir } from "./runtime_workspace_paths.ts";
import {
  activeWorkspaceOutputs,
  applyWorkspaceProfileSnapshot,
  closeWorkspaceOutputCycle,
  createWorkspaceOutputState,
  findWorkspaceOutput,
  openWorkspaceOutputCycle,
  readWorkspaceOutputs,
  resolveBindingForRetargetedWorkspacePath,
  stopAllWorkspaceOutputs,
  updateWorkspaceOutputCycleLastWrite,
} from "./runtime_workspace_output_state.ts";
import {
  type FirstSeenSourceFileFreshnessBasis,
  isFirstSeenProviderSessionUserEventEligible,
  resolveFirstSeenProviderSessionCommandCursor,
  resolveFirstSeenSourceFileFreshness,
} from "./runtime_first_seen.ts";
import {
  buildBoundarySnapshotEvents,
  buildCommandCursorAnchor,
  buildCommandSeedEvents,
  commandCursorAnchorEquals,
  readCommandCursor,
  readCommandCursorAnchor,
  resolveCommandBoundaries,
  resolveCommandStartCursor,
  writeCommandCursor,
} from "./runtime_command_state.ts";
import {
  resolveUniqueNonExistingPath,
  resolveWorkspaceCommandDestination,
  validateDestinationPathForCommand,
} from "./runtime_command_destination.ts";
import {
  createDefaultWorkspaceMarkdownFrontmatterConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  DEFAULT_WORKSPACE_TIMEZONE,
  loadWorkspaceConfigOverrides,
  resolveDefaultWorkspaceRegistryPath,
  type ResolvedWorkspaceProfile,
  WorkspaceCatalog,
  type WorkspaceCatalogLike,
  WorkspaceProfileResolver,
  type WorkspaceProfileResolverLike,
  WorkspaceRegistryFileStore,
} from "../workspace/mod.ts";
import {
  createDefaultUserConfig,
  resolveFrontmatterParticipantUsername,
  resolvePreferredParticipantUsername,
} from "../config/mod.ts";
import { DAEMON_APP_VERSION } from "../version.ts";

export interface DaemonRuntimeLoopOptions {
  statusStore?: DaemonStatusSnapshotStoreLike;
  controlStore?: DaemonControlRequestStoreLike;
  recordingPipeline?: RecordingPipelineLike;
  ingestionRunners?: ProviderIngestionRunner[];
  sessionSnapshotStore?: SessionSnapshotStore;
  sessionStateStore?: PersistentSessionStateStore;
  loadSessionSnapshot?: (
    sessionId: string,
  ) => Promise<SessionExportSnapshot | undefined>;
  exportEnabled?: boolean;
  now?: () => Date;
  pid?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  providerStatusStaleAfterMs?: number;
  sessionMetadataRefreshIntervalMs?: number;
  daemonMaxMemoryMb?: number;
  exportsLogPath?: string;
  clearControlQueueOnStartup?: boolean;
  cleanSessionStatesOnShutdown?: boolean;
  daemonFeatureFlags?: DaemonFeatureFlags;
  userConfig?: UserConfig;
  defaultCliExportOutputOverrides?: RecordingOutputOverrides;
  workspaceRegistryStore?: WorkspaceRegistryFileStore;
  workspaceCatalog?: WorkspaceCatalogLike;
  workspaceProfileResolver?: WorkspaceProfileResolverLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
  /**
   * Applied to provider-source replay (capture/export fallback when no twin
   * history exists). Defaults to fail-closed `redact` mode when omitted.
   */
  secretsPolicy?: SecretsPolicyConfig;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROVIDER_STATUS_STALE_AFTER_MS = 5 * 60_000;
const CAPTURE_DESTINATION_CONFLICT_MAX_RETRIES = 5;
const CAPTURE_DESTINATION_CONFLICT_BACKOFF_MS = 25;
const FIRST_SEEN_PROVIDER_SESSION_REALTIME_GRACE_MS = 5_000;
const UNKNOWN_OUTPUT_USERNAME = "unknown-user";

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

function serializeRuntimeCursor(
  cursor: ConversationEvent["source"]["rawCursor"],
): string {
  if (!cursor) {
    return "";
  }
  return `${cursor.kind}:${String(cursor.value)}`;
}

function resolveRuntimeStableCursorComponent(event: ConversationEvent): string {
  if (event.turnId && event.turnId.trim().length > 0) {
    return `turn:${event.turnId}`;
  }
  if (
    event.source.providerEventId &&
    event.source.providerEventId.trim().length > 0
  ) {
    return "";
  }
  return serializeRuntimeCursor(event.source.rawCursor);
}

interface SessionEventProcessingState {
  seenEventSignatures: Set<string>;
  lastSeenFileModifiedAtMs?: number;
  destinationRecordingIds: Map<string, string>;
  workspaceOutputs: Map<
    string,
    {
      workspaceId: string;
      workspaceAlias?: string;
      currentResolvedPath: string;
      desiredState: boolean;
      recordingCycleId?: string;
      outputOverrides: RecordingOutputOverrides;
    }
  >;
}

interface ProcessInChatRecordingUpdatesOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionEventStates: Map<string, SessionEventProcessingState>;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  processEventsFromMs: number;
  now: () => Date;
  captureIncludeSystemEvents: boolean;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
  userConfig: UserConfig;
}

interface ProcessPersistentRecordingUpdatesOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore: PersistentSessionStateStore;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  processEventsFromMs: number;
  now: () => Date;
  captureIncludeSystemEvents: boolean;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
  userConfig: UserConfig;
  secretsPolicy?: SecretsPolicyConfig;
}

interface ApplyControlCommandsForEventOptions {
  provider: string;
  sessionId: string;
  snapshotSnippet?: string;
  events: ConversationEvent[];
  eventIndex: number;
  event: ConversationEvent & { kind: "message.user" };
  sessionEventState: SessionEventProcessingState;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  now: () => Date;
  captureIncludeSystemEvents: boolean;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
  userConfig: UserConfig;
}

function makeSessionProcessingKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function makeRuntimeEventSignature(event: ConversationEvent): string {
  const stableCursorComponent = resolveRuntimeStableCursorComponent(event);
  const base = `${event.kind}\0${event.source.providerEventType}\0${
    event.source.providerEventId ?? ""
  }\0${event.timestamp ?? ""}\0${stableCursorComponent}`;
  switch (event.kind) {
    case "message.user":
    case "message.assistant":
    case "message.system":
      return `${base}\0${event.content}`;
    case "tool.call":
      return `${base}\0${event.toolCallId}\0${event.name}\0${
        event.description ?? ""
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

function resolveConversationTitle(
  events: ConversationEvent[],
  fallback: string,
  options: { snapshotSnippet?: string } = {},
): string {
  const snapshotFirstLine = options.snapshotSnippet
    ?.split(/\r\n?|\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (snapshotFirstLine && snapshotFirstLine.length > 0) {
    return snapshotFirstLine;
  }
  const snippet = extractSnippet(events);
  if (snippet && snippet.trim().length > 0) {
    return snippet;
  }
  return fallback;
}

interface PersistentRecordingCommandContext {
  provider: string;
  providerSessionId: string;
  snapshotSnippet?: string;
  events: ConversationEvent[];
  eventIndex: number;
  event: ConversationEvent & { kind: "message.user" };
  metadata: SessionMetadataV1;
  sessionStateStore: PersistentSessionStateStore;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  now: () => Date;
  captureIncludeSystemEvents: boolean;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
  userConfig: UserConfig;
  secretsPolicy?: SecretsPolicyConfig;
}

async function assertCaptureDestinationDoesNotExist(
  targetPath: string,
): Promise<void> {
  try {
    await Deno.stat(targetPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
  throw new Deno.errors.AlreadyExists(
    `Capture destination already exists: ${targetPath}`,
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  if (error instanceof Deno.errors.AlreadyExists) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  if (candidate.code === "EEXIST" || candidate.name === "AlreadyExists") {
    return true;
  }
  return typeof candidate.message === "string" &&
    /^Capture destination already exists:/.test(candidate.message);
}

async function captureSnapshotWithRetries(options: {
  recordingPipeline: RecordingPipelineLike;
  provider: string;
  sessionId: string;
  targetPath: string;
  events: ConversationEvent[];
  title?: string;
  workspaceId: string;
  outputOverrides?: RecordingOutputOverrides;
  allowGeneratedDestinationRetries: boolean;
  resolveCycleIdForAttempt: (targetPath: string) => string;
}): Promise<{ targetPath: string; captureCycleId: string }> {
  let targetPath = options.targetPath;
  let captureConflictRetries = 0;
  while (true) {
    const cycleIdForAttempt = options.resolveCycleIdForAttempt(targetPath);
    try {
      await assertCaptureDestinationDoesNotExist(targetPath);
      await options.recordingPipeline.captureSnapshot({
        provider: options.provider,
        sessionId: options.sessionId,
        targetPath,
        events: options.events,
        title: options.title,
        recordingCycleIds: [cycleIdForAttempt],
        workspaceIds: [options.workspaceId],
        outputOverrides: options.outputOverrides,
      });
      return {
        targetPath,
        captureCycleId: cycleIdForAttempt,
      };
    } catch (error) {
      if (
        !options.allowGeneratedDestinationRetries ||
        !isAlreadyExistsError(error)
      ) {
        throw error;
      }
      captureConflictRetries += 1;
      if (captureConflictRetries > CAPTURE_DESTINATION_CONFLICT_MAX_RETRIES) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        throw new Error(
          `Capture destination conflict retries exceeded (${CAPTURE_DESTINATION_CONFLICT_MAX_RETRIES}) for ${targetPath}: ${errorMessage}`,
        );
      }
      if (CAPTURE_DESTINATION_CONFLICT_BACKOFF_MS > 0) {
        await sleep(CAPTURE_DESTINATION_CONFLICT_BACKOFF_MS);
      }
      const nextTargetPath = await resolveUniqueNonExistingPath(targetPath);
      targetPath = await validateDestinationPathForCommand(
        options.recordingPipeline,
        options.provider,
        options.sessionId,
        nextTargetPath,
        "capture",
      );
    }
  }
}

function createOutputOverridesFromWorkspaceProfile(
  profile: ResolvedWorkspaceProfile,
  captureIncludeSystemEvents: boolean,
  userConfig: UserConfig,
): RecordingOutputOverrides {
  const preferredUsername = resolvePreferredParticipantUsername({
    userConfig,
    workspaceId: profile.workspaceId,
  });
  return createOutputOverrides({
    workspaceId: profile.workspaceId,
    markdownFrontmatter: profile.markdownFrontmatter,
    writerFeatureFlags: profile.writerFeatureFlags,
    workspaceTimezone: profile.workspaceTimezone,
    preferredUsername,
    captureIncludeSystemEvents,
    userConfig,
  });
}

function createOutputOverrides(options: {
  workspaceId?: string;
  markdownFrontmatter: MarkdownFrontmatterConfig;
  writerFeatureFlags: {
    writerIncludeCommentary: boolean;
    writerIncludeThinking: boolean;
    writerIncludeToolCalls: boolean;
    writerIncludeToolResults?: boolean;
    writerIncludeDecisionPrompt?: boolean;
    writerIncludeDecisionOptions?: boolean;
    writerIncludeDecisionSelection?: boolean;
    writerItalicizeUserMessages: boolean;
    writerRelativizeLocalLinks?: boolean;
    writerUseDendronStyleWikilinks?: boolean;
  };
  workspaceTimezone: string;
  preferredUsername?: string;
  captureIncludeSystemEvents: boolean;
  userConfig: UserConfig;
}): RecordingOutputOverrides {
  return {
    includeFrontmatter:
      options.markdownFrontmatter.includeFrontmatterInMarkdownRecordings,
    includeUpdatedInFrontmatter:
      options.markdownFrontmatter.includeUpdatedInFrontmatter,
    includeSessionIds: options.markdownFrontmatter.includeSessionIds,
    includeWorkspaceIds: options.markdownFrontmatter.includeWorkspaceIds,
    includeRecordingIds: options.markdownFrontmatter.includeRecordingIds,
    includeConversationEventKinds:
      options.markdownFrontmatter.includeConversationEventKinds,
    participantUsername: resolveFrontmatterParticipantUsername(
      {
        markdownFrontmatter: options.markdownFrontmatter,
        userConfig: options.userConfig,
        workspaceId: options.workspaceId,
      },
    ),
    renderOptions: {
      includeCommentary: options.writerFeatureFlags.writerIncludeCommentary,
      includeThinking: options.writerFeatureFlags.writerIncludeThinking,
      includeToolCalls: options.writerFeatureFlags.writerIncludeToolCalls,
      includeToolResults: options.writerFeatureFlags.writerIncludeToolResults ??
        false,
      includeDecisionPrompt:
        options.writerFeatureFlags.writerIncludeDecisionPrompt ?? true,
      includeDecisionOptions:
        options.writerFeatureFlags.writerIncludeDecisionOptions ?? true,
      includeDecisionSelection:
        options.writerFeatureFlags.writerIncludeDecisionSelection ?? true,
      italicizeUserMessages:
        options.writerFeatureFlags.writerItalicizeUserMessages,
      relativizeLocalLinks:
        options.writerFeatureFlags.writerRelativizeLocalLinks ?? true,
      markdownLinkStyle:
        options.writerFeatureFlags.writerUseDendronStyleWikilinks
          ? "dendron-wikilink"
          : "standard",
      includeSystemEvents: options.captureIncludeSystemEvents,
      headingTimestampTimezone: options.workspaceTimezone,
      ...(options.markdownFrontmatter.addParticipantUsernameToHeadings &&
          options.preferredUsername
        ? {
          speakerNames: { user: options.preferredUsername },
        }
        : {}),
    },
  };
}

async function resolvePersistedWorkspaceOutputOverrides(options: {
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number];
  captureIncludeSystemEvents: boolean;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
  userConfig: UserConfig;
}): Promise<RecordingOutputOverrides> {
  const preferredUsername = resolvePreferredParticipantUsername({
    userConfig: options.userConfig,
    workspaceId: options.output.workspaceId,
  });
  const registered = await options.workspaceCatalog.getByWorkspaceId(
    options.output.workspaceId,
  );
  if (registered) {
    const profile = await options.workspaceProfileResolver.resolveForCommand(
      registered,
    );
    return createOutputOverridesFromWorkspaceProfile(
      profile,
      options.captureIncludeSystemEvents,
      options.userConfig,
    );
  }

  if (options.output.sourceConfigPath) {
    try {
      const stat = await Deno.stat(options.output.sourceConfigPath);
      if (stat.isFile) {
        const overrides = await loadWorkspaceConfigOverrides(
          options.output.sourceConfigPath,
        );
        return createOutputOverrides({
          workspaceId: options.output.workspaceId,
          markdownFrontmatter: createDefaultWorkspaceMarkdownFrontmatterConfig(
            overrides.markdownFrontmatter,
          ),
          writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(
            overrides.writerFeatureFlags,
          ),
          workspaceTimezone: overrides.workspaceTimezone ??
            DEFAULT_WORKSPACE_TIMEZONE,
          preferredUsername,
          captureIncludeSystemEvents: options.captureIncludeSystemEvents,
          userConfig: options.userConfig,
        });
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  return createOutputOverrides({
    workspaceId: options.output.workspaceId,
    markdownFrontmatter: createDefaultWorkspaceMarkdownFrontmatterConfig(),
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(
      options.output.writerFeatureFlags,
    ),
    workspaceTimezone: DEFAULT_WORKSPACE_TIMEZONE,
    preferredUsername,
    captureIncludeSystemEvents: options.captureIncludeSystemEvents,
    userConfig: options.userConfig,
  });
}

function matchesCaptureBoundaryEvent(
  candidate: ConversationEvent,
  commandEvent: ConversationEvent & { kind: "message.user" },
): boolean {
  if (candidate.kind !== "message.user") {
    return false;
  }
  if (
    candidate.source.providerEventType !== commandEvent.source.providerEventType
  ) {
    return false;
  }

  const candidateProviderEventId = candidate.source.providerEventId;
  const commandProviderEventId = commandEvent.source.providerEventId;
  if (
    typeof candidateProviderEventId === "string" &&
    candidateProviderEventId.length > 0 &&
    typeof commandProviderEventId === "string" &&
    commandProviderEventId.length > 0
  ) {
    return candidateProviderEventId === commandProviderEventId;
  }

  if (candidate.content !== commandEvent.content) {
    return false;
  }

  if (
    (candidate.timestamp?.length ?? 0) > 0 &&
    (commandEvent.timestamp?.length ?? 0) > 0 &&
    candidate.timestamp !== commandEvent.timestamp
  ) {
    return false;
  }

  return true;
}

async function resolveBoundaryEventsFromSessionStart(
  metadata: SessionMetadataV1,
  fallbackBoundaryEvents: ConversationEvent[],
  commandEvent: ConversationEvent & { kind: "message.user" },
  boundaryLine: number,
  sessionStateStore: PersistentSessionStateStore,
  replayContext?: {
    secretsPolicy?: SecretsPolicyConfig;
    auditLogger?: AuditLogger;
  },
): Promise<ConversationEvent[]> {
  let historyEvents: ConversationEvent[];
  try {
    const history = await loadPersistedSessionHistoryEvents(
      metadata,
      sessionStateStore,
      { secretsPolicy: replayContext?.secretsPolicy },
    );
    if (history.redaction && replayContext?.auditLogger) {
      await replayContext.auditLogger.record(
        history.redaction.mode === "redact"
          ? "secrets.redacted"
          : "secrets.detected",
        "Secrets policy applied during provider source replay",
        {
          provider: metadata.provider,
          sessionId: metadata.providerSessionId,
          mode: history.redaction.mode,
          eventsAffected: history.redaction.eventsAffected,
          countsByRule: Object.fromEntries(
            history.redaction.matches.map((
              match,
            ) => [match.ruleId, match.count]),
          ),
        },
      );
    }
    historyEvents = history.events;
  } catch {
    return fallbackBoundaryEvents;
  }
  if (historyEvents.length === 0) {
    return fallbackBoundaryEvents;
  }

  let boundaryIndex = -1;
  for (let i = 0; i < historyEvents.length; i += 1) {
    const candidate = historyEvents[i];
    if (!candidate) continue;
    if (matchesCaptureBoundaryEvent(candidate, commandEvent)) {
      boundaryIndex = i;
    }
  }

  if (boundaryIndex >= 0) {
    const boundaryEvent = historyEvents[boundaryIndex];
    if (boundaryEvent?.kind === "message.user") {
      return buildBoundarySnapshotEvents(
        historyEvents,
        boundaryIndex,
        boundaryEvent,
        boundaryLine,
      );
    }
    return historyEvents.slice(0, boundaryIndex + 1);
  }
  return fallbackBoundaryEvents;
}

async function logMissingWorkspaceForCommand(options: {
  provider: string;
  sessionId: string;
  eventId: string;
  command: string;
  alias: string;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}): Promise<void> {
  const {
    provider,
    sessionId,
    eventId,
    command,
    alias,
    operationalLogger,
    auditLogger,
  } = options;
  await operationalLogger.warn(
    "recording.command.workspace_missing",
    "Skipping in-chat control command because workspace alias is not registered",
    {
      provider,
      sessionId,
      eventId,
      command,
      alias,
    },
  );
  await auditLogger.record(
    "recording.command.workspace_missing",
    "In-chat control command workspace alias not registered",
    {
      provider,
      sessionId,
      eventId,
      command,
      alias,
    },
  );
}

async function applyPersistentControlCommandsForEvent(
  ctx: PersistentRecordingCommandContext,
): Promise<boolean> {
  const {
    provider,
    providerSessionId,
    snapshotSnippet,
    events,
    eventIndex,
    event,
    metadata,
    sessionStateStore,
    recordingPipeline,
    operationalLogger,
    auditLogger,
    now,
    captureIncludeSystemEvents,
    workspaceCatalog,
    workspaceProfileResolver,
    userConfig,
  } = ctx;

  const detection = detectInChatControlCommands(event.content);
  if (detection.commands.length === 0 && detection.errors.length === 0) {
    return false;
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
        sessionId: providerSessionId,
        eventId: event.eventId,
        parseErrors,
      },
    );
    await auditLogger.record(
      "recording.command.parse_error",
      "In-chat control command parse error",
      {
        provider,
        sessionId: providerSessionId,
        eventId: event.eventId,
        parseErrors,
      },
    );
    return false;
  }

  const commandBoundaries = resolveCommandBoundaries(
    event.content,
    detection.commands,
  );
  const writeCursor = eventIndex + 1;
  let metadataChanged = false;

  for (const boundary of commandBoundaries) {
    const { command } = boundary;
    const boundarySnapshot = buildBoundarySnapshotEvents(
      events,
      eventIndex,
      event,
      command.line,
    );
    const boundarySnapshotTitle = resolveConversationTitle(
      boundarySnapshot,
      providerSessionId,
      { snapshotSnippet },
    );
    let commandNoop = false;
    let loggedTargetPath: string | undefined;

    try {
      if (!command.alias) {
        const nowIso = now().toISOString();
        const stoppedOutputs = stopAllWorkspaceOutputs(
          metadata,
          writeCursor,
          nowIso,
        );
        if (stoppedOutputs.length === 0) {
          commandNoop = true;
        } else {
          metadataChanged = true;
        }
      } else {
        const workspace = await workspaceCatalog.getByAlias(command.alias);
        if (!workspace) {
          await logMissingWorkspaceForCommand({
            provider,
            sessionId: providerSessionId,
            eventId: event.eventId,
            command: command.verb,
            alias: command.alias,
            operationalLogger,
            auditLogger,
          });
          continue;
        }

        const profile = await workspaceProfileResolver.resolveForCommand(
          workspace,
        );
        const outputOverrides = createOutputOverridesFromWorkspaceProfile(
          profile,
          captureIncludeSystemEvents,
          userConfig,
        );
        const outputUsername = resolvePreferredParticipantUsername({
          userConfig,
          workspaceId: workspace.workspaceId,
        }) ?? UNKNOWN_OUTPUT_USERNAME;
        const commandNow = now();
        const resolvedDefaultOutputDir = resolveWorkspaceDefaultOutputDir({
          profile,
          provider,
          sessionId: providerSessionId,
          now: commandNow,
          outputUsername,
          snapshotSnippet,
          boundarySnapshot,
        });
        let output = findWorkspaceOutput(metadata, workspace.workspaceId);

        if (command.verb === "stop") {
          if (!output) {
            commandNoop = true;
          } else {
            const stopped = closeWorkspaceOutputCycle(
              output,
              writeCursor,
              now().toISOString(),
            );
            commandNoop = !stopped;
            metadataChanged = stopped;
          }
        } else if (command.verb === "record") {
          let retargeted = false;
          if (!output || command.argument) {
            const resolved = await resolveWorkspaceCommandDestination({
              profile,
              provider,
              sessionId: providerSessionId,
              outputUsername,
              snapshotSnippet,
              boundarySnapshot,
              rawArgument: command.argument,
              now: commandNow,
            });
            const resolvedDestination = await validateDestinationPathForCommand(
              recordingPipeline,
              provider,
              providerSessionId,
              resolved.resolvedPath,
              "record",
            );
            loggedTargetPath = resolvedDestination;
            if (!output) {
              output = createWorkspaceOutputState({
                profile,
                binding: resolved.binding,
                resolvedPath: resolvedDestination,
                resolvedDefaultOutputDir: resolved.resolvedDefaultOutputDir,
                desiredState: "off",
                writeCursor,
                nowIso: now().toISOString(),
              });
              readWorkspaceOutputs(metadata).push(output);
              metadataChanged = true;
            } else if (output.currentResolvedPath !== resolvedDestination) {
              closeWorkspaceOutputCycle(
                output,
                writeCursor,
                now().toISOString(),
              );
              applyWorkspaceProfileSnapshot(
                output,
                profile,
                resolved.resolvedDefaultOutputDir,
              );
              output.currentDestination = resolved.binding;
              output.currentResolvedPath = resolvedDestination;
              output.writeCursor = writeCursor;
              output.desiredState = "off";
              retargeted = true;
              metadataChanged = true;
            }
          }
          if (!output) {
            throw new Error("Workspace output state was not created");
          }
          if (!loggedTargetPath) {
            loggedTargetPath = output.currentResolvedPath;
          }
          if (output.desiredState === "on" && !retargeted) {
            commandNoop = true;
          } else {
            applyWorkspaceProfileSnapshot(
              output,
              profile,
              resolvedDefaultOutputDir,
            );
            const cycleId = openWorkspaceOutputCycle(
              output,
              writeCursor,
              now().toISOString(),
            );
            const seedEvents = buildCommandSeedEvents(
              event,
              command.line,
              boundary.lastLineInSegment,
            );
            if (seedEvents.length > 0) {
              if (!recordingPipeline.appendToDestination) {
                throw new Error(
                  "Recording pipeline does not support appendToDestination",
                );
              }
              const writeResult = await recordingPipeline.appendToDestination({
                provider,
                sessionId: providerSessionId,
                targetPath: output.currentResolvedPath,
                events: seedEvents,
                title: boundarySnapshotTitle,
                recordingId: cycleId,
                recordingCycleIds: [cycleId],
                workspaceIds: [workspace.workspaceId],
                outputOverrides,
              });
              if (writeResult.wrote) {
                updateWorkspaceOutputCycleLastWrite(
                  output,
                  now().toISOString(),
                  cycleId,
                );
              }
            }
            output.writeCursor = writeCursor;
            metadataChanged = true;
          }
        } else if (command.verb === "capture") {
          const resolved = await resolveWorkspaceCommandDestination({
            profile,
            provider,
            sessionId: providerSessionId,
            outputUsername,
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            ensureGeneratedPathUnique: true,
            now: commandNow,
          });
          let targetPath = await validateDestinationPathForCommand(
            recordingPipeline,
            provider,
            providerSessionId,
            resolved.resolvedPath,
            "capture",
          );
          const captureEvents = await resolveBoundaryEventsFromSessionStart(
            metadata,
            boundarySnapshot,
            event,
            command.line,
            sessionStateStore,
            { secretsPolicy: ctx.secretsPolicy, auditLogger },
          );
          const captureTitle = resolveConversationTitle(
            captureEvents,
            providerSessionId,
            { snapshotSnippet },
          );
          const captureResult = await captureSnapshotWithRetries({
            recordingPipeline,
            provider,
            sessionId: providerSessionId,
            targetPath,
            events: captureEvents,
            title: captureTitle,
            workspaceId: workspace.workspaceId,
            outputOverrides,
            allowGeneratedDestinationRetries: resolved.usesGeneratedFilename,
            resolveCycleIdForAttempt: (targetPathForAttempt) => {
              const destinationChangedForAttempt = !output ||
                output.currentResolvedPath !== targetPathForAttempt;
              const currentCycleId = output?.activeRecordingCycleId;
              const reuseActiveCycleId = !destinationChangedForAttempt &&
                output?.desiredState === "on" &&
                !!currentCycleId;
              return reuseActiveCycleId && currentCycleId
                ? currentCycleId
                : crypto.randomUUID();
            },
          });
          targetPath = captureResult.targetPath;
          const captureCycleId = captureResult.captureCycleId;
          loggedTargetPath = targetPath;
          const destinationChanged = !output ||
            output.currentResolvedPath !== targetPath;
          const targetBinding = resolveBindingForRetargetedWorkspacePath({
            profile,
            currentBinding: resolved.binding,
            resolvedPath: targetPath,
          });
          let stateChanged = false;
          if (!output) {
            output = createWorkspaceOutputState({
              profile,
              binding: targetBinding,
              resolvedPath: targetPath,
              resolvedDefaultOutputDir: resolved.resolvedDefaultOutputDir,
              desiredState: "off",
              writeCursor,
              nowIso: now().toISOString(),
            });
            readWorkspaceOutputs(metadata).push(output);
            stateChanged = true;
          } else if (destinationChanged) {
            closeWorkspaceOutputCycle(
              output,
              writeCursor,
              now().toISOString(),
            );
            stateChanged = true;
          }
          if (!output) {
            throw new Error("Workspace output state was not created");
          }
          applyWorkspaceProfileSnapshot(
            output,
            profile,
            resolved.resolvedDefaultOutputDir,
          );
          output.currentDestination = targetBinding;
          output.currentResolvedPath = targetPath;
          let activeCycleId = output.activeRecordingCycleId;
          if (!activeCycleId || output.desiredState !== "on") {
            activeCycleId = openWorkspaceOutputCycle(
              output,
              writeCursor,
              now().toISOString(),
              captureCycleId,
            );
            stateChanged = true;
          }
          const continuationEvents = buildCommandSeedEvents(
            event,
            command.line + 1,
            boundary.lastLineInSegment,
          );
          if (continuationEvents.length > 0) {
            if (!recordingPipeline.appendToDestination) {
              throw new Error(
                "Recording pipeline does not support appendToDestination",
              );
            }
            const writeResult = await recordingPipeline.appendToDestination({
              provider,
              sessionId: providerSessionId,
              targetPath,
              events: continuationEvents,
              title: captureTitle,
              ...(activeCycleId ? { recordingId: activeCycleId } : {}),
              recordingCycleIds: activeCycleId ? [activeCycleId] : undefined,
              workspaceIds: [workspace.workspaceId],
              outputOverrides,
            });
            if (writeResult.wrote && activeCycleId) {
              updateWorkspaceOutputCycleLastWrite(
                output,
                now().toISOString(),
                activeCycleId,
              );
            }
          }
          output.writeCursor = writeCursor;
          stateChanged = true;
          metadataChanged = metadataChanged || stateChanged;
        } else if (command.verb === "export") {
          const resolved = await resolveWorkspaceCommandDestination({
            profile,
            provider,
            sessionId: providerSessionId,
            outputUsername,
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            now: commandNow,
          });
          const targetPath = await validateDestinationPathForCommand(
            recordingPipeline,
            provider,
            providerSessionId,
            resolved.resolvedPath,
            "export",
          );
          loggedTargetPath = targetPath;
          const exportEvents = await resolveBoundaryEventsFromSessionStart(
            metadata,
            boundarySnapshot,
            event,
            command.line,
            sessionStateStore,
            { secretsPolicy: ctx.secretsPolicy, auditLogger },
          );
          const snapshotTitle = resolveConversationTitle(
            exportEvents,
            providerSessionId,
            { snapshotSnippet },
          );
          await recordingPipeline.exportSnapshot({
            provider,
            sessionId: providerSessionId,
            targetPath,
            events: exportEvents,
            title: snapshotTitle,
            workspaceIds: [workspace.workspaceId],
            outputOverrides,
          });
          const continuationEvents = buildCommandSeedEvents(
            event,
            command.line + 1,
            boundary.lastLineInSegment,
          );
          if (continuationEvents.length > 0) {
            if (!recordingPipeline.appendToDestination) {
              throw new Error(
                "Recording pipeline does not support appendToDestination",
              );
            }
            await recordingPipeline.appendToDestination({
              provider,
              sessionId: providerSessionId,
              targetPath,
              events: continuationEvents,
              title: snapshotTitle,
              workspaceIds: [workspace.workspaceId],
              outputOverrides,
            });
          }
        }
      }

      await operationalLogger.info(
        "recording.command.applied",
        "Applied in-chat control command",
        {
          provider,
          sessionId: providerSessionId,
          eventId: event.eventId,
          command: command.name,
          ...(loggedTargetPath ? { targetPath: loggedTargetPath } : {}),
          ...(commandNoop ? { noop: true } : {}),
        },
      );
    } catch (error) {
      await operationalLogger.error(
        "recording.command.failed",
        "Failed to apply in-chat control command",
        {
          provider,
          sessionId: providerSessionId,
          eventId: event.eventId,
          command: command.name,
          ...(loggedTargetPath ? { targetPath: loggedTargetPath } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await auditLogger.record(
        "recording.command.failed",
        "In-chat control command failed",
        {
          provider,
          sessionId: providerSessionId,
          eventId: event.eventId,
          command: command.name,
          ...(loggedTargetPath ? { targetPath: loggedTargetPath } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  return metadataChanged;
}

async function applyControlCommandsForEvent(
  options: ApplyControlCommandsForEventOptions,
): Promise<void> {
  const {
    provider,
    sessionId,
    snapshotSnippet,
    events,
    eventIndex,
    event,
    sessionEventState,
    recordingPipeline,
    operationalLogger,
    auditLogger,
    now,
    captureIncludeSystemEvents,
    workspaceCatalog,
    workspaceProfileResolver,
    userConfig,
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

  const boundaries = resolveCommandBoundaries(
    event.content,
    detection.commands,
  );

  for (const boundary of boundaries) {
    const { command } = boundary;
    const boundarySnapshot = buildBoundarySnapshotEvents(
      events,
      eventIndex,
      event,
      command.line,
    );
    const recordingTitle = resolveConversationTitle(
      boundarySnapshot,
      sessionId,
      { snapshotSnippet },
    );
    let loggedTargetPath: string | undefined;
    let commandNoop = false;

    try {
      if (!command.alias) {
        let stoppedWorkspace = false;
        for (const [workspaceId, state] of sessionEventState.workspaceOutputs) {
          if (!state.desiredState) {
            continue;
          }
          if (
            recordingPipeline.stopRecording(provider, sessionId, workspaceId)
          ) {
            stoppedWorkspace = true;
          }
          state.desiredState = false;
          delete state.recordingCycleId;
        }
        commandNoop = !stoppedWorkspace;
      } else {
        const workspace = await workspaceCatalog.getByAlias(command.alias);
        if (!workspace) {
          await logMissingWorkspaceForCommand({
            provider,
            sessionId,
            eventId: event.eventId,
            command: command.verb,
            alias: command.alias,
            operationalLogger,
            auditLogger,
          });
          continue;
        }
        const profile = await workspaceProfileResolver.resolveForCommand(
          workspace,
        );
        const outputOverrides = createOutputOverridesFromWorkspaceProfile(
          profile,
          captureIncludeSystemEvents,
          userConfig,
        );
        const outputUsername = resolvePreferredParticipantUsername({
          userConfig,
          workspaceId: workspace.workspaceId,
        }) ?? UNKNOWN_OUTPUT_USERNAME;
        const commandNow = now();
        const existingState = sessionEventState.workspaceOutputs.get(
          workspace.workspaceId,
        );

        if (command.verb === "stop") {
          const stopped = existingState?.desiredState
            ? recordingPipeline.stopRecording(
              provider,
              sessionId,
              workspace.workspaceId,
            )
            : false;
          if (existingState) {
            existingState.desiredState = false;
            delete existingState.recordingCycleId;
          }
          commandNoop = !stopped;
        } else if (command.verb === "record") {
          let resolvedDestination = existingState?.currentResolvedPath;
          if (!existingState || command.argument) {
            const resolved = await resolveWorkspaceCommandDestination({
              profile,
              provider,
              sessionId,
              outputUsername,
              snapshotSnippet,
              boundarySnapshot,
              rawArgument: command.argument,
              now: commandNow,
            });
            resolvedDestination = await validateDestinationPathForCommand(
              recordingPipeline,
              provider,
              sessionId,
              resolved.resolvedPath,
              "record",
            );
          }
          if (!resolvedDestination) {
            throw new Error(
              "Unable to resolve workspace recording destination",
            );
          }
          loggedTargetPath = resolvedDestination;
          const state = existingState ?? {
            workspaceId: workspace.workspaceId,
            workspaceAlias: profile.alias,
            currentResolvedPath: resolvedDestination,
            desiredState: false,
            outputOverrides,
          };
          const activeSameDestination = state.desiredState &&
            state.currentResolvedPath === resolvedDestination;
          if (activeSameDestination) {
            commandNoop = true;
          } else {
            if (state.desiredState) {
              recordingPipeline.stopRecording(
                provider,
                sessionId,
                workspace.workspaceId,
              );
            }
            const recordingCycleId = crypto.randomUUID();
            const seedEvents = buildCommandSeedEvents(
              event,
              command.line,
              boundary.lastLineInSegment,
            );
            await recordingPipeline.activateRecording({
              provider,
              sessionId,
              recordingKey: workspace.workspaceId,
              workspaceAlias: profile.alias,
              targetPath: resolvedDestination,
              seedEvents,
              title: recordingTitle,
              recordingId: recordingCycleId,
              workspaceIds: [workspace.workspaceId],
              outputOverrides,
            });
            state.currentResolvedPath = resolvedDestination;
            state.desiredState = true;
            state.recordingCycleId = recordingCycleId;
            state.workspaceAlias = profile.alias;
            state.outputOverrides = outputOverrides;
            sessionEventState.workspaceOutputs.set(
              workspace.workspaceId,
              state,
            );
          }
        } else if (command.verb === "capture") {
          const resolved = await resolveWorkspaceCommandDestination({
            profile,
            provider,
            sessionId,
            outputUsername,
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            ensureGeneratedPathUnique: true,
            now: commandNow,
          });
          let resolvedDestination = await validateDestinationPathForCommand(
            recordingPipeline,
            provider,
            sessionId,
            resolved.resolvedPath,
            "capture",
          );
          const captureResult = await captureSnapshotWithRetries({
            recordingPipeline,
            provider,
            sessionId,
            targetPath: resolvedDestination,
            events: boundarySnapshot,
            title: recordingTitle,
            workspaceId: workspace.workspaceId,
            outputOverrides,
            allowGeneratedDestinationRetries: resolved.usesGeneratedFilename,
            resolveCycleIdForAttempt: (targetPathForAttempt) => {
              const destinationChangedForAttempt = !existingState ||
                existingState.currentResolvedPath !== targetPathForAttempt;
              const activeCycleIdForAttempt = existingState?.desiredState &&
                  existingState.recordingCycleId &&
                  !destinationChangedForAttempt
                ? existingState.recordingCycleId
                : undefined;
              return activeCycleIdForAttempt ?? crypto.randomUUID();
            },
          });
          resolvedDestination = captureResult.targetPath;
          const captureCycleId = captureResult.captureCycleId;
          loggedTargetPath = resolvedDestination;
          const state = existingState ?? {
            workspaceId: workspace.workspaceId,
            workspaceAlias: profile.alias,
            currentResolvedPath: resolvedDestination,
            desiredState: false,
            outputOverrides,
          };
          const destinationChanged = state.currentResolvedPath !==
            resolvedDestination;
          const activeCycleId = state.desiredState && state.recordingCycleId &&
              !destinationChanged
            ? state.recordingCycleId
            : undefined;
          const continuationEvents = buildCommandSeedEvents(
            event,
            command.line + 1,
            boundary.lastLineInSegment,
          );
          if (activeCycleId) {
            if (continuationEvents.length > 0) {
              await recordingPipeline.appendToActiveRecording({
                provider,
                sessionId,
                recordingKey: workspace.workspaceId,
                events: continuationEvents,
                title: recordingTitle,
                recordingCycleIds: [captureCycleId],
                workspaceIds: [workspace.workspaceId],
                outputOverrides,
              });
            }
          } else {
            if (state.desiredState) {
              recordingPipeline.stopRecording(
                provider,
                sessionId,
                workspace.workspaceId,
              );
            }
            await recordingPipeline.activateRecording({
              provider,
              sessionId,
              recordingKey: workspace.workspaceId,
              workspaceAlias: profile.alias,
              targetPath: resolvedDestination,
              seedEvents: continuationEvents,
              title: recordingTitle,
              recordingId: captureCycleId,
              workspaceIds: [workspace.workspaceId],
              outputOverrides,
            });
            state.desiredState = true;
            state.recordingCycleId = captureCycleId;
          }
          state.currentResolvedPath = resolvedDestination;
          state.workspaceAlias = profile.alias;
          state.outputOverrides = outputOverrides;
          sessionEventState.workspaceOutputs.set(workspace.workspaceId, state);
        } else if (command.verb === "export") {
          const resolved = await resolveWorkspaceCommandDestination({
            profile,
            provider,
            sessionId,
            outputUsername,
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            now: commandNow,
          });
          const targetPath = await validateDestinationPathForCommand(
            recordingPipeline,
            provider,
            sessionId,
            resolved.resolvedPath,
            "export",
          );
          loggedTargetPath = targetPath;
          await recordingPipeline.exportSnapshot({
            provider,
            sessionId,
            targetPath,
            events: boundarySnapshot,
            title: recordingTitle,
            workspaceIds: [workspace.workspaceId],
            outputOverrides,
          });
          const continuationEvents = buildCommandSeedEvents(
            event,
            command.line + 1,
            boundary.lastLineInSegment,
          );
          if (continuationEvents.length > 0) {
            if (!recordingPipeline.appendToDestination) {
              throw new Error(
                "Recording pipeline does not support appendToDestination",
              );
            }
            await recordingPipeline.appendToDestination({
              provider,
              sessionId,
              targetPath,
              events: continuationEvents,
              title: recordingTitle,
              workspaceIds: [workspace.workspaceId],
              outputOverrides,
            });
          }
        }
      }

      await operationalLogger.info(
        "recording.command.applied",
        "Applied in-chat control command",
        {
          provider,
          sessionId,
          eventId: event.eventId,
          command: command.name,
          ...(loggedTargetPath ? { targetPath: loggedTargetPath } : {}),
          ...(commandNoop ? { noop: true } : {}),
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
          ...(loggedTargetPath ? { targetPath: loggedTargetPath } : {}),
          ...(commandNoop ? { noop: true } : {}),
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
          ...(loggedTargetPath ? { targetPath: loggedTargetPath } : {}),
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
          ...(loggedTargetPath ? { targetPath: loggedTargetPath } : {}),
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
    processEventsFromMs,
    now,
    captureIncludeSystemEvents,
    workspaceCatalog,
    workspaceProfileResolver,
    userConfig,
  } = options;

  // Use metadata-only listing to avoid deep-cloning events for every session
  // on every poll. Only fetch full snapshot (with events) when the file has
  // actually changed since we last processed it.
  const metaEntries = sessionSnapshotStore.listMetadataOnly
    ? sessionSnapshotStore.listMetadataOnly()
    : sessionSnapshotStore.list();

  const activeSessionKeys = new Set<string>();

  for (const entry of metaEntries) {
    const provider = readString(entry.provider);
    const sessionId = readString(entry.sessionId);
    if (!provider || !sessionId) continue;

    const sessionKey = makeSessionProcessingKey(provider, sessionId);
    activeSessionKeys.add(sessionKey);

    const currentFileModifiedAtMs = entry.metadata.fileModifiedAtMs;
    const existingState = sessionEventStates.get(sessionKey);

    // Skip event processing if the file hasn't changed since last poll.
    if (
      existingState !== undefined &&
      currentFileModifiedAtMs !== undefined &&
      currentFileModifiedAtMs === existingState.lastSeenFileModifiedAtMs
    ) {
      continue;
    }

    // File is new or changed — fetch full snapshot (events needed).
    const fullEntry = "events" in entry
      ? entry as RuntimeSessionSnapshot
      : sessionSnapshotStore.get(sessionId);
    if (!fullEntry) continue;

    const snapshot = fullEntry;
    const signatures = snapshot.events.map(makeRuntimeEventSignature);
    const currentSignatureSet = new Set(signatures);

    const state = existingState ?? {
      seenEventSignatures: new Set<string>(),
      lastSeenFileModifiedAtMs: currentFileModifiedAtMs,
      destinationRecordingIds: new Map<string, string>(),
      workspaceOutputs: new Map<string, {
        workspaceId: string;
        workspaceAlias?: string;
        currentResolvedPath: string;
        desiredState: boolean;
        recordingCycleId?: string;
        outputOverrides: RecordingOutputOverrides;
      }>(),
    };
    if (!existingState) {
      for (let i = 0; i < snapshot.events.length; i += 1) {
        const event = snapshot.events[i];
        if (!event) continue;
        const signature = signatures[i] ?? makeRuntimeEventSignature(event);
        const eventTimeMs = readTimeMs(event.timestamp);
        if (eventTimeMs === undefined || eventTimeMs < processEventsFromMs) {
          state.seenEventSignatures.add(signature);
        }
      }
      sessionEventStates.set(sessionKey, state);
    }

    for (const seenSignature of Array.from(state.seenEventSignatures)) {
      if (!currentSignatureSet.has(seenSignature)) {
        state.seenEventSignatures.delete(seenSignature);
      }
    }

    const recordingTitle = resolveConversationTitle(
      snapshot.events,
      sessionId,
      {
        snapshotSnippet: snapshot.metadata.snippet,
      },
    );
    for (let i = 0; i < snapshot.events.length; i += 1) {
      const event = snapshot.events[i];
      if (!event) continue;

      const signature = signatures[i] ?? makeRuntimeEventSignature(event);
      if (state.seenEventSignatures.has(signature)) continue;
      state.seenEventSignatures.add(signature);

      // Only apply control commands from message.user events.
      if (event.kind === "message.user") {
        await applyControlCommandsForEvent({
          provider,
          sessionId,
          snapshotSnippet: snapshot.metadata.snippet,
          events: snapshot.events,
          eventIndex: i,
          event: event as ConversationEvent & { kind: "message.user" },
          sessionEventState: state,
          recordingPipeline,
          operationalLogger,
          auditLogger,
          now,
          captureIncludeSystemEvents,
          workspaceCatalog,
          workspaceProfileResolver,
          userConfig,
        });
      }

      try {
        await recordingPipeline.appendToActiveRecording({
          provider,
          sessionId,
          events: [event],
          title: recordingTitle,
        });
        for (const outputState of state.workspaceOutputs.values()) {
          if (!outputState.desiredState) {
            continue;
          }
          await recordingPipeline.appendToActiveRecording({
            provider,
            sessionId,
            recordingKey: outputState.workspaceId,
            events: [event],
            title: recordingTitle,
            recordingCycleIds: outputState.recordingCycleId
              ? [outputState.recordingCycleId]
              : undefined,
            workspaceIds: [outputState.workspaceId],
            outputOverrides: outputState.outputOverrides,
          });
        }
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

    state.lastSeenFileModifiedAtMs = currentFileModifiedAtMs;
  }

  for (const sessionKey of Array.from(sessionEventStates.keys())) {
    if (!activeSessionKeys.has(sessionKey)) {
      sessionEventStates.delete(sessionKey);
    }
  }
}

async function processPersistentRecordingUpdates(
  options: ProcessPersistentRecordingUpdatesOptions,
): Promise<boolean> {
  const {
    sessionSnapshotStore,
    sessionStateStore,
    recordingPipeline,
    operationalLogger,
    auditLogger,
    processEventsFromMs,
    now,
    captureIncludeSystemEvents,
    workspaceCatalog,
    workspaceProfileResolver,
    userConfig,
    secretsPolicy,
  } = options;

  const snapshots = sessionSnapshotStore.listMetadataOnly
    ? sessionSnapshotStore.listMetadataOnly()
    : sessionSnapshotStore.list();
  if (snapshots.length === 0) {
    return false;
  }

  const metadataList = await sessionStateStore.listSessionMetadata();
  const metadataBySessionKey = new Map<string, SessionMetadataV1>();
  for (const metadata of metadataList) {
    metadataBySessionKey.set(
      metadata.sessionKey,
      metadata as SessionMetadataV1,
    );
  }
  let anyMetadataChanged = false;

  for (const entry of snapshots) {
    const provider = readString(entry.provider);
    const providerSessionId = readString(entry.sessionId);
    if (!provider || !providerSessionId) {
      continue;
    }
    const snapshot = "events" in entry
      ? entry as RuntimeSessionSnapshot
      : sessionSnapshotStore.get(providerSessionId);
    if (!snapshot) {
      continue;
    }

    const sessionKey = `${provider}:${providerSessionId}`;
    let metadata = metadataBySessionKey.get(sessionKey);
    if (!metadata) {
      metadata = await sessionStateStore.getOrCreateSessionMetadata({
        provider,
        providerSessionId,
        sourceFilePath: `[unknown:${provider}:${providerSessionId}]`,
        initialCursor: makeDefaultSessionCursor(provider),
      }) as SessionMetadataV1;
      metadataBySessionKey.set(sessionKey, metadata);
    }

    let metadataChanged = false;
    const persistedCommandCursor = readCommandCursor(metadata);
    const persistedCommandCursorAnchor = readCommandCursorAnchor(metadata);
    const firstSeenProviderSession = persistedCommandCursor === 0 &&
      !persistedCommandCursorAnchor;
    let sourceFileFreshnessMs: number | undefined;
    let sourceFileFreshnessBasis: FirstSeenSourceFileFreshnessBasis | undefined;

    let commandCursor = resolveCommandStartCursor(metadata, snapshot.events);
    if (firstSeenProviderSession) {
      const sourceFileFreshness = await resolveFirstSeenSourceFileFreshness({
        sourceFilePath: metadata.sourceFilePath,
        metadataLastObservedMtimeMs: metadata.lastObservedMtimeMs,
      });
      sourceFileFreshnessMs = sourceFileFreshness.sourceFileFreshnessMs;
      sourceFileFreshnessBasis = sourceFileFreshness.sourceFileFreshnessBasis;
      const firstSeenResolution = resolveFirstSeenProviderSessionCommandCursor({
        events: snapshot.events,
        daemonStartMs: processEventsFromMs,
        nearRealtimeGraceMs: FIRST_SEEN_PROVIDER_SESSION_REALTIME_GRACE_MS,
        sourceFileFreshnessMs,
      });
      commandCursor = firstSeenResolution.commandCursor;
      const nextFirstSeenAnchor = commandCursor > 0
        ? buildCommandCursorAnchor(snapshot.events[commandCursor - 1])
        : undefined;
      if (
        persistedCommandCursor !== commandCursor ||
        !commandCursorAnchorEquals(
          persistedCommandCursorAnchor,
          nextFirstSeenAnchor,
        )
      ) {
        writeCommandCursor(metadata, commandCursor, snapshot.events);
        metadataChanged = true;
      }
      await operationalLogger.debug(
        "recording.command.first_seen_cursor_initialized",
        "Initialized first-seen provider session command cursor using near-realtime eligibility",
        {
          provider,
          sessionId: providerSessionId,
          sourceFilePath: metadata.sourceFilePath,
          sourceMtimeMs: metadata.lastObservedMtimeMs,
          sourceFileFreshnessMs,
          sourceFileFreshnessBasis,
          daemonStartedAtMs: processEventsFromMs,
          nearRealtimeGraceMs: FIRST_SEEN_PROVIDER_SESSION_REALTIME_GRACE_MS,
          initializedCommandCursor: commandCursor,
          snapshotEventCount: snapshot.events.length,
          eligibleUserEvents: firstSeenResolution.eligibleUserEvents,
          skippedUserEvents: firstSeenResolution.skippedUserEvents,
        },
      );
    }

    for (let i = commandCursor; i < snapshot.events.length; i += 1) {
      const event = snapshot.events[i];
      if (!event || event.kind !== "message.user") {
        continue;
      }
      if (
        firstSeenProviderSession &&
        !isFirstSeenProviderSessionUserEventEligible({
          event,
          daemonStartMs: processEventsFromMs,
          nearRealtimeGraceMs: FIRST_SEEN_PROVIDER_SESSION_REALTIME_GRACE_MS,
          sourceFileFreshnessMs,
        })
      ) {
        continue;
      }
      const changed = await applyPersistentControlCommandsForEvent({
        provider,
        providerSessionId,
        snapshotSnippet: snapshot.metadata.snippet,
        events: snapshot.events,
        eventIndex: i,
        event: event as ConversationEvent & { kind: "message.user" },
        metadata,
        sessionStateStore,
        recordingPipeline,
        operationalLogger,
        auditLogger,
        now,
        captureIncludeSystemEvents,
        workspaceCatalog,
        workspaceProfileResolver,
        userConfig,
        secretsPolicy,
      });
      metadataChanged = metadataChanged || changed;
    }
    const nextCommandCursorAnchor = buildCommandCursorAnchor(
      snapshot.events[snapshot.events.length - 1],
    );
    if (
      persistedCommandCursor !== snapshot.events.length ||
      !commandCursorAnchorEquals(
        persistedCommandCursorAnchor,
        nextCommandCursorAnchor,
      )
    ) {
      writeCommandCursor(metadata, snapshot.events.length, snapshot.events);
      metadataChanged = true;
    }

    const recordingTitle = resolveConversationTitle(
      snapshot.events,
      providerSessionId,
      { snapshotSnippet: snapshot.metadata.snippet },
    );
    const activeOutputs = activeWorkspaceOutputs(metadata);
    for (const output of activeOutputs) {
      const clampedCursor = Math.max(
        0,
        Math.min(output.writeCursor, snapshot.events.length),
      );
      if (clampedCursor !== output.writeCursor) {
        output.writeCursor = clampedCursor;
        metadataChanged = true;
      }

      const pendingEvents = snapshot.events.slice(clampedCursor);
      if (pendingEvents.length === 0) {
        continue;
      }

      try {
        if (!recordingPipeline.appendToDestination) {
          throw new Error(
            "Recording pipeline does not support appendToDestination",
          );
        }
        const outputOverrides = await resolvePersistedWorkspaceOutputOverrides({
          output,
          captureIncludeSystemEvents,
          workspaceCatalog,
          workspaceProfileResolver,
          userConfig,
        });
        const writeResult = await recordingPipeline.appendToDestination({
          provider,
          sessionId: providerSessionId,
          targetPath: output.currentResolvedPath,
          events: pendingEvents,
          title: recordingTitle,
          ...(output.activeRecordingCycleId
            ? { recordingId: output.activeRecordingCycleId }
            : {}),
          recordingCycleIds: output.activeRecordingCycleId
            ? [output.activeRecordingCycleId]
            : undefined,
          workspaceIds: [output.workspaceId],
          outputOverrides,
        });
        if (writeResult.wrote) {
          updateWorkspaceOutputCycleLastWrite(
            output,
            now().toISOString(),
          );
        }
        output.writeCursor = snapshot.events.length;
        metadataChanged = true;
      } catch (error) {
        await operationalLogger.error(
          "recording.append.failed",
          "Failed to append events to workspace-scoped recording destination",
          {
            provider,
            sessionId: providerSessionId,
            workspaceId: output.workspaceId,
            destination: output.currentResolvedPath,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        await auditLogger.record(
          "recording.append.failed",
          "Failed to append events to workspace-scoped recording destination",
          {
            provider,
            sessionId: providerSessionId,
            workspaceId: output.workspaceId,
            destination: output.currentResolvedPath,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    if (metadataChanged) {
      metadata = await mergeLatestSessionMetadataBeforeSave(
        sessionStateStore,
        metadata,
      );
      await sessionStateStore.saveSessionMetadata(metadata);
      metadataBySessionKey.set(sessionKey, metadata);
      anyMetadataChanged = true;
    }
  }
  return anyMetadataChanged;
}

function readMetadataUpdatedAtMs(
  metadata: Pick<SessionMetadataV1, "updatedAt">,
): number {
  const parsed = Date.parse(metadata.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildWorkspaceOutputMergeKey(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
): string {
  return `${output.workspaceId}\u0000${output.currentResolvedPath}`;
}

type WorkspaceOutputStateForMerge = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number];
type WorkspaceRecordingCycleForMerge =
  WorkspaceOutputStateForMerge["recordingCycles"][number];

function readOptionalIsoTimestampMs(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function mergeLatestOrCurrentTimestamp(
  latest: string | undefined,
  current: string | undefined,
): string | undefined {
  if (!latest) {
    return current;
  }
  if (!current) {
    return latest;
  }
  return readOptionalIsoTimestampMs(current) >
      readOptionalIsoTimestampMs(latest)
    ? current
    : latest;
}

function mergeLatestOrCurrentCount(
  latest: number | undefined,
  current: number | undefined,
): number | undefined {
  if (latest === undefined) {
    return current;
  }
  if (current === undefined) {
    return latest;
  }
  return Math.max(latest, current);
}

function mergeMatchingWorkspaceRecordingCyclePreferringLatest(
  latest: WorkspaceRecordingCycleForMerge,
  current: WorkspaceRecordingCycleForMerge,
): WorkspaceRecordingCycleForMerge {
  const merged = structuredClone(latest);

  if (!merged.startedAt && current.startedAt) {
    merged.startedAt = current.startedAt;
  }

  const lastWriteAt = mergeLatestOrCurrentTimestamp(
    merged.lastWriteAt,
    current.lastWriteAt,
  );
  if (lastWriteAt !== undefined) {
    merged.lastWriteAt = lastWriteAt;
  } else {
    delete merged.lastWriteAt;
  }

  const stoppedAt = mergeLatestOrCurrentTimestamp(
    merged.stoppedAt,
    current.stoppedAt,
  );
  if (stoppedAt !== undefined) {
    merged.stoppedAt = stoppedAt;
  } else {
    delete merged.stoppedAt;
  }

  const startedBySeq = mergeLatestOrCurrentCount(
    merged.startedBySeq,
    current.startedBySeq,
  );
  if (startedBySeq !== undefined) {
    merged.startedBySeq = startedBySeq;
  } else {
    delete merged.startedBySeq;
  }

  const stoppedCursor = mergeLatestOrCurrentCount(
    merged.stoppedCursor,
    current.stoppedCursor,
  );
  if (stoppedCursor !== undefined) {
    merged.stoppedCursor = stoppedCursor;
  } else {
    delete merged.stoppedCursor;
  }

  const stoppedBySeq = mergeLatestOrCurrentCount(
    merged.stoppedBySeq,
    current.stoppedBySeq,
  );
  if (stoppedBySeq !== undefined) {
    merged.stoppedBySeq = stoppedBySeq;
  } else {
    delete merged.stoppedBySeq;
  }

  return merged;
}

function mergeWorkspaceRecordingCyclesPreferringLatest(
  latest: WorkspaceOutputStateForMerge["recordingCycles"],
  current: WorkspaceOutputStateForMerge["recordingCycles"],
): WorkspaceOutputStateForMerge["recordingCycles"] {
  const merged = structuredClone(latest);
  const indexByCycleId = new Map(
    merged.map((cycle, index) => [cycle.recordingCycleId, index]),
  );

  for (const cycle of current) {
    const existingIndex = indexByCycleId.get(cycle.recordingCycleId);
    if (existingIndex === undefined) {
      merged.push(structuredClone(cycle));
      indexByCycleId.set(cycle.recordingCycleId, merged.length - 1);
      continue;
    }
    merged[existingIndex] =
      mergeMatchingWorkspaceRecordingCyclePreferringLatest(
        merged[existingIndex],
        cycle,
      );
  }

  return merged;
}

function mergeMatchingWorkspaceOutputPreferringLatest(
  latest: WorkspaceOutputStateForMerge,
  current: WorkspaceOutputStateForMerge,
): WorkspaceOutputStateForMerge {
  const merged = structuredClone(latest);

  if (!merged.workspaceAliasSnapshot && current.workspaceAliasSnapshot) {
    merged.workspaceAliasSnapshot = current.workspaceAliasSnapshot;
  }
  if (!merged.sourceConfigPath && current.sourceConfigPath) {
    merged.sourceConfigPath = current.sourceConfigPath;
  }
  if (!merged.createdAt && current.createdAt) {
    merged.createdAt = current.createdAt;
  }

  merged.writeCursor = Math.max(merged.writeCursor, current.writeCursor);
  merged.recordingCycles = mergeWorkspaceRecordingCyclesPreferringLatest(
    merged.recordingCycles,
    current.recordingCycles,
  );

  if (
    merged.desiredState === "on" &&
    !merged.activeRecordingCycleId &&
    current.activeRecordingCycleId
  ) {
    merged.activeRecordingCycleId = current.activeRecordingCycleId;
  }
  if (merged.desiredState === "off") {
    delete merged.activeRecordingCycleId;
  }

  return merged;
}

function mergeWorkspaceOutputsPreferringLatest(
  latest: SessionMetadataV1["workspaceOutputs"],
  current: SessionMetadataV1["workspaceOutputs"],
): SessionMetadataV1["workspaceOutputs"] {
  const merged = latest ? structuredClone(latest) : [];
  const indexByKey = new Map(
    merged.map((
      output,
      index,
    ) => [buildWorkspaceOutputMergeKey(output), index]),
  );
  for (const output of current ?? []) {
    const key = buildWorkspaceOutputMergeKey(output);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeMatchingWorkspaceOutputPreferringLatest(
        merged[existingIndex],
        output,
      );
      continue;
    }
    merged.push(structuredClone(output));
    indexByKey.set(key, merged.length - 1);
  }
  return merged.length > 0 ? merged : undefined;
}

async function loadLatestSessionMetadataForMerge(
  sessionStateStore: PersistentSessionStateStore,
  metadata: SessionMetadataV1,
): Promise<SessionMetadataV1 | undefined> {
  return (await sessionStateStore.listSessionMetadata()).find((entry) =>
    entry.sessionKey === metadata.sessionKey ||
    entry.providerSessionId === metadata.providerSessionId ||
    entry.sessionId === metadata.sessionId
  ) as SessionMetadataV1 | undefined;
}

async function mergeLatestSessionMetadataBeforeSave(
  sessionStateStore: PersistentSessionStateStore,
  metadata: SessionMetadataV1,
): Promise<SessionMetadataV1> {
  const latest = await loadLatestSessionMetadataForMerge(
    sessionStateStore,
    metadata,
  );
  if (!latest || latest.sessionKey !== metadata.sessionKey) {
    return metadata;
  }

  const merged = structuredClone(latest) as SessionMetadataV1;
  merged.ingestCursor = structuredClone(metadata.ingestCursor);
  merged.nextTwinSeq = metadata.nextTwinSeq;
  merged.recentFingerprints = [...metadata.recentFingerprints];
  if (metadata.lastObservedMtimeMs !== undefined) {
    merged.lastObservedMtimeMs = metadata.lastObservedMtimeMs;
  } else {
    delete merged.lastObservedMtimeMs;
  }
  if (metadata.ingestionActivatedAt !== undefined) {
    merged.ingestionActivatedAt = metadata.ingestionActivatedAt;
  } else {
    delete merged.ingestionActivatedAt;
  }
  if (metadata.commandCursor !== undefined) {
    merged.commandCursor = metadata.commandCursor;
  } else {
    delete merged.commandCursor;
  }
  if (metadata.commandCursorAnchor !== undefined) {
    merged.commandCursorAnchor = structuredClone(metadata.commandCursorAnchor);
  } else {
    delete merged.commandCursorAnchor;
  }

  if (readMetadataUpdatedAtMs(latest) <= readMetadataUpdatedAtMs(metadata)) {
    if (metadata.workspaceOutputs) {
      merged.workspaceOutputs = structuredClone(metadata.workspaceOutputs);
    } else {
      delete merged.workspaceOutputs;
    }
    return merged;
  }

  const preservedWorkspaceOutputs = mergeWorkspaceOutputsPreferringLatest(
    latest.workspaceOutputs,
    metadata.workspaceOutputs,
  );
  if (preservedWorkspaceOutputs) {
    merged.workspaceOutputs = preservedWorkspaceOutputs;
  } else {
    delete merged.workspaceOutputs;
  }
  return merged;
}

function summarizeControlCommands(
  requests: DaemonControlRequest[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const request of requests) {
    summary[request.command] = (summary[request.command] ?? 0) + 1;
  }
  return summary;
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
  const sessionMetadataRefreshIntervalMs = Math.max(
    options.sessionMetadataRefreshIntervalMs ?? heartbeatIntervalMs,
    pollIntervalMs,
  );
  const exportEnabled = options.exportEnabled ?? true;
  const exportsLogPath = options.exportsLogPath;
  const clearControlQueueOnStartup = options.clearControlQueueOnStartup ??
    false;
  const cleanSessionStatesOnShutdown = options.cleanSessionStatesOnShutdown ??
    false;
  const daemonFeatureFlags = options.daemonFeatureFlags ?? {
    daemonExportEnabled: true,
    captureIncludeSystemEvents: false,
  };
  const userConfig = options.userConfig
    ? {
      schemaVersion: options.userConfig.schemaVersion,
      participants: {
        defaultUsername: options.userConfig.participants.defaultUsername,
        workspaceUsernames: {
          ...options.userConfig.participants.workspaceUsernames,
        },
        excludeMeFromParticipantList:
          options.userConfig.participants.excludeMeFromParticipantList,
      },
    }
    : createDefaultUserConfig();
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
  const sessionStateStore = options.sessionStateStore;
  const workspaceRegistryStore = options.workspaceRegistryStore ??
    new WorkspaceRegistryFileStore(resolveDefaultWorkspaceRegistryPath());
  const workspaceCatalog = options.workspaceCatalog ??
    new WorkspaceCatalog(workspaceRegistryStore);
  const workspaceProfileResolver = options.workspaceProfileResolver ??
    new WorkspaceProfileResolver();
  const loadSessionSnapshot = options.loadSessionSnapshot ??
    ((sessionSnapshotStore || sessionStateStore)
      ? async (sessionId: string) => {
        const metadata = sessionStateStore
          ? (await sessionStateStore.listSessionMetadata()).find((entry) =>
            entry.providerSessionId === sessionId ||
            entry.sessionId === sessionId
          )
          : undefined;
        if (metadata && sessionStateStore) {
          const liveSnapshot = sessionSnapshotStore?.get(
            metadata.providerSessionId,
          );
          try {
            const history = await loadPersistedSessionHistoryEvents(
              metadata,
              sessionStateStore,
              { secretsPolicy: options.secretsPolicy },
            );
            if (history.source === "twin" && liveSnapshot) {
              return {
                provider: liveSnapshot.provider,
                events: liveSnapshot.events,
              };
            }
            if (history.events.length > 0) {
              return {
                provider: metadata.provider,
                events: history.events,
              };
            }
          } catch {
            // Fall back to the live snapshot when persisted history cannot load.
          }
          if (liveSnapshot) {
            return {
              provider: liveSnapshot.provider,
              events: liveSnapshot.events,
            };
          }
          return undefined;
        }

        const snapshot = sessionSnapshotStore?.get(sessionId);
        if (!snapshot) {
          return undefined;
        }
        return {
          provider: snapshot.provider,
          events: snapshot.events,
        };
      }
      : undefined);

  let snapshot = createDefaultStatusSnapshot(now());
  snapshot = {
    ...snapshot,
    daemonRunning: true,
    daemonPid: pid,
    daemonVersion: DAEMON_APP_VERSION,
  };
  await statusStore.save(snapshot);
  const processEventsFromMs = now().getTime();

  await operationalLogger.info(
    "daemon.runtime.started",
    "Daemon runtime loop started",
    { pid },
  );

  if (clearControlQueueOnStartup) {
    const startupRequests = await controlStore.list();
    if (startupRequests.length > 0) {
      const lastStartupRequest = startupRequests.at(-1);
      if (!lastStartupRequest) {
        throw new Error(
          "startup control queue unexpectedly empty while attempting to clear",
        );
      }
      await controlStore.markProcessed(lastStartupRequest.requestId);
      const commandSummary = summarizeControlCommands(startupRequests);
      await operationalLogger.info(
        "daemon.control.queue.cleared_on_startup",
        "Daemon startup discarded queued control requests",
        {
          discardedRequests: startupRequests.length,
          discardedByCommand: commandSummary,
          lastDiscardedRequestId: lastStartupRequest.requestId,
        },
      );
      await auditLogger.record(
        "daemon.control.queue.cleared_on_startup",
        "Daemon startup discarded queued control requests",
        {
          discardedRequests: startupRequests.length,
          discardedByCommand: commandSummary,
          lastDiscardedRequestId: lastStartupRequest.requestId,
        },
      );
    }
  }

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
  let cachedSummaryMetadata: SessionMetadataV1[] | undefined;
  let cachedSummaryMetadataAtMs = 0;
  let summaryMetadataDirty = true;
  const loadSummaryMetadata = async (
    forceRefresh: boolean = false,
  ): Promise<SessionMetadataV1[] | undefined> => {
    if (!sessionStateStore) {
      return undefined;
    }
    const currentTimeMs = now().getTime();
    const cacheStale = currentTimeMs - cachedSummaryMetadataAtMs >=
      sessionMetadataRefreshIntervalMs;
    if (
      forceRefresh ||
      summaryMetadataDirty ||
      !cachedSummaryMetadata ||
      cacheStale
    ) {
      cachedSummaryMetadata = await sessionStateStore.listSessionMetadata();
      cachedSummaryMetadataAtMs = currentTimeMs;
      summaryMetadataDirty = false;
    }
    return cachedSummaryMetadata;
  };

  while (!shouldStop) {
    let sessionMetadataMayHaveChanged = false;
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
          if (sessionStateStore) {
            sessionMetadataMayHaveChanged = true;
          }
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
        if (sessionStateStore) {
          const persistentUpdatesChanged =
            await processPersistentRecordingUpdates({
              sessionSnapshotStore,
              sessionStateStore,
              recordingPipeline,
              operationalLogger,
              auditLogger,
              processEventsFromMs,
              now,
              captureIncludeSystemEvents:
                daemonFeatureFlags.captureIncludeSystemEvents,
              workspaceCatalog,
              workspaceProfileResolver,
              userConfig,
              secretsPolicy: options.secretsPolicy,
            });
          sessionMetadataMayHaveChanged = sessionMetadataMayHaveChanged ||
            persistentUpdatesChanged;
        } else {
          await processInChatRecordingUpdates({
            sessionSnapshotStore,
            sessionEventStates,
            recordingPipeline,
            operationalLogger,
            auditLogger,
            processEventsFromMs,
            now,
            captureIncludeSystemEvents:
              daemonFeatureFlags.captureIncludeSystemEvents,
            workspaceCatalog,
            workspaceProfileResolver,
            userConfig,
          });
        }
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
    if (sessionStateStore && requests.length > 0) {
      sessionMetadataMayHaveChanged = true;
    }
    for (const request of requests) {
      shouldStop = await handleControlRequest({
        request,
        controlStore,
        recordingPipeline,
        sessionStateStore,
        loadSessionSnapshot,
        exportEnabled,
        defaultCliExportOutputOverrides:
          options.defaultCliExportOutputOverrides,
        exportsLogPath,
        now,
        operationalLogger,
        auditLogger,
      });
      if (shouldStop) break;
    }

    if (sessionMetadataMayHaveChanged) {
      summaryMetadataDirty = true;
    }
    const summaryMetadata = await loadSummaryMetadata();

    const currentTimeMs = now().getTime();
    if (currentTimeMs >= nextHeartbeatAt) {
      const currentIso = now().toISOString();
      const heartbeatNow = now();
      const sessionList = sessionSnapshotStore?.listMetadataOnly?.() ??
        sessionSnapshotStore?.list() ?? [];
      const heartbeatMetadata = sessionStateStore
        ? summaryMetadata ?? await loadSummaryMetadata()
        : undefined;
      const heartbeatMetadataByKey = heartbeatMetadata
        ? new Map(heartbeatMetadata.map((entry) => [entry.sessionKey, entry]))
        : undefined;
      const heartbeatActiveRecordings = heartbeatMetadata
        ? toActiveRecordingsFromMetadata(heartbeatMetadata)
        : recordingPipeline.listActiveRecordings();
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
          heartbeatActiveRecordings,
          heartbeatNow,
          providerStatusStaleAfterMs,
          heartbeatMetadataByKey,
        )
        : snapshot.sessions;
      const recordingSummary = summarizeRecordingStatus(
        heartbeatActiveRecordings,
        sessions,
      );

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
        recordings: {
          activeRecordings: recordingSummary.activeRecordings,
          destinations: recordingSummary.destinations,
        },
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

  if (cleanSessionStatesOnShutdown && sessionStateStore) {
    const cleanupResult = await sessionStateStore.deleteSessionTwinFiles();
    if (cleanupResult.failed > 0) {
      await operationalLogger.warn(
        "session.state.cleanup.partial_failure",
        "Failed to remove one or more session twin files during shutdown cleanup",
        cleanupResult,
      );
    } else {
      await operationalLogger.info(
        "session.state.cleanup.completed",
        "Removed persisted session twin files during shutdown cleanup",
        cleanupResult,
      );
    }
  }

  const exitIso = now().toISOString();
  const exitNow = now();
  const exitSessionList = sessionSnapshotStore?.listMetadataOnly?.() ??
    sessionSnapshotStore?.list() ?? [];
  const exitMetadata = await loadSummaryMetadata(true);
  const exitMetadataByKey = exitMetadata
    ? new Map(exitMetadata.map((entry) => [entry.sessionKey, entry]))
    : undefined;
  const exitActiveRecordings = exitMetadata
    ? toActiveRecordingsFromMetadata(exitMetadata)
    : recordingPipeline.listActiveRecordings();
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
      exitActiveRecordings,
      exitNow,
      providerStatusStaleAfterMs,
      exitMetadataByKey,
    )
    : snapshot.sessions;
  const recordingSummary = summarizeRecordingStatus(
    exitActiveRecordings,
    sessions,
  );

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
    recordings: {
      activeRecordings: recordingSummary.activeRecordings,
      destinations: recordingSummary.destinations,
    },
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
  sessionStateStore?: PersistentSessionStateStore;
  loadSessionSnapshot?: (
    sessionId: string,
  ) => Promise<SessionExportSnapshot | undefined>;
  exportEnabled: boolean;
  defaultCliExportOutputOverrides?: RecordingOutputOverrides;
  exportsLogPath?: string;
  now: () => Date;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
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
    sessionStateStore,
    loadSessionSnapshot,
    exportEnabled,
    defaultCliExportOutputOverrides,
    exportsLogPath,
    now,
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
    await handleExportControlRequest({
      request,
      recordingPipeline,
      sessionStateStore,
      loadSessionSnapshot,
      exportEnabled,
      defaultCliExportOutputOverrides,
      exportsLogPath,
      now,
      operationalLogger,
      auditLogger,
      resolveTitle: resolveConversationTitle,
    });
  }

  await controlStore.markProcessed(request.requestId);

  if (request.command === "stop") {
    return true;
  }

  return false;
}
