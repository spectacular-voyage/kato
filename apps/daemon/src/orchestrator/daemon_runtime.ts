import type {
  ConversationEvent,
  DaemonSessionStatus,
  ProviderStatus,
  SessionMetadataV1,
} from "@kato/shared";
import {
  extractSnippet,
  projectSessionStatus,
  sortSessionsByRecency,
} from "@kato/shared";
import { dirname, isAbsolute, join } from "@std/path";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import {
  type InChatControlCommand,
  detectInChatControlCommands,
  resolveDefaultAllowedWriteRoots,
  WritePathPolicyGate,
} from "../policy/mod.ts";
import { renderFrontmatter } from "../writer/frontmatter.ts";
import {
  type ActiveRecording,
  RecordingPipeline,
  type RecordingPipelineLike,
} from "../writer/mod.ts";
import { resolveHomeDir } from "../utils/env.ts";
import { appendExportsLogEntry } from "../utils/exports_log.ts";
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
  SessionSnapshotMetadataEntry,
  SessionSnapshotStore,
  SnapshotMemoryStats,
} from "./ingestion_runtime.ts";
import { SessionSnapshotMemoryBudgetExceededError } from "./ingestion_runtime.ts";
import {
  makeDefaultSessionCursor,
  type PersistentSessionStateStore,
} from "./session_state_store.ts";
import { mapTwinEventsToConversation } from "./session_twin_mapper.ts";

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
  cleanSessionStatesOnShutdown?: boolean;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROVIDER_STATUS_STALE_AFTER_MS = 5 * 60_000;
const MARKDOWN_LINK_PATH_PATTERN = /^\[[^\]]+\]\((.+)\)$/;
const KNOWN_EXPORT_PROVIDER_PREFIXES = new Set(["claude", "codex", "gemini"]);

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
  lastSeenFileModifiedAtMs?: number;
  primaryRecordingDestination?: string;
}

interface ProcessInChatRecordingUpdatesOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionEventStates: Map<string, SessionEventProcessingState>;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  processEventsFromMs: number;
  now: () => Date;
}

interface ProcessPersistentRecordingUpdatesOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore: PersistentSessionStateStore;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  now: () => Date;
}

interface ApplyControlCommandsForEventOptions {
  provider: string;
  sessionId: string;
  events: ConversationEvent[];
  eventIndex: number;
  event: ConversationEvent & { kind: "message.user" };
  sessionEventState: SessionEventProcessingState;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  now: () => Date;
}

function makeSessionProcessingKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function makeRuntimeEventSignature(event: ConversationEvent): string {
  const base = `${event.kind}\0${event.source.providerEventType}\0${
    event.source.providerEventId ?? ""
  }\0${event.timestamp}`;
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

function normalizeRawCommandTargetPath(
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

  return normalized.length > 0 ? normalized : undefined;
}

function resolveExplicitAbsolutePathArgument(
  rawArgument: string | undefined,
): { path?: string; reason?: string } {
  const normalized = normalizeRawCommandTargetPath(rawArgument);
  if (!normalized) {
    return { reason: "Path argument is missing" };
  }
  if (normalized.startsWith("@")) {
    return {
      reason: "Path argument must be an absolute filesystem path (mentions are not allowed)",
    };
  }
  if (!isAbsolute(normalized)) {
    return { reason: "Path argument must be absolute" };
  }
  return { path: normalized };
}

function normalizePrimaryDestination(
  metadata: SessionMetadataV1,
): string | undefined {
  const raw = metadata.primaryRecordingDestination;
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function setPrimaryDestination(
  metadata: SessionMetadataV1,
  destination: string | undefined,
): void {
  const normalized = destination?.trim();
  if (!normalized) {
    delete metadata.primaryRecordingDestination;
    return;
  }
  metadata.primaryRecordingDestination = normalized;
}

function resolveConversationTitle(
  events: ConversationEvent[],
  fallback: string,
): string {
  const snippet = extractSnippet(events);
  if (snippet && snippet.trim().length > 0) {
    return snippet;
  }
  return fallback;
}

interface PersistentRecordingCommandContext {
  provider: string;
  providerSessionId: string;
  events: ConversationEvent[];
  eventIndex: number;
  event: ConversationEvent & { kind: "message.user" };
  metadata: SessionMetadataV1;
  sessionStateStore: PersistentSessionStateStore;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  now: () => Date;
}

interface InChatCommandBoundary {
  command: InChatControlCommand;
  nextCommandLine: number;
  lastLineInSegment: number;
}

interface InitFrontmatterSettings {
  includeFrontmatter: boolean;
  includeUpdatedInFrontmatter: boolean;
  includeConversationEventKinds: boolean;
  participantUsername?: string;
}

interface RecordingPipelineFrontmatterSettingsProvider {
  getMarkdownFrontmatterSettings?(): InitFrontmatterSettings;
}

function resolveDefaultRecordingRootDir(): string {
  const home = resolveHomeDir();
  if (home) {
    return join(home, ".kato", "recordings");
  }
  return join(".kato", "recordings");
}

function sanitizeFilenamePart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(
    /-+/g,
    "-",
  ).replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "recording";
}

function makeDefaultRecordingDestinationPath(
  provider: string,
  sessionId: string,
  now: Date,
): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const shortSession = sessionId.slice(0, 8);
  const fileName = `${
    sanitizeFilenamePart(provider)
  }-${shortSession}-${iso}.md`;
  return join(resolveDefaultRecordingRootDir(), fileName);
}

function readCommandCursor(metadata: SessionMetadataV1): number {
  const raw = metadata.commandCursor;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return 0;
  }
  return raw;
}

function writeCommandCursor(metadata: SessionMetadataV1, cursor: number): void {
  metadata.commandCursor = Math.max(0, Math.floor(cursor));
}

function openRecordingPeriod(
  metadata: SessionMetadataV1,
  recordingId: string,
  startedCursor: number,
  nowIso: string,
  startedBySeq: number,
): void {
  const recording = metadata.recordings.find((entry) =>
    entry.recordingId === recordingId
  );
  if (!recording) return;
  recording.periods.push({
    startedCursor,
    startedAt: nowIso,
    startedBySeq,
  });
}

function closeRecordingPeriod(
  metadata: SessionMetadataV1,
  recordingId: string,
  stoppedCursor: number,
  nowIso: string,
  stoppedBySeq: number,
): void {
  const recording = metadata.recordings.find((entry) =>
    entry.recordingId === recordingId
  );
  if (!recording) return;

  for (let i = recording.periods.length - 1; i >= 0; i -= 1) {
    const period = recording.periods[i];
    if (!period || period.stoppedCursor !== undefined) continue;
    period.stoppedCursor = stoppedCursor;
    period.stoppedAt = nowIso;
    period.stoppedBySeq = stoppedBySeq;
    return;
  }
}

function activeSessionRecordings(
  metadata: SessionMetadataV1,
): SessionMetadataV1["recordings"] {
  return metadata.recordings.filter((entry) => entry.desiredState === "on");
}

function findRecordingByDestination(
  metadata: SessionMetadataV1,
  destination: string,
): SessionMetadataV1["recordings"][number] | undefined {
  return metadata.recordings.find((entry) => entry.destination === destination);
}

function createDestinationRecording(
  destination: string,
  writeCursor: number,
  nowIso: string,
): SessionMetadataV1["recordings"][number] {
  return {
    recordingId: crypto.randomUUID(),
    destination,
    desiredState: "off",
    writeCursor,
    createdAt: nowIso,
    periods: [],
  };
}

function listRecordingIdsForDestination(
  metadata: SessionMetadataV1,
  destination: string,
  pending?: SessionMetadataV1["recordings"][number],
): string[] {
  const ids = new Set<string>();
  for (const entry of metadata.recordings) {
    if (entry.destination === destination) {
      ids.add(entry.recordingId);
    }
  }
  if (pending && pending.destination === destination) {
    ids.add(pending.recordingId);
  }
  return Array.from(ids);
}

function deactivateActiveRecordings(
  metadata: SessionMetadataV1,
  stopCursor: number,
  nowIso: string,
): string[] {
  const changed: string[] = [];
  for (const recording of metadata.recordings) {
    if (recording.desiredState !== "on") {
      continue;
    }
    recording.desiredState = "off";
    closeRecordingPeriod(
      metadata,
      recording.recordingId,
      stopCursor,
      nowIso,
      stopCursor,
    );
    changed.push(recording.recordingId);
  }
  return changed;
}

function resolveCommandBoundaries(
  content: string,
  commands: InChatControlCommand[],
): InChatCommandBoundary[] {
  if (commands.length === 0) {
    return [];
  }
  const totalLines = content.replace(/\r\n?/g, "\n").split("\n").length;
  return commands.map((command, index) => {
    const nextCommandLine = commands[index + 1]?.line ?? (totalLines + 1);
    const lastLineInSegment = Math.max(command.line, nextCommandLine - 1);
    return {
      command,
      nextCommandLine,
      lastLineInSegment,
    };
  });
}

function sliceContentByLineRange(
  content: string,
  startLineInclusive: number,
  endLineInclusive: number,
): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const start = Math.max(1, startLineInclusive);
  const end = Math.min(lines.length, endLineInclusive);
  if (end < start) {
    return "";
  }
  return lines.slice(start - 1, end).join("\n");
}

function withUserEventContent(
  event: ConversationEvent & { kind: "message.user" },
  content: string,
): ConversationEvent & { kind: "message.user" } {
  return {
    ...event,
    content,
  };
}

function buildBoundarySnapshotEvents(
  events: ConversationEvent[],
  eventIndex: number,
  event: ConversationEvent & { kind: "message.user" },
  boundaryLine: number,
): ConversationEvent[] {
  const slice = events.slice(0, eventIndex + 1);
  if (slice.length === 0) {
    return [];
  }
  const boundaryContent = sliceContentByLineRange(event.content, 1, boundaryLine);
  slice[slice.length - 1] = withUserEventContent(event, boundaryContent);
  return slice;
}

function buildCommandSeedEvents(
  event: ConversationEvent & { kind: "message.user" },
  startLineInclusive: number,
  endLineInclusive: number,
): ConversationEvent[] {
  const content = sliceContentByLineRange(
    event.content,
    startLineInclusive,
    endLineInclusive,
  );
  if (content.trim().length === 0) {
    return [];
  }
  return [withUserEventContent(event, content)];
}

function resolvePrimaryDestination(
  metadata: SessionMetadataV1,
  provider: string,
  katoSessionId: string,
  now: () => Date,
): string {
  const fromPointer = normalizePrimaryDestination(metadata);
  if (fromPointer && isAbsolute(fromPointer)) {
    return fromPointer;
  }
  return makeDefaultRecordingDestinationPath(provider, katoSessionId, now());
}

async function validateDestinationPathForCommand(
  recordingPipeline: RecordingPipelineLike,
  provider: string,
  sessionId: string,
  destination: string,
  commandName: "record" | "capture" | "export",
): Promise<string> {
  if (!recordingPipeline.validateDestinationPath) {
    return destination;
  }
  return await recordingPipeline.validateDestinationPath({
    provider,
    sessionId,
    targetPath: destination,
    commandName,
  });
}

function resolveFrontmatterSettings(
  recordingPipeline: RecordingPipelineLike,
): InitFrontmatterSettings {
  const provider = recordingPipeline as RecordingPipelineFrontmatterSettingsProvider;
  if (provider.getMarkdownFrontmatterSettings) {
    return provider.getMarkdownFrontmatterSettings();
  }
  return {
    includeFrontmatter: true,
    includeUpdatedInFrontmatter: true,
    includeConversationEventKinds: true,
  };
}

function buildFrontmatterParticipants(
  provider: string,
  events: ConversationEvent[],
  participantUsername: string | undefined,
): string[] | undefined {
  const participants: string[] = [];
  if (participantUsername) {
    participants.push(`user.${participantUsername}`);
  }
  const assistantParticipants = new Set<string>();
  for (const event of events) {
    if (event.kind !== "message.assistant") {
      continue;
    }
    const eventProvider = event.provider?.trim() || provider;
    const model = event.model?.trim();
    assistantParticipants.add(
      model && model.length > 0
        ? `${eventProvider}.${model}`
        : `${eventProvider}.assistant`,
    );
  }
  participants.push(
    ...Array.from(assistantParticipants).sort((a, b) => a.localeCompare(b)),
  );
  return participants.length > 0 ? participants : undefined;
}

function buildFrontmatterConversationKinds(
  events: ConversationEvent[],
): string[] | undefined {
  const kinds = Array.from(new Set(events.map((event) => event.kind)))
    .sort((a, b) => a.localeCompare(b));
  return kinds.length > 0 ? kinds : undefined;
}

function isMarkdownDestination(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

async function prepareInitDestination(
  destination: string,
  provider: string,
  providerSessionId: string,
  boundaryEvents: ConversationEvent[],
  recordingId: string,
  recordingPipeline: RecordingPipelineLike,
  now: () => Date,
): Promise<void> {
  await Deno.mkdir(dirname(destination), { recursive: true });
  try {
    const stat = await Deno.stat(destination);
    if (stat.isFile) {
      return;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  if (!isMarkdownDestination(destination)) {
    await Deno.writeTextFile(destination, "");
    return;
  }

  const frontmatterSettings = resolveFrontmatterSettings(recordingPipeline);
  if (!frontmatterSettings.includeFrontmatter) {
    await Deno.writeTextFile(destination, "");
    return;
  }

  const title = resolveConversationTitle(boundaryEvents, providerSessionId);
  const participants = buildFrontmatterParticipants(
    provider,
    boundaryEvents,
    frontmatterSettings.participantUsername,
  );
  const conversationEventKinds = frontmatterSettings.includeConversationEventKinds
    ? buildFrontmatterConversationKinds(boundaryEvents)
    : undefined;
  const frontmatter = renderFrontmatter({
    title,
    now: now(),
    sessionId: providerSessionId,
    recordingIds: [recordingId],
    participants,
    conversationEventKinds,
    includeUpdated: frontmatterSettings.includeUpdatedInFrontmatter,
  });
  await Deno.writeTextFile(destination, `${frontmatter}\n`);
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
    candidate.timestamp.length > 0 &&
    commandEvent.timestamp.length > 0 &&
    candidate.timestamp !== commandEvent.timestamp
  ) {
    return false;
  }

  return true;
}

async function resolveBoundaryEventsFromTwinStart(
  metadata: SessionMetadataV1,
  fallbackBoundaryEvents: ConversationEvent[],
  commandEvent: ConversationEvent & { kind: "message.user" },
  boundaryLine: number,
  sessionStateStore: PersistentSessionStateStore,
): Promise<ConversationEvent[]> {
  let twinEvents: Awaited<
    ReturnType<PersistentSessionStateStore["readTwinEvents"]>
  >;
  try {
    twinEvents = await sessionStateStore.readTwinEvents(metadata, 1);
  } catch {
    return fallbackBoundaryEvents;
  }
  if (twinEvents.length === 0) {
    return fallbackBoundaryEvents;
  }

  const twinConversation = mapTwinEventsToConversation(twinEvents);
  if (twinConversation.length === 0) {
    return fallbackBoundaryEvents;
  }

  let boundaryIndex = -1;
  for (let i = 0; i < twinConversation.length; i += 1) {
    const candidate = twinConversation[i];
    if (!candidate) continue;
    if (matchesCaptureBoundaryEvent(candidate, commandEvent)) {
      boundaryIndex = i;
    }
  }

  if (boundaryIndex >= 0) {
    const slice = twinConversation.slice(0, boundaryIndex + 1);
    const boundaryEvent = slice[slice.length - 1];
    if (boundaryEvent?.kind === "message.user") {
      const boundaryContent = sliceContentByLineRange(
        boundaryEvent.content,
        1,
        boundaryLine,
      );
      slice[slice.length - 1] = withUserEventContent(
        boundaryEvent,
        boundaryContent,
      );
    }
    return slice;
  }
  return fallbackBoundaryEvents;
}

async function logInvalidTargetForCommand(options: {
  provider: string;
  sessionId: string;
  eventId: string;
  command: string;
  rawArgument: string | undefined;
  reason: string;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}): Promise<void> {
  const {
    provider,
    sessionId,
    eventId,
    command,
    rawArgument,
    reason,
    operationalLogger,
    auditLogger,
  } = options;
  await operationalLogger.warn(
    "recording.command.invalid_target",
    "Skipping in-chat control command because target path is invalid",
    {
      provider,
      sessionId,
      eventId,
      command,
      rawArgument,
      reason,
    },
  );
  await auditLogger.record(
    "recording.command.invalid_target",
    "In-chat control command target path invalid",
    {
      provider,
      sessionId,
      eventId,
      command,
      rawArgument,
      reason,
    },
  );
}

async function applyPersistentControlCommandsForEvent(
  ctx: PersistentRecordingCommandContext,
): Promise<boolean> {
  const {
    provider,
    providerSessionId,
    events,
    eventIndex,
    event,
    metadata,
    sessionStateStore,
    recordingPipeline,
    operationalLogger,
    auditLogger,
    now,
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
    );
    let commandNoop = false;
    let loggedTargetPath: string | undefined;

    try {
      if (command.name === "init") {
        const explicit = command.argument
          ? resolveExplicitAbsolutePathArgument(command.argument)
          : undefined;
        if (command.argument && !explicit?.path) {
          await logInvalidTargetForCommand({
            provider,
            sessionId: providerSessionId,
            eventId: event.eventId,
            command: command.name,
            rawArgument: command.argument,
            reason: explicit?.reason ?? "Path argument is invalid",
            operationalLogger,
            auditLogger,
          });
          continue;
        }
        const destination = explicit?.path ??
          resolvePrimaryDestination(metadata, provider, metadata.sessionId, now);
        const resolvedDestination = await validateDestinationPathForCommand(
          recordingPipeline,
          provider,
          providerSessionId,
          destination,
          "record",
        );
        loggedTargetPath = resolvedDestination;
        const nowIso = now().toISOString();
        const existing = findRecordingByDestination(metadata, resolvedDestination);
        const pending = existing ?? createDestinationRecording(
          resolvedDestination,
          writeCursor,
          nowIso,
        );
        const boundaryEvents = await resolveBoundaryEventsFromTwinStart(
          metadata,
          boundarySnapshot,
          event,
          command.line,
          sessionStateStore,
        );
        await prepareInitDestination(
          resolvedDestination,
          provider,
          providerSessionId,
          boundaryEvents,
          pending.recordingId,
          recordingPipeline,
          now,
        );
        const deactivated = deactivateActiveRecordings(metadata, writeCursor, nowIso);
        const previousPointer = normalizePrimaryDestination(metadata);
        if (!existing) {
          metadata.recordings.push(pending);
        }
        pending.desiredState = "off";
        pending.writeCursor = writeCursor;
        setPrimaryDestination(metadata, resolvedDestination);
        if (
          deactivated.length > 0 ||
          !existing ||
          previousPointer !== resolvedDestination
        ) {
          metadataChanged = true;
        }
      } else if (command.name === "record") {
        const destination = resolvePrimaryDestination(
          metadata,
          provider,
          metadata.sessionId,
          now,
        );
        const resolvedDestination = await validateDestinationPathForCommand(
          recordingPipeline,
          provider,
          providerSessionId,
          destination,
          "record",
        );
        loggedTargetPath = resolvedDestination;
        const existing = findRecordingByDestination(metadata, resolvedDestination);
        const active = activeSessionRecordings(metadata);
        const activeOnResolvedDestination = active.some((entry) =>
          entry.destination === resolvedDestination
        );
        if (activeOnResolvedDestination) {
          setPrimaryDestination(metadata, resolvedDestination);
          commandNoop = true;
        } else {
          const nowIso = now().toISOString();
          const pending = existing ?? createDestinationRecording(
            resolvedDestination,
            writeCursor,
            nowIso,
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
            await recordingPipeline.appendToDestination({
              provider,
              sessionId: providerSessionId,
              targetPath: resolvedDestination,
              events: seedEvents,
              title: boundarySnapshotTitle,
              recordingId: pending.recordingId,
              recordingIds: listRecordingIdsForDestination(
                metadata,
                resolvedDestination,
                pending,
              ),
            });
          }
          deactivateActiveRecordings(metadata, writeCursor, nowIso);
          if (!existing) {
            metadata.recordings.push(pending);
          }
          pending.desiredState = "on";
          pending.writeCursor = writeCursor;
          setPrimaryDestination(metadata, resolvedDestination);
          openRecordingPeriod(
            metadata,
            pending.recordingId,
            writeCursor,
            nowIso,
            writeCursor,
          );
          metadataChanged = true;
        }
      } else if (command.name === "capture") {
        const explicit = command.argument
          ? resolveExplicitAbsolutePathArgument(command.argument)
          : undefined;
        if (command.argument && !explicit?.path) {
          await logInvalidTargetForCommand({
            provider,
            sessionId: providerSessionId,
            eventId: event.eventId,
            command: command.name,
            rawArgument: command.argument,
            reason: explicit?.reason ?? "Path argument is invalid",
            operationalLogger,
            auditLogger,
          });
          continue;
        }
        const destination = explicit?.path ??
          resolvePrimaryDestination(metadata, provider, metadata.sessionId, now);
        const resolvedDestination = await validateDestinationPathForCommand(
          recordingPipeline,
          provider,
          providerSessionId,
          destination,
          "capture",
        );
        loggedTargetPath = resolvedDestination;
        const nowIso = now().toISOString();
        const existing = findRecordingByDestination(metadata, resolvedDestination);
        const pending = existing ?? createDestinationRecording(
          resolvedDestination,
          writeCursor,
          nowIso,
        );
        const captureEvents = await resolveBoundaryEventsFromTwinStart(
          metadata,
          boundarySnapshot,
          event,
          command.line,
          sessionStateStore,
        );
        const captureTitle = resolveConversationTitle(
          captureEvents,
          providerSessionId,
        );
        await recordingPipeline.captureSnapshot({
          provider,
          sessionId: providerSessionId,
          targetPath: resolvedDestination,
          events: captureEvents,
          title: captureTitle,
          recordingIds: [pending.recordingId],
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
            targetPath: resolvedDestination,
            events: continuationEvents,
            title: captureTitle,
            recordingId: pending.recordingId,
            recordingIds: listRecordingIdsForDestination(
              metadata,
              resolvedDestination,
              pending,
            ),
          });
        }
        deactivateActiveRecordings(metadata, writeCursor, nowIso);
        if (!existing) {
          metadata.recordings.push(pending);
        }
        pending.desiredState = "on";
        pending.writeCursor = writeCursor;
        setPrimaryDestination(metadata, resolvedDestination);
        openRecordingPeriod(
          metadata,
          pending.recordingId,
          writeCursor,
          nowIso,
          writeCursor,
        );
        metadataChanged = true;
      } else if (command.name === "export") {
        const explicit = resolveExplicitAbsolutePathArgument(command.argument);
        if (!explicit.path) {
          await logInvalidTargetForCommand({
            provider,
            sessionId: providerSessionId,
            eventId: event.eventId,
            command: command.name,
            rawArgument: command.argument,
            reason: explicit.reason ?? "Path argument is invalid",
            operationalLogger,
            auditLogger,
          });
          continue;
        }
        loggedTargetPath = explicit.path;
        const exportEvents = await resolveBoundaryEventsFromTwinStart(
          metadata,
          boundarySnapshot,
          event,
          command.line,
          sessionStateStore,
        );
        const snapshotTitle = resolveConversationTitle(
          exportEvents,
          providerSessionId,
        );
        await recordingPipeline.exportSnapshot({
          provider,
          sessionId: providerSessionId,
          targetPath: explicit.path,
          events: exportEvents,
          title: snapshotTitle,
        });
      } else if (command.name === "stop") {
        const nowIso = now().toISOString();
        const deactivated = deactivateActiveRecordings(
          metadata,
          writeCursor,
          nowIso,
        );
        if (deactivated.length === 0) {
          commandNoop = true;
        } else {
          metadataChanged = true;
          await auditLogger.record(
            "recording.command.stop.applied",
            "Stopped active recording targets",
            {
              provider,
              sessionId: providerSessionId,
              eventId: event.eventId,
              targets: deactivated,
            },
          );
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
    events,
    eventIndex,
    event,
    sessionEventState,
    recordingPipeline,
    operationalLogger,
    auditLogger,
    now,
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

  const boundaries = resolveCommandBoundaries(event.content, detection.commands);

  for (const boundary of boundaries) {
    const { command } = boundary;
    const boundarySnapshot = buildBoundarySnapshotEvents(
      events,
      eventIndex,
      event,
      command.line,
    );
    const recordingTitle = resolveConversationTitle(boundarySnapshot, sessionId);
    let loggedTargetPath: string | undefined;
    let commandNoop = false;

    try {
      if (command.name === "init") {
        const explicit = command.argument
          ? resolveExplicitAbsolutePathArgument(command.argument)
          : undefined;
        if (command.argument && !explicit?.path) {
          await logInvalidTargetForCommand({
            provider,
            sessionId,
            eventId: event.eventId,
            command: command.name,
            rawArgument: command.argument,
            reason: explicit?.reason ?? "Path argument is invalid",
            operationalLogger,
            auditLogger,
          });
          continue;
        }
        const destination = explicit?.path ??
          sessionEventState.primaryRecordingDestination ??
          makeDefaultRecordingDestinationPath(provider, sessionId, now());
        const resolvedDestination = await validateDestinationPathForCommand(
          recordingPipeline,
          provider,
          sessionId,
          destination,
          "record",
        );
        sessionEventState.primaryRecordingDestination = resolvedDestination;
        loggedTargetPath = resolvedDestination;
        recordingPipeline.stopRecording(provider, sessionId);
      } else if (command.name === "record") {
        const destination = sessionEventState.primaryRecordingDestination ??
          makeDefaultRecordingDestinationPath(provider, sessionId, now());
        const resolvedDestination = await validateDestinationPathForCommand(
          recordingPipeline,
          provider,
          sessionId,
          destination,
          "record",
        );
        loggedTargetPath = resolvedDestination;
        const active = recordingPipeline.getActiveRecording(provider, sessionId);
        if (active && active.outputPath === resolvedDestination) {
          commandNoop = true;
        } else {
          const seedEvents = buildCommandSeedEvents(
            event,
            command.line,
            boundary.lastLineInSegment,
          );
          await recordingPipeline.activateRecording({
            provider,
            sessionId,
            targetPath: resolvedDestination,
            seedEvents,
            title: recordingTitle,
          });
        }
        sessionEventState.primaryRecordingDestination = resolvedDestination;
      } else if (command.name === "capture") {
        const explicit = command.argument
          ? resolveExplicitAbsolutePathArgument(command.argument)
          : undefined;
        if (command.argument && !explicit?.path) {
          await logInvalidTargetForCommand({
            provider,
            sessionId,
            eventId: event.eventId,
            command: command.name,
            rawArgument: command.argument,
            reason: explicit?.reason ?? "Path argument is invalid",
            operationalLogger,
            auditLogger,
          });
          continue;
        }
        const destination = explicit?.path ??
          sessionEventState.primaryRecordingDestination ??
          makeDefaultRecordingDestinationPath(provider, sessionId, now());
        const resolvedDestination = await validateDestinationPathForCommand(
          recordingPipeline,
          provider,
          sessionId,
          destination,
          "capture",
        );
        loggedTargetPath = resolvedDestination;
        const recordingId = crypto.randomUUID();
        await recordingPipeline.captureSnapshot({
          provider,
          sessionId,
          targetPath: resolvedDestination,
          events: boundarySnapshot,
          title: recordingTitle,
          recordingIds: [recordingId],
        });
        await recordingPipeline.activateRecording({
          provider,
          sessionId,
          targetPath: resolvedDestination,
          title: recordingTitle,
          recordingId,
        });
        sessionEventState.primaryRecordingDestination = resolvedDestination;
      } else if (command.name === "export") {
        const explicit = resolveExplicitAbsolutePathArgument(command.argument);
        if (!explicit.path) {
          await logInvalidTargetForCommand({
            provider,
            sessionId,
            eventId: event.eventId,
            command: command.name,
            rawArgument: command.argument,
            reason: explicit.reason ?? "Path argument is invalid",
            operationalLogger,
            auditLogger,
          });
          continue;
        }
        loggedTargetPath = explicit.path;
        await recordingPipeline.exportSnapshot({
          provider,
          sessionId,
          targetPath: explicit.path,
          events: boundarySnapshot,
          title: recordingTitle,
        });
      } else {
        const stopped = recordingPipeline.stopRecording(provider, sessionId);
        commandNoop = !stopped;
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

    const recordingTitle = resolveConversationTitle(snapshot.events, sessionId);
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
          events: snapshot.events,
          eventIndex: i,
          event: event as ConversationEvent & { kind: "message.user" },
          sessionEventState: state,
          recordingPipeline,
          operationalLogger,
          auditLogger,
          now,
        });
      }

      try {
        await recordingPipeline.appendToActiveRecording({
          provider,
          sessionId,
          events: [event],
          title: recordingTitle,
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

    state.lastSeenFileModifiedAtMs = currentFileModifiedAtMs;
  }

  for (const sessionKey of Array.from(sessionEventStates.keys())) {
    if (!activeSessionKeys.has(sessionKey)) {
      sessionEventStates.delete(sessionKey);
    }
  }
}

function readRecordingStartedAt(
  recording: SessionMetadataV1["recordings"][number],
): string {
  for (let i = recording.periods.length - 1; i >= 0; i -= 1) {
    const period = recording.periods[i];
    if (period?.startedAt) {
      return period.startedAt;
    }
  }
  return recording.createdAt ?? "";
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
    now,
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
    const commandCursor = readCommandCursor(metadata);
    for (let i = commandCursor; i < snapshot.events.length; i += 1) {
      const event = snapshot.events[i];
      if (!event || event.kind !== "message.user") {
        continue;
      }
      const changed = await applyPersistentControlCommandsForEvent({
        provider,
        providerSessionId,
        events: snapshot.events,
        eventIndex: i,
        event: event as ConversationEvent & { kind: "message.user" },
        metadata,
        sessionStateStore,
        recordingPipeline,
        operationalLogger,
        auditLogger,
        now,
      });
      metadataChanged = metadataChanged || changed;
    }
    if (commandCursor !== snapshot.events.length) {
      writeCommandCursor(metadata, snapshot.events.length);
      metadataChanged = true;
    }

    const activeRecordings = activeSessionRecordings(metadata);
    const recordingTitle = resolveConversationTitle(
      snapshot.events,
      providerSessionId,
    );
    for (const recording of activeRecordings) {
      const clampedCursor = Math.max(
        0,
        Math.min(recording.writeCursor, snapshot.events.length),
      );
      if (clampedCursor !== recording.writeCursor) {
        recording.writeCursor = clampedCursor;
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
        await recordingPipeline.appendToDestination({
          provider,
          sessionId: providerSessionId,
          targetPath: recording.destination,
          events: pendingEvents,
          title: recordingTitle,
          recordingId: recording.recordingId,
          recordingIds: metadata.recordings
            .filter((entry) => entry.destination === recording.destination)
            .map((entry) => entry.recordingId),
        });
        recording.writeCursor = snapshot.events.length;
        metadataChanged = true;
      } catch (error) {
        await operationalLogger.error(
          "recording.append.failed",
          "Failed to append events to persistent recording destination",
          {
            provider,
            sessionId: providerSessionId,
            recordingId: recording.recordingId,
            destination: recording.destination,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        await auditLogger.record(
          "recording.append.failed",
          "Failed to append events to persistent recording destination",
          {
            provider,
            sessionId: providerSessionId,
            recordingId: recording.recordingId,
            destination: recording.destination,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    if (metadataChanged) {
      await sessionStateStore.saveSessionMetadata(metadata);
      anyMetadataChanged = true;
    }
  }
  return anyMetadataChanged;
}

function toActiveRecordingsFromMetadata(
  entries: SessionMetadataV1[],
): ActiveRecording[] {
  const recordings: ActiveRecording[] = [];
  for (const metadata of entries) {
    for (const recording of metadata.recordings) {
      if (recording.desiredState !== "on") continue;
      recordings.push({
        recordingId: recording.recordingId,
        provider: metadata.provider,
        sessionId: metadata.providerSessionId,
        outputPath: recording.destination,
        startedAt: readRecordingStartedAt(recording) || metadata.updatedAt,
        lastWriteAt: metadata.updatedAt,
      });
    }
  }
  return recordings;
}

function summarizeRecordingStatus(
  activeRecordings: ActiveRecording[],
  sessions: DaemonSessionStatus[] | undefined,
): { activeRecordings: number; destinations: number } {
  if (!sessions || activeRecordings.length === 0) {
    return { activeRecordings: 0, destinations: 0 };
  }
  const activeSessionKeys = new Set(
    sessions
      .filter((session) => !session.stale)
      .map((session) =>
        makeSessionProcessingKey(
          session.provider,
          session.providerSessionId ?? session.sessionId,
        )
      ),
  );
  const active = activeRecordings.filter((recording) =>
    activeSessionKeys.has(
      makeSessionProcessingKey(recording.provider, recording.sessionId),
    )
  );
  return {
    activeRecordings: active.length,
    destinations: new Set(
      active.map((recording) => recording.outputPath),
    ).size,
  };
}

function toProviderStatuses(
  sessionSnapshots: SessionSnapshotMetadataEntry[],
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
  sessionSnapshots: SessionSnapshotMetadataEntry[],
  activeRecordings: ActiveRecording[],
  now: Date,
  staleAfterMs: number,
  sessionMetadataByKey?: Map<string, SessionMetadataV1>,
): DaemonSessionStatus[] {
  const recordingByKey = new Map<string, ActiveRecording>();
  for (const rec of activeRecordings) {
    recordingByKey.set(
      makeSessionProcessingKey(rec.provider, rec.sessionId),
      rec,
    );
  }

  const statuses = sessionSnapshots.map((snap) => {
    const metadata = sessionMetadataByKey?.get(
      `${snap.provider}:${snap.sessionId}`,
    );
    const rec = recordingByKey.get(
      makeSessionProcessingKey(snap.provider, snap.sessionId),
    );
    return projectSessionStatus({
      session: {
        provider: snap.provider,
        sessionId: metadata?.sessionId ?? snap.sessionId,
        ...(metadata ? { sessionShortId: metadata.sessionId.slice(0, 8) } : {}),
        ...(metadata ? { providerSessionId: metadata.providerSessionId } : {}),
        updatedAt: snap.metadata.updatedAt,
        lastEventAt: snap.metadata.lastEventAt,
        fileModifiedAtMs: snap.metadata.fileModifiedAtMs,
        snippet: snap.metadata.snippet,
      },
      recording: rec
        ? {
          provider: rec.provider,
          sessionId: rec.sessionId,
          ...(rec.recordingId ? { recordingId: rec.recordingId } : {}),
          ...(rec.recordingId
            ? { recordingShortId: rec.recordingId.slice(0, 8) }
            : {}),
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
  const sessionMetadataRefreshIntervalMs = Math.max(
    options.sessionMetadataRefreshIntervalMs ?? heartbeatIntervalMs,
    pollIntervalMs,
  );
  const exportEnabled = options.exportEnabled ?? true;
  const exportsLogPath = options.exportsLogPath;
  const cleanSessionStatesOnShutdown = options.cleanSessionStatesOnShutdown ??
    false;
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
  const processEventsFromMs = now().getTime();

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
              now,
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
  exportsLogPath?: string;
  now: () => Date;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type ExportSessionResolutionMatch =
  | "passthrough"
  | "provider_session_id"
  | "session_id"
  | "session_id_prefix";

interface ExportSessionResolution {
  lookupSessionId: string;
  matchedBy: ExportSessionResolutionMatch;
  ambiguousMatches?: SessionMetadataV1[];
}

function parseExportSessionSelector(
  requestedSessionId: string,
): { provider?: string; selector: string } {
  const trimmed = requestedSessionId.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return { selector: trimmed };
  }

  const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
  const selector = trimmed.slice(slashIndex + 1).trim();
  if (
    selector.length === 0 || !KNOWN_EXPORT_PROVIDER_PREFIXES.has(provider)
  ) {
    return { selector: trimmed };
  }

  return { provider, selector };
}

function passthroughExportSessionResolution(
  requestedSessionId: string,
): ExportSessionResolution {
  const trimmed = requestedSessionId.trim();
  return {
    lookupSessionId: trimmed.length > 0 ? trimmed : requestedSessionId,
    matchedBy: "passthrough",
  };
}

async function resolveExportSessionLookup(
  requestedSessionId: string,
  sessionStateStore?: PersistentSessionStateStore,
): Promise<ExportSessionResolution> {
  const passthrough = passthroughExportSessionResolution(requestedSessionId);
  if (!sessionStateStore) {
    return passthrough;
  }

  const metadataList = await sessionStateStore.listSessionMetadata();
  if (metadataList.length === 0) {
    return passthrough;
  }

  const parsed = parseExportSessionSelector(passthrough.lookupSessionId);
  const scopedEntries = parsed.provider
    ? metadataList.filter((entry) =>
      entry.provider.toLowerCase() === parsed.provider
    )
    : metadataList;
  if (scopedEntries.length === 0 || parsed.selector.length === 0) {
    return passthrough;
  }

  const matchers: Array<{
    kind: ExportSessionResolutionMatch;
    matches: SessionMetadataV1[];
  }> = [{
    kind: "provider_session_id",
    matches: scopedEntries.filter((entry) =>
      entry.providerSessionId === parsed.selector
    ),
  }, {
    kind: "session_id",
    matches: scopedEntries.filter((entry) =>
      entry.sessionId === parsed.selector
    ),
  }, {
    kind: "session_id_prefix",
    matches: scopedEntries.filter((entry) =>
      entry.sessionId.startsWith(parsed.selector)
    ),
  }];

  for (const matcher of matchers) {
    if (matcher.matches.length === 1) {
      return {
        lookupSessionId: matcher.matches[0]!.providerSessionId,
        matchedBy: matcher.kind,
      };
    }
    if (matcher.matches.length > 1) {
      return {
        ...passthrough,
        matchedBy: matcher.kind,
        ambiguousMatches: matcher.matches,
      };
    }
  }

  return passthrough;
}

function formatExportSessionAmbiguousLabel(
  metadata: SessionMetadataV1,
): string {
  return `${metadata.provider}/${
    metadata.sessionId.slice(0, 8)
  } (${metadata.providerSessionId})`;
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

async function appendExportHistoryEntrySafely(
  exportsLogPath: string | undefined,
  entry: Parameters<typeof appendExportsLogEntry>[1],
  operationalLogger: StructuredLogger,
): Promise<void> {
  if (!exportsLogPath) {
    return;
  }
  try {
    await appendExportsLogEntry(exportsLogPath, entry);
  } catch (error) {
    await operationalLogger.warn(
      "daemon.control.export.history_write_failed",
      "Failed to append export history event",
      {
        requestId: entry.requestId,
        status: entry.status,
        exportsLogPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
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
    const baseHistoryEntry = {
      recordedAt: now().toISOString(),
      requestId: request.requestId,
      requestedAt: request.requestedAt,
      ...(sessionId ? { sessionId } : {}),
      ...(outputPath ? { outputPath } : {}),
      ...(format ? { format } : {}),
    } as const;
    const recordExportFailed = async (
      reason: string,
      extra?: {
        error?: string;
        matchedBy?: string;
      },
    ): Promise<void> => {
      await appendExportHistoryEntrySafely(
        exportsLogPath,
        {
          ...baseHistoryEntry,
          status: "failed",
          reason,
          ...(extra?.error ? { error: extra.error } : {}),
          ...(extra?.matchedBy ? { matchedBy: extra.matchedBy } : {}),
        },
        operationalLogger,
      );
    };
    const recordExportSucceeded = async (
      provider: string,
      matchedBy?: string,
    ): Promise<void> => {
      await appendExportHistoryEntrySafely(
        exportsLogPath,
        {
          ...baseHistoryEntry,
          status: "succeeded",
          provider,
          ...(matchedBy ? { matchedBy } : {}),
        },
        operationalLogger,
      );
    };

    if (!exportEnabled) {
      await operationalLogger.warn(
        "daemon.control.export.disabled",
        "Export request skipped because feature flag is disabled",
        { requestId: request.requestId },
      );
      await recordExportFailed("export_disabled");
      await controlStore.markProcessed(request.requestId);
      return false;
    }

    if (!sessionId || !outputPath) {
      await operationalLogger.warn(
        "daemon.control.export.invalid",
        "Export request payload is missing required fields",
        { requestId: request.requestId, payload },
      );
      await recordExportFailed("invalid_payload");
    } else if (!loadSessionSnapshot) {
      await warnExportSkipped(
        "daemon.control.export.unhandled",
        "Export request skipped because session snapshot loader is unavailable",
        { requestId: request.requestId, sessionId, outputPath },
        operationalLogger,
        auditLogger,
      );
      await recordExportFailed("snapshot_loader_unavailable");
    } else {
      try {
        const sessionResolution = await resolveExportSessionLookup(
          sessionId,
          sessionStateStore,
        );
        if (sessionResolution.ambiguousMatches) {
          await warnExportSkipped(
            "daemon.control.export.session_ambiguous",
            "Export request skipped because session selector matched multiple sessions",
            {
              requestId: request.requestId,
              sessionId,
              outputPath,
              matchedBy: sessionResolution.matchedBy,
              candidates: sessionResolution.ambiguousMatches.map((entry) =>
                formatExportSessionAmbiguousLabel(entry)
              ),
            },
            operationalLogger,
            auditLogger,
          );
          await recordExportFailed("session_selector_ambiguous", {
            matchedBy: sessionResolution.matchedBy,
          });
          await controlStore.markProcessed(request.requestId);
          return false;
        }

        const lookupSessionId = sessionResolution.lookupSessionId;
        const snapshotData = await loadSessionSnapshot(lookupSessionId);
        if (!snapshotData) {
          await warnExportSkipped(
            "daemon.control.export.session_missing",
            "Export request skipped because session snapshot was not found",
            {
              requestId: request.requestId,
              sessionId,
              outputPath,
              ...(lookupSessionId !== sessionId ? { lookupSessionId } : {}),
              ...(sessionResolution.matchedBy !== "passthrough"
                ? { matchedBy: sessionResolution.matchedBy }
                : {}),
            },
            operationalLogger,
            auditLogger,
          );
          await recordExportFailed("session_snapshot_not_found", {
            ...(sessionResolution.matchedBy !== "passthrough"
              ? { matchedBy: sessionResolution.matchedBy }
              : {}),
          });
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
          await recordExportFailed("invalid_snapshot_provider");
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
          await recordExportFailed("session_snapshot_empty");
          await controlStore.markProcessed(request.requestId);
          return false;
        }

        await recordingPipeline.exportSnapshot({
          provider: snapshotProvider,
          sessionId,
          targetPath: outputPath,
          events: snapshotData.events,
          title: resolveConversationTitle(snapshotData.events, sessionId),
          ...(format ? { format } : {}),
        });
        await recordExportSucceeded(
          snapshotProvider,
          sessionResolution.matchedBy !== "passthrough"
            ? sessionResolution.matchedBy
            : undefined,
        );
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        await operationalLogger.error(
          "daemon.control.export.failed",
          "Export request failed in daemon runtime",
          {
            requestId: request.requestId,
            sessionId,
            outputPath,
            error: errorMessage,
          },
        );
        await recordExportFailed("export_snapshot_failed", {
          error: errorMessage,
        });
      }
    }
  }

  await controlStore.markProcessed(request.requestId);

  if (request.command === "stop") {
    return true;
  }

  return false;
}
