import type {
  ConversationEvent,
  DaemonFeatureFlags,
  DaemonSessionStatus,
  MarkdownFrontmatterConfig,
  ProviderStatus,
  SessionMetadataV1,
} from "@kato/shared";
import {
  extractSnippet,
  projectSessionStatus,
  sortSessionsByRecency,
} from "@kato/shared";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import {
  detectInChatControlCommands,
  type InChatControlCommand,
  resolveDefaultAllowedWriteRoots,
  WritePathPolicyGate,
} from "../policy/mod.ts";
import {
  type ActiveRecording,
  type RecordingOutputOverrides,
  RecordingPipeline,
  type RecordingPipelineLike,
} from "../writer/mod.ts";
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
import { readOptionalEnv, resolveHomeDir } from "../utils/env.ts";

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
  daemonFeatureFlags?: DaemonFeatureFlags;
  defaultCliExportOutputOverrides?: RecordingOutputOverrides;
  workspaceRegistryStore?: WorkspaceRegistryFileStore;
  workspaceCatalog?: WorkspaceCatalogLike;
  workspaceProfileResolver?: WorkspaceProfileResolverLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROVIDER_STATUS_STALE_AFTER_MS = 5 * 60_000;
const MARKDOWN_LINK_PATH_PATTERN = /^\[[^\]]+\]\((.+)\)$/;
const KNOWN_EXPORT_PROVIDER_PREFIXES = new Set(["claude", "codex", "gemini"]);
const CAPTURE_DESTINATION_CONFLICT_MAX_RETRIES = 5;
const CAPTURE_DESTINATION_CONFLICT_BACKOFF_MS = 25;

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
}

interface ProcessPersistentRecordingUpdatesOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore: PersistentSessionStateStore;
  recordingPipeline: RecordingPipelineLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  now: () => Date;
  captureIncludeSystemEvents: boolean;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
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
}

interface InChatCommandBoundary {
  command: InChatControlCommand;
  nextCommandLine: number;
  lastLineInSegment: number;
}

function sanitizeFilenamePart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(
    /-+/g,
    "-",
  ).replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "recording";
}

function slugifySnippetForFilename(value: string): string {
  const normalized = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "conversation";
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(/\r\n?|\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function resolveFilenameSnippet(options: {
  snapshotSnippet?: string;
  boundarySnapshot?: ConversationEvent[];
}): string {
  const fromSnapshot = firstNonEmptyLine(options.snapshotSnippet);
  if (fromSnapshot) {
    return fromSnapshot;
  }
  const fromBoundary = firstNonEmptyLine(
    extractSnippet(options.boundarySnapshot ?? []),
  );
  if (fromBoundary) {
    return fromBoundary;
  }
  return "conversation";
}

function readDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function readTimestampTemplateParts(
  now: Date,
  timeZone: string,
): {
  YYYY: string;
  YY: string;
  MM: string;
  DD: string;
  HH: string;
  mm: string;
  timestampHumane: string;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone === "local" ? {} : { timeZone }),
  });
  const parts = formatter.formatToParts(now);
  const year = readDatePart(parts, "year");
  const month = readDatePart(parts, "month");
  const day = readDatePart(parts, "day");
  const hour = readDatePart(parts, "hour");
  const minute = readDatePart(parts, "minute");
  return {
    YYYY: year,
    YY: year.slice(-2),
    MM: month,
    DD: day,
    HH: hour,
    mm: minute,
    timestampHumane: `${year}-${month}-${day}_${hour}${minute}`,
  };
}

function readWorkspaceOutputs(
  metadata: SessionMetadataV1,
): NonNullable<SessionMetadataV1["workspaceOutputs"]> {
  if (!metadata.workspaceOutputs) {
    metadata.workspaceOutputs = [];
  }
  return metadata.workspaceOutputs;
}

function findWorkspaceOutput(
  metadata: SessionMetadataV1,
  workspaceId: string,
): NonNullable<SessionMetadataV1["workspaceOutputs"]>[number] | undefined {
  return readWorkspaceOutputs(metadata).find((entry) =>
    entry.workspaceId === workspaceId
  );
}

function activeWorkspaceOutputs(
  metadata: SessionMetadataV1,
): NonNullable<SessionMetadataV1["workspaceOutputs"]> {
  return readWorkspaceOutputs(metadata).filter((entry) =>
    entry.desiredState === "on"
  );
}

function closeWorkspaceOutputCycle(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
  stopCursor: number,
  nowIso: string,
): boolean {
  const cycleId = output.activeRecordingCycleId;
  if (!cycleId) {
    const changed = output.desiredState !== "off";
    delete output.activeRecordingCycleId;
    output.desiredState = "off";
    return changed;
  }
  for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
    const cycle = output.recordingCycles[i];
    if (
      !cycle || cycle.recordingCycleId !== cycleId ||
      cycle.stoppedCursor !== undefined
    ) {
      continue;
    }
    cycle.stoppedCursor = stopCursor;
    cycle.stoppedAt = nowIso;
    cycle.stoppedBySeq = stopCursor;
    break;
  }
  delete output.activeRecordingCycleId;
  output.desiredState = "off";
  return true;
}

function stopAllWorkspaceOutputs(
  metadata: SessionMetadataV1,
  stopCursor: number,
  nowIso: string,
): string[] {
  const changed: string[] = [];
  for (const output of readWorkspaceOutputs(metadata)) {
    if (closeWorkspaceOutputCycle(output, stopCursor, nowIso)) {
      changed.push(output.workspaceId);
    }
  }
  return changed;
}

function openWorkspaceOutputCycle(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
  startCursor: number,
  nowIso: string,
  recordingCycleId: string = crypto.randomUUID(),
): string {
  output.recordingCycles.push({
    recordingCycleId,
    startedCursor: startCursor,
    startedAt: nowIso,
    startedBySeq: startCursor,
  });
  output.activeRecordingCycleId = recordingCycleId;
  output.desiredState = "on";
  return recordingCycleId;
}

function applyWorkspaceProfileSnapshot(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
  profile: ResolvedWorkspaceProfile,
): void {
  output.workspaceAliasSnapshot = profile.alias;
  output.sourceConfigPath = profile.configPath;
  output.workspaceRootSnapshot = profile.workspaceRoot;
  output.resolvedDefaultOutputDir = profile.resolvedDefaultOutputDir;
  output.filenameTemplate = profile.filenameTemplate;
  output.writerFeatureFlags = { ...profile.writerFeatureFlags };
}

function createWorkspaceOutputState(options: {
  profile: ResolvedWorkspaceProfile;
  binding: NonNullable<
    SessionMetadataV1["workspaceOutputs"]
  >[number]["currentDestination"];
  resolvedPath: string;
  desiredState: "on" | "off";
  writeCursor: number;
  nowIso: string;
}): NonNullable<SessionMetadataV1["workspaceOutputs"]>[number] {
  return {
    workspaceId: options.profile.workspaceId,
    workspaceAliasSnapshot: options.profile.alias,
    desiredState: options.desiredState,
    currentDestination: options.binding,
    currentResolvedPath: options.resolvedPath,
    sourceConfigPath: options.profile.configPath,
    workspaceRootSnapshot: options.profile.workspaceRoot,
    resolvedDefaultOutputDir: options.profile.resolvedDefaultOutputDir,
    filenameTemplate: options.profile.filenameTemplate,
    writerFeatureFlags: { ...options.profile.writerFeatureFlags },
    writeCursor: options.writeCursor,
    createdAt: options.nowIso,
    recordingCycles: [],
  };
}

function renderWorkspaceFilename(
  profile: ResolvedWorkspaceProfile,
  provider: string,
  sessionId: string,
  now: Date,
  options: {
    snapshotSnippet?: string;
    boundarySnapshot?: ConversationEvent[];
  } = {},
): string {
  const timestampTokens = readTimestampTemplateParts(
    now,
    profile.workspaceTimezone,
  );
  const tokens: Record<string, string> = {
    provider: sanitizeFilenamePart(provider),
    sessionId: sanitizeFilenamePart(sessionId),
    sessionShortId: sanitizeFilenamePart(sessionId.slice(0, 8)),
    YYYY: timestampTokens.YYYY,
    YY: timestampTokens.YY,
    MM: timestampTokens.MM,
    DD: timestampTokens.DD,
    HH: timestampTokens.HH,
    mm: timestampTokens.mm,
    timestampHumane: timestampTokens.timestampHumane,
    snippetSlug: slugifySnippetForFilename(resolveFilenameSnippet(options)),
  };
  let rendered = profile.filenameTemplate;
  for (const [token, replacement] of Object.entries(tokens)) {
    rendered = rendered.replaceAll(`{${token}}`, replacement);
  }
  const normalized = rendered
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0
    ? normalized
    : `${tokens.timestampHumane}-${tokens.snippetSlug}-${tokens.provider}.md`;
}

async function isDirectoryTargetPath(path: string): Promise<boolean> {
  if (path.endsWith("/") || path.endsWith("\\")) {
    return true;
  }
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function resolveUniqueNonExistingPath(path: string): Promise<string> {
  if (!(await pathExists(path))) {
    return path;
  }
  const suffix = extname(path);
  const prefix = suffix.length > 0 ? path.slice(0, -suffix.length) : path;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${prefix}-${index}${suffix}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve unique destination path for: ${path}`);
}

function toWorkspaceDestinationBinding(
  profile: ResolvedWorkspaceProfile,
  resolvedPath: string,
): NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number]["currentDestination"] {
  const rel = relative(resolve(profile.workspaceRoot), resolve(resolvedPath));
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    return {
      kind: "workspace-relative",
      relativePathFromWorkspaceRoot: rel,
    };
  }
  if (rel === "") {
    return {
      kind: "workspace-relative",
      relativePathFromWorkspaceRoot: ".",
    };
  }
  return {
    kind: "absolute-explicit",
    absolutePath: resolve(resolvedPath),
  };
}

async function resolveWorkspaceCommandDestination(options: {
  profile: ResolvedWorkspaceProfile;
  provider: string;
  sessionId: string;
  snapshotSnippet?: string;
  boundarySnapshot?: ConversationEvent[];
  rawArgument?: string;
  ensureGeneratedPathUnique?: boolean;
  now: Date;
}): Promise<{
  resolvedPath: string;
  usesGeneratedFilename: boolean;
  binding: NonNullable<
    SessionMetadataV1["workspaceOutputs"]
  >[number]["currentDestination"];
}> {
  const normalized = normalizeRawCommandTargetPath(options.rawArgument);
  if (!normalized) {
    const generatedPath = join(
      options.profile.resolvedDefaultOutputDir,
      renderWorkspaceFilename(
        options.profile,
        options.provider,
        options.sessionId,
        options.now,
        {
          snapshotSnippet: options.snapshotSnippet,
          boundarySnapshot: options.boundarySnapshot,
        },
      ),
    );
    const generated = options.ensureGeneratedPathUnique
      ? await resolveUniqueNonExistingPath(generatedPath)
      : generatedPath;
    return {
      resolvedPath: generated,
      usesGeneratedFilename: true,
      binding: toWorkspaceDestinationBinding(options.profile, generated),
    };
  }
  if (normalized.startsWith("@")) {
    throw new Error(
      "Path argument must be a filesystem path (mentions are not allowed)",
    );
  }
  const resolvedBase = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(options.profile.workspaceRoot, normalized);
  const generatedFromDirectory = await isDirectoryTargetPath(resolvedBase);
  const resolvedPathBase = generatedFromDirectory
    ? join(
      resolvedBase,
      renderWorkspaceFilename(
        options.profile,
        options.provider,
        options.sessionId,
        options.now,
        {
          snapshotSnippet: options.snapshotSnippet,
          boundarySnapshot: options.boundarySnapshot,
        },
      ),
    )
    : resolvedBase;
  const resolvedPath =
    options.ensureGeneratedPathUnique && generatedFromDirectory
      ? await resolveUniqueNonExistingPath(resolvedPathBase)
      : resolvedPathBase;
  return {
    resolvedPath,
    usesGeneratedFilename: generatedFromDirectory,
    binding: isAbsolute(normalized)
      ? {
        kind: "absolute-explicit",
        absolutePath: resolvedPath,
      }
      : toWorkspaceDestinationBinding(options.profile, resolvedPath),
  };
}

function readCommandCursor(metadata: SessionMetadataV1): number {
  const raw = metadata.commandCursor;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return 0;
  }
  return raw;
}

function normalizeCommandCursorAnchor(
  value: SessionMetadataV1["commandCursorAnchor"] | undefined,
): SessionMetadataV1["commandCursorAnchor"] | undefined {
  if (!value) {
    return undefined;
  }
  const eventId = readString(value.eventId);
  const providerEventType = readString(value.providerEventType);
  const providerEventId = readString(value.providerEventId);
  const timestamp = readString(value.timestamp);
  if (!eventId && !(providerEventType && providerEventId) && !timestamp) {
    return undefined;
  }
  return {
    ...(eventId ? { eventId } : {}),
    ...(providerEventType ? { providerEventType } : {}),
    ...(providerEventId ? { providerEventId } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function readCommandCursorAnchor(
  metadata: SessionMetadataV1,
): SessionMetadataV1["commandCursorAnchor"] | undefined {
  return normalizeCommandCursorAnchor(metadata.commandCursorAnchor);
}

function buildCommandCursorAnchor(
  event: ConversationEvent | undefined,
): SessionMetadataV1["commandCursorAnchor"] | undefined {
  if (!event) {
    return undefined;
  }
  return normalizeCommandCursorAnchor({
    eventId: event.eventId,
    providerEventType: event.source.providerEventType,
    providerEventId: event.source.providerEventId,
    timestamp: event.timestamp,
  });
}

function commandCursorAnchorMatchesEvent(
  anchor: NonNullable<SessionMetadataV1["commandCursorAnchor"]>,
  event: ConversationEvent,
): boolean {
  if (anchor.eventId && event.eventId === anchor.eventId) {
    return true;
  }
  if (
    anchor.providerEventType &&
    anchor.providerEventId &&
    event.source.providerEventType === anchor.providerEventType &&
    event.source.providerEventId === anchor.providerEventId
  ) {
    return true;
  }
  return false;
}

function findCommandCursorAnchorIndex(
  events: ConversationEvent[],
  anchor: NonNullable<SessionMetadataV1["commandCursorAnchor"]>,
): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    if (commandCursorAnchorMatchesEvent(anchor, event)) {
      return i;
    }
  }
  return -1;
}

function findFirstEventAfterTimestamp(
  events: ConversationEvent[],
  timestamp: string,
): number {
  const anchorTimeMs = readTimeMs(timestamp);
  if (anchorTimeMs === undefined) {
    return events.length;
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const eventTimeMs = readTimeMs(event.timestamp);
    if (eventTimeMs !== undefined && eventTimeMs > anchorTimeMs) {
      return i;
    }
  }
  return events.length;
}

function resolveCommandStartCursor(
  metadata: SessionMetadataV1,
  events: ConversationEvent[],
): number {
  const anchor = readCommandCursorAnchor(metadata);
  if (anchor) {
    const anchorIndex = findCommandCursorAnchorIndex(events, anchor);
    if (anchorIndex >= 0) {
      return anchorIndex + 1;
    }
    if (anchor.timestamp) {
      return findFirstEventAfterTimestamp(events, anchor.timestamp);
    }
  }
  const persisted = readCommandCursor(metadata);
  if (persisted <= events.length) {
    return persisted;
  }
  return events.length;
}

function commandCursorAnchorEquals(
  left: SessionMetadataV1["commandCursorAnchor"] | undefined,
  right: SessionMetadataV1["commandCursorAnchor"] | undefined,
): boolean {
  const leftNormalized = normalizeCommandCursorAnchor(left);
  const rightNormalized = normalizeCommandCursorAnchor(right);
  if (!leftNormalized && !rightNormalized) {
    return true;
  }
  if (!leftNormalized || !rightNormalized) {
    return false;
  }
  return leftNormalized.eventId === rightNormalized.eventId &&
    leftNormalized.providerEventType === rightNormalized.providerEventType &&
    leftNormalized.providerEventId === rightNormalized.providerEventId &&
    leftNormalized.timestamp === rightNormalized.timestamp;
}

function writeCommandCursor(
  metadata: SessionMetadataV1,
  cursor: number,
  events: ConversationEvent[],
): void {
  const normalizedCursor = Math.max(0, Math.floor(cursor));
  metadata.commandCursor = normalizedCursor;
  const anchor = normalizedCursor > 0
    ? buildCommandCursorAnchor(events[normalizedCursor - 1])
    : undefined;
  if (anchor) {
    metadata.commandCursorAnchor = anchor;
  } else {
    delete metadata.commandCursorAnchor;
  }
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
  const boundaryContent = sliceContentByLineRange(
    event.content,
    1,
    boundaryLine,
  );
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

function resolveBindingForRetargetedWorkspacePath(options: {
  profile: ResolvedWorkspaceProfile;
  currentBinding: NonNullable<
    SessionMetadataV1["workspaceOutputs"]
  >[number]["currentDestination"];
  resolvedPath: string;
}): NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number]["currentDestination"] {
  if (options.currentBinding.kind === "absolute-explicit") {
    return {
      kind: "absolute-explicit",
      absolutePath: resolve(options.resolvedPath),
    };
  }
  return toWorkspaceDestinationBinding(options.profile, options.resolvedPath);
}

function normalizeFrontmatterParticipantUsername(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

function resolveConfiguredParticipantUsername(
  markdownFrontmatter: MarkdownFrontmatterConfig,
): string | undefined {
  if (!markdownFrontmatter.addParticipantUsernameToFrontmatter) {
    return undefined;
  }
  const configured = normalizeFrontmatterParticipantUsername(
    markdownFrontmatter.defaultParticipantUsername,
  );
  if (configured) {
    return configured;
  }
  const envUser = normalizeFrontmatterParticipantUsername(
    readOptionalEnv("USER") ?? readOptionalEnv("USERNAME"),
  );
  if (envUser) {
    return envUser;
  }
  const home = resolveHomeDir();
  return normalizeFrontmatterParticipantUsername(
    home ? basename(home) : undefined,
  );
}

function createOutputOverridesFromWorkspaceProfile(
  profile: ResolvedWorkspaceProfile,
  captureIncludeSystemEvents: boolean,
): RecordingOutputOverrides {
  return createOutputOverrides({
    markdownFrontmatter: profile.markdownFrontmatter,
    writerFeatureFlags: profile.writerFeatureFlags,
    workspaceTimezone: profile.workspaceTimezone,
    captureIncludeSystemEvents,
  });
}

function createOutputOverrides(options: {
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
  };
  workspaceTimezone: string;
  captureIncludeSystemEvents: boolean;
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
    participantUsername: resolveConfiguredParticipantUsername(
      options.markdownFrontmatter,
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
      includeSystemEvents: options.captureIncludeSystemEvents,
      headingTimestampTimezone: options.workspaceTimezone,
    },
  };
}

async function resolvePersistedWorkspaceOutputOverrides(options: {
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number];
  captureIncludeSystemEvents: boolean;
  workspaceCatalog: WorkspaceCatalogLike;
  workspaceProfileResolver: WorkspaceProfileResolverLike;
}): Promise<RecordingOutputOverrides> {
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
          markdownFrontmatter: createDefaultWorkspaceMarkdownFrontmatterConfig(
            overrides.markdownFrontmatter,
          ),
          writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(
            overrides.writerFeatureFlags,
          ),
          workspaceTimezone: overrides.workspaceTimezone ??
            DEFAULT_WORKSPACE_TIMEZONE,
          captureIncludeSystemEvents: options.captureIncludeSystemEvents,
        });
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  return createOutputOverrides({
    markdownFrontmatter: createDefaultWorkspaceMarkdownFrontmatterConfig(),
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(
      options.output.writerFeatureFlags,
    ),
    workspaceTimezone: DEFAULT_WORKSPACE_TIMEZONE,
    captureIncludeSystemEvents: options.captureIncludeSystemEvents,
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
        );
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
              snapshotSnippet,
              boundarySnapshot,
              rawArgument: command.argument,
              now: now(),
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
              applyWorkspaceProfileSnapshot(output, profile);
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
            applyWorkspaceProfileSnapshot(output, profile);
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
              await recordingPipeline.appendToDestination({
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
            }
            output.writeCursor = writeCursor;
            metadataChanged = true;
          }
        } else if (command.verb === "capture") {
          const resolved = await resolveWorkspaceCommandDestination({
            profile,
            provider,
            sessionId: providerSessionId,
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            ensureGeneratedPathUnique: true,
            now: now(),
          });
          let targetPath = await validateDestinationPathForCommand(
            recordingPipeline,
            provider,
            providerSessionId,
            resolved.resolvedPath,
            "capture",
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
          applyWorkspaceProfileSnapshot(output, profile);
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
            await recordingPipeline.appendToDestination({
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
          }
          output.writeCursor = writeCursor;
          stateChanged = true;
          metadataChanged = metadataChanged || stateChanged;
        } else if (command.verb === "export") {
          const resolved = await resolveWorkspaceCommandDestination({
            profile,
            provider,
            sessionId: providerSessionId,
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            now: now(),
          });
          const targetPath = await validateDestinationPathForCommand(
            recordingPipeline,
            provider,
            providerSessionId,
            resolved.resolvedPath,
            "export",
          );
          loggedTargetPath = targetPath;
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
        );
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
              snapshotSnippet,
              boundarySnapshot,
              rawArgument: command.argument,
              now: now(),
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
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            ensureGeneratedPathUnique: true,
            now: now(),
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
            snapshotSnippet,
            boundarySnapshot,
            rawArgument: command.argument,
            now: now(),
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

function readWorkspaceOutputInitialStartedAt(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
): string {
  for (let i = 0; i < output.recordingCycles.length; i += 1) {
    const cycle = output.recordingCycles[i];
    if (cycle?.startedAt) {
      return cycle.startedAt;
    }
  }
  return output.createdAt ?? "";
}

function readWorkspaceOutputLatestStartedAt(
  output: NonNullable<SessionMetadataV1["workspaceOutputs"]>[number],
): string | undefined {
  for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
    const cycle = output.recordingCycles[i];
    if (cycle?.startedAt) {
      return cycle.startedAt;
    }
  }
  return undefined;
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
    captureIncludeSystemEvents,
    workspaceCatalog,
    workspaceProfileResolver,
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
    const commandCursor = resolveCommandStartCursor(metadata, snapshot.events);
    for (let i = commandCursor; i < snapshot.events.length; i += 1) {
      const event = snapshot.events[i];
      if (!event || event.kind !== "message.user") {
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
        });
        await recordingPipeline.appendToDestination({
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
    for (const output of metadata.workspaceOutputs ?? []) {
      if (output.desiredState !== "on") {
        continue;
      }
      const startedAt = readWorkspaceOutputInitialStartedAt(output) ||
        metadata.updatedAt;
      const restartedAt = readWorkspaceOutputLatestStartedAt(output);
      recordings.push({
        recordingId: output.activeRecordingCycleId ?? output.workspaceId,
        provider: metadata.provider,
        sessionId: metadata.providerSessionId,
        workspaceAlias: output.workspaceAliasSnapshot,
        outputPath: output.currentResolvedPath,
        startedAt,
        ...(restartedAt && restartedAt !== startedAt ? { restartedAt } : {}),
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
      ...(status.lastEventAt ? { lastEventAt: status.lastEventAt } : {}),
    }));
}

function toSessionStatuses(
  sessionSnapshots: SessionSnapshotMetadataEntry[],
  activeRecordings: ActiveRecording[],
  now: Date,
  staleAfterMs: number,
  sessionMetadataByKey?: Map<string, SessionMetadataV1>,
): DaemonSessionStatus[] {
  const recordingsByKey = new Map<string, ActiveRecording[]>();
  for (const rec of activeRecordings) {
    const key = makeSessionProcessingKey(rec.provider, rec.sessionId);
    const existing = recordingsByKey.get(key);
    if (existing) {
      existing.push(rec);
    } else {
      recordingsByKey.set(key, [rec]);
    }
  }

  const statuses = sessionSnapshots.map((snap) => {
    const metadata = sessionMetadataByKey?.get(
      `${snap.provider}:${snap.sessionId}`,
    );
    const recordings = recordingsByKey.get(
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
      recordings: recordings?.map((recording) => ({
        provider: recording.provider,
        sessionId: recording.sessionId,
        ...(recording.recordingId
          ? { recordingId: recording.recordingId }
          : {}),
        ...(recording.recordingId
          ? { recordingShortId: recording.recordingId.slice(0, 8) }
          : {}),
        ...(recording.workspaceAlias
          ? { workspaceAlias: recording.workspaceAlias }
          : {}),
        outputPath: recording.outputPath,
        startedAt: recording.startedAt,
        lastWriteAt: recording.lastWriteAt,
      })),
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
  const daemonFeatureFlags = options.daemonFeatureFlags ?? {
    daemonExportEnabled: true,
    captureIncludeSystemEvents: false,
  };
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
              captureIncludeSystemEvents:
                daemonFeatureFlags.captureIncludeSystemEvents,
              workspaceCatalog,
              workspaceProfileResolver,
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
          ...(defaultCliExportOutputOverrides
            ? { outputOverrides: defaultCliExportOutputOverrides }
            : {}),
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
