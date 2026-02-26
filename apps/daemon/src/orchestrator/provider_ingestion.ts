import type {
  ConversationEvent,
  ProviderAutoGenerateSnapshots,
  ProviderCursor,
  SessionIngestAnchorV1,
  SessionMetadataV1,
} from "@kato/shared";
import { basename, join } from "@std/path";
import {
  type DebouncedWatchBatch,
  type WatchDebounceOptions,
  watchFsDebounced,
} from "../core/watcher.ts";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import { parseClaudeEvents } from "../providers/claude/mod.ts";
import { parseCodexEvents } from "../providers/codex/mod.ts";
import { parseGeminiEvents } from "../providers/gemini/mod.ts";
import type {
  ProviderIngestionPollResult,
  ProviderIngestionRunner,
  SessionSnapshotStore,
} from "./ingestion_runtime.ts";
import {
  makeDefaultSessionCursor,
  type PersistentSessionStateStore,
  SessionStateLoadError,
} from "./session_state_store.ts";
import {
  mapConversationEventsToTwin,
  mapTwinEventsToConversation,
} from "./session_twin_mapper.ts";
import {
  expandHomePath,
  readOptionalEnv,
  resolveHomeDir,
} from "../utils/env.ts";
import { hashStringFNV1a, stableStringify } from "../utils/hash.ts";

export interface ProviderSessionFile {
  sessionId: string;
  filePath: string;
  modifiedAtMs: number;
}

export interface FileProviderIngestionRunnerOptions {
  provider: string;
  watchRoots: string[];
  discoverSessions: () => Promise<ProviderSessionFile[]>;
  parseEvents: (
    filePath: string,
    fromOffset: number,
    ctx: { provider: string; sessionId: string },
  ) => AsyncIterable<{ event: ConversationEvent; cursor: ProviderCursor }>;
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore?: PersistentSessionStateStore;
  autoGenerateSnapshots?: boolean;
  discoveryIntervalMs?: number;
  watchDebounceMs?: number;
  now?: () => Date;
  watchFs?: (
    watchPaths: string[],
    onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void,
    options: WatchDebounceOptions,
  ) => Promise<void>;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface ProviderIngestionFactoryOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore?: PersistentSessionStateStore;
  globalAutoGenerateSnapshots?: boolean;
  providerAutoGenerateSnapshots?: ProviderAutoGenerateSnapshots;
  now?: () => Date;
  watchDebounceMs?: number;
  discoveryIntervalMs?: number;
  claudeSessionRoots?: string[];
  codexSessionRoots?: string[];
  geminiSessionRoots?: string[];
  watchFs?: (
    watchPaths: string[],
    onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void,
    options: WatchDebounceOptions,
  ) => Promise<void>;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface CreateProviderIngestionRunnerOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore?: PersistentSessionStateStore;
  autoGenerateSnapshots?: boolean;
  sessionRoots?: string[];
  now?: () => Date;
  watchDebounceMs?: number;
  discoveryIntervalMs?: number;
  watchFs?: (
    watchPaths: string[],
    onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void,
    options: WatchDebounceOptions,
  ) => Promise<void>;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

interface IngestSessionResult {
  updated: boolean;
  eventsObserved: number;
}

interface CodexSessionMeta {
  id: string;
  source: string;
}

const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_DEBOUNCE_MS = 250;
type ProviderReadOperation = "stat" | "readDir" | "open";

class ProviderIngestionReadDeniedError extends Error {
  readonly operation: ProviderReadOperation;
  readonly targetPath: string;
  readonly causeError: Error;

  constructor(
    operation: ProviderReadOperation,
    targetPath: string,
    causeError: Error,
  ) {
    super(
      `permission denied for ${operation} on '${targetPath}': ${causeError.message}`,
    );
    this.name = "ProviderIngestionReadDeniedError";
    this.operation = operation;
    this.targetPath = targetPath;
    this.causeError = causeError;
  }
}

function makeNoopOperationalLogger(now: () => Date): StructuredLogger {
  return new StructuredLogger([new NoopSink()], {
    channel: "operational",
    minLevel: "info",
    now,
  });
}

function makeNoopAuditLogger(now: () => Date): AuditLogger {
  return new AuditLogger(
    new StructuredLogger([new NoopSink()], {
      channel: "security-audit",
      minLevel: "info",
      now,
    }),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveByteOffset(cursor: ProviderCursor | undefined): number {
  if (cursor?.kind === "byte-offset" && Number.isFinite(cursor.value)) {
    return Math.max(0, Math.floor(cursor.value));
  }
  return 0;
}

function resolveItemIndex(cursor: ProviderCursor | undefined): number {
  if (cursor?.kind === "item-index" && Number.isFinite(cursor.value)) {
    return Math.max(0, Math.floor(cursor.value));
  }
  return 0;
}

function resolveCursorPosition(cursor: ProviderCursor | undefined): number {
  if (cursor?.kind === "byte-offset") {
    return resolveByteOffset(cursor);
  }
  if (cursor?.kind === "item-index") {
    return resolveItemIndex(cursor);
  }
  return 0;
}

function cursorsEqual(
  a: ProviderCursor | undefined,
  b: ProviderCursor | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.value === b.value;
}

function makeByteOffsetCursor(offset: number): ProviderCursor {
  return {
    kind: "byte-offset",
    value: Math.max(0, Math.floor(offset)),
  };
}

function makeItemIndexCursor(index: number): ProviderCursor {
  return {
    kind: "item-index",
    value: Math.max(0, Math.floor(index)),
  };
}

function normalizeRoots(paths: string[]): string[] {
  const deduped = new Set<string>();
  for (const path of paths) {
    if (!isNonEmptyString(path)) continue;
    deduped.add(expandHomePath(path.trim()));
  }
  return Array.from(deduped);
}

function parseRootsFromEnv(name: string): string[] | undefined {
  const raw = readOptionalEnv(name);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const roots = normalizeRoots(parsed.filter(isNonEmptyString));
  return roots.length > 0 ? roots : undefined;
}

function resolveClaudeSessionRoots(overrides?: string[]): string[] {
  if (overrides) return normalizeRoots(overrides);
  const envRoots = parseRootsFromEnv("KATO_CLAUDE_SESSION_ROOTS");
  if (envRoots && envRoots.length > 0) return envRoots;
  const home = resolveHomeDir();
  if (!home) return [];
  return normalizeRoots([join(home, ".claude", "projects")]);
}

function resolveCodexSessionRoots(overrides?: string[]): string[] {
  if (overrides) return normalizeRoots(overrides);
  const envRoots = parseRootsFromEnv("KATO_CODEX_SESSION_ROOTS");
  if (envRoots && envRoots.length > 0) return envRoots;
  const home = resolveHomeDir();
  if (!home) return [];
  return normalizeRoots([join(home, ".codex", "sessions")]);
}

function resolveGeminiSessionRoots(overrides?: string[]): string[] {
  if (overrides) return normalizeRoots(overrides);
  const envRoots = parseRootsFromEnv("KATO_GEMINI_SESSION_ROOTS");
  if (envRoots && envRoots.length > 0) return envRoots;
  const home = resolveHomeDir();
  if (!home) return [];
  return normalizeRoots([join(home, ".gemini", "tmp")]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("stat", path, error);
    }
    throw error;
  }
}

async function* walkJsonlFiles(root: string): AsyncGenerator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(current);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      if (error instanceof Deno.errors.PermissionDenied) {
        throw new ProviderIngestionReadDeniedError("readDir", current, error);
      }
      throw error;
    }
    for await (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        yield fullPath;
      }
    }
  }
}

async function* walkJsonFiles(root: string): AsyncGenerator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(current);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        continue;
      }
      if (error instanceof Deno.errors.PermissionDenied) {
        throw new ProviderIngestionReadDeniedError("readDir", current, error);
      }
      throw error;
    }
    for await (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile && entry.name.endsWith(".json")) {
        yield fullPath;
      }
    }
  }
}

async function statModifiedAtMs(path: string): Promise<number> {
  try {
    const stat = await Deno.stat(path);
    return stat.mtime?.getTime() ?? 0;
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("stat", path, error);
    }
    throw error;
  }
}

async function discoverClaudeSessions(
  roots: string[],
): Promise<ProviderSessionFile[]> {
  const sessions: ProviderSessionFile[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for await (const filePath of walkJsonlFiles(root)) {
      const sessionId = basename(filePath, ".jsonl");
      if (!isNonEmptyString(sessionId)) continue;
      sessions.push({
        sessionId,
        filePath,
        modifiedAtMs: await statModifiedAtMs(filePath),
      });
    }
  }
  return sessions;
}

async function readFirstLineChunk(
  filePath: string,
): Promise<string | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(filePath, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("open", filePath, error);
    }
    throw error;
  }
  try {
    const buffer = new Uint8Array(32 * 1024);
    const read = await file.read(buffer);
    if (read === null || read === 0) return undefined;
    const chunk = new TextDecoder().decode(buffer.subarray(0, read));
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.trim().length > 0) return line;
    }
    return undefined;
  } finally {
    file.close();
  }
}

async function readCodexSessionMeta(
  filePath: string,
): Promise<CodexSessionMeta | undefined> {
  const firstLine = await readFirstLineChunk(filePath);
  if (!firstLine) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const entry = parsed as { type?: unknown; payload?: Record<string, unknown> };
  if (entry.type !== "session_meta" || !entry.payload) return undefined;
  const id = entry.payload["id"];
  const source = entry.payload["source"];
  if (!isNonEmptyString(id)) return undefined;
  return {
    id: id.trim(),
    source: isNonEmptyString(source) ? source.trim() : "",
  };
}

async function discoverCodexSessions(
  roots: string[],
): Promise<ProviderSessionFile[]> {
  const sessions: ProviderSessionFile[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for await (const filePath of walkJsonlFiles(root)) {
      const meta = await readCodexSessionMeta(filePath);
      if (!meta || meta.source === "exec") continue;
      sessions.push({
        sessionId: meta.id,
        filePath,
        modifiedAtMs: await statModifiedAtMs(filePath),
      });
    }
  }
  return sessions;
}

async function readGeminiSessionId(
  filePath: string,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(filePath)) as unknown;
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("open", filePath, error);
    }
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root["messages"])) {
    return undefined;
  }
  const sessionId = root["sessionId"];
  if (isNonEmptyString(sessionId)) {
    return sessionId.trim();
  }
  const fromName = basename(filePath, ".json").trim();
  return fromName.length > 0 ? fromName : undefined;
}

async function discoverGeminiSessions(
  roots: string[],
): Promise<ProviderSessionFile[]> {
  const sessions: ProviderSessionFile[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for await (const filePath of walkJsonFiles(root)) {
      const filename = basename(filePath);
      if (!filename.startsWith("session-")) continue;
      const sessionId = await readGeminiSessionId(filePath);
      if (!sessionId) continue;
      sessions.push({
        sessionId,
        filePath,
        modifiedAtMs: await statModifiedAtMs(filePath),
      });
    }
  }
  return sessions;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAnchorStringField(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  return value.trim();
}

function normalizeGeminiMessageForAnchor(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: readAnchorStringField(message["type"]) ?? "",
    content: message["content"],
    displayContent: message["displayContent"],
    thoughts: message["thoughts"],
    toolCalls: message["toolCalls"],
    model: readAnchorStringField(message["model"]) ?? "",
  };
}

function buildGeminiMessageAnchor(
  message: Record<string, unknown>,
): SessionIngestAnchorV1 {
  const messageId = readAnchorStringField(message["id"]);
  const payloadHash = hashStringFNV1a(
    stableStringify(normalizeGeminiMessageForAnchor(message)),
  );
  return {
    ...(messageId ? { messageId } : {}),
    payloadHash,
  };
}

function findGeminiAnchorIndex(
  messages: Record<string, unknown>[],
  anchor: SessionIngestAnchorV1,
): number | undefined {
  if (isNonEmptyString(anchor.messageId)) {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) continue;
      const messageId = readAnchorStringField(message["id"]);
      if (messageId === anchor.messageId) {
        return index;
      }
    }
  }

  if (!isNonEmptyString(anchor.payloadHash)) {
    return undefined;
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const candidate = buildGeminiMessageAnchor(message);
    if (candidate.payloadHash === anchor.payloadHash) {
      return index;
    }
  }
  return undefined;
}

function anchorsEqual(
  a: SessionIngestAnchorV1 | undefined,
  b: SessionIngestAnchorV1 | undefined,
): boolean {
  if (!a || !b) {
    return a === b;
  }
  if (isNonEmptyString(a.messageId) || isNonEmptyString(b.messageId)) {
    return (a.messageId ?? "") === (b.messageId ?? "");
  }
  return (a.payloadHash ?? "") === (b.payloadHash ?? "");
}

async function readGeminiMessages(
  filePath: string,
): Promise<Record<string, unknown>[] | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(filePath)) as unknown;
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("open", filePath, error);
    }
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    return undefined;
  }

  if (!isRecordValue(parsed)) {
    return undefined;
  }
  const messages = parsed["messages"];
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.filter((item): item is Record<string, unknown> =>
    isRecordValue(item)
  );
}

function eventSignature(event: ConversationEvent): string {
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

function mergeEvents(
  existingEvents: ConversationEvent[],
  incomingEvents: ConversationEvent[],
): { mergedEvents: ConversationEvent[]; droppedEvents: number } {
  const signatures = new Set(existingEvents.map(eventSignature));
  const mergedEvents = [...existingEvents];
  let droppedEvents = 0;

  for (const event of incomingEvents) {
    const signature = eventSignature(event);
    if (signatures.has(signature)) {
      droppedEvents += 1;
      continue;
    }
    signatures.add(signature);
    mergedEvents.push(event);
  }

  return { mergedEvents, droppedEvents };
}

export class FileProviderIngestionRunner implements ProviderIngestionRunner {
  readonly provider: string;
  private readonly now: () => Date;
  private readonly discoveryIntervalMs: number;
  private readonly watchDebounceMs: number;
  private readonly watchFs: (
    watchPaths: string[],
    onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void,
    options: WatchDebounceOptions,
  ) => Promise<void>;
  private readonly operationalLogger: StructuredLogger;
  private readonly auditLogger: AuditLogger;
  private readonly sessionSnapshotStore: SessionSnapshotStore;
  private readonly sessionStateStore: PersistentSessionStateStore | undefined;
  private readonly autoGenerateSnapshots: boolean;
  private readonly discoverSessions: () => Promise<ProviderSessionFile[]>;
  private readonly parseEvents: (
    filePath: string,
    fromOffset: number,
    ctx: { provider: string; sessionId: string },
  ) => AsyncIterable<{ event: ConversationEvent; cursor: ProviderCursor }>;
  private readonly watchRoots: string[];
  private readonly sessions = new Map<string, ProviderSessionFile>();
  private readonly sessionByFilePath = new Map<string, string>();
  private readonly dirtySessions = new Set<string>();
  private readonly cursors = new Map<string, ProviderCursor>();
  private readonly pendingBatchPaths = new Set<string>();
  private nextDiscoveryAtMs = 0;
  private needsDiscovery = true;
  private started = false;
  private lastDuplicateDiscoveryWarningKey: string | undefined;
  private watchAbortController: AbortController | undefined;
  private watchTask: Promise<void> | undefined;
  private readonly failedClosedSessions = new Set<string>();

  constructor(options: FileProviderIngestionRunnerOptions) {
    this.provider = options.provider;
    this.watchRoots = normalizeRoots(options.watchRoots);
    this.discoverSessions = options.discoverSessions;
    this.parseEvents = options.parseEvents;
    this.sessionSnapshotStore = options.sessionSnapshotStore;
    this.sessionStateStore = options.sessionStateStore;
    this.autoGenerateSnapshots = options.autoGenerateSnapshots ?? false;
    this.now = options.now ?? (() => new Date());
    this.discoveryIntervalMs = options.discoveryIntervalMs ??
      DEFAULT_DISCOVERY_INTERVAL_MS;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.watchFs = options.watchFs ?? watchFsDebounced;
    this.operationalLogger = options.operationalLogger ??
      makeNoopOperationalLogger(this.now);
    this.auditLogger = options.auditLogger ?? makeNoopAuditLogger(this.now);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.needsDiscovery = true;

    await this.operationalLogger.info(
      "provider.ingestion.started",
      "Provider ingestion runner started",
      { provider: this.provider, watchRoots: this.watchRoots },
    );

    const existingWatchRoots: string[] = [];
    for (const root of this.watchRoots) {
      try {
        if (await pathExists(root)) {
          existingWatchRoots.push(root);
        }
      } catch (error) {
        if (!(await this.handleReadDenied(error, "stat", root))) {
          throw error;
        }
      }
    }

    if (existingWatchRoots.length > 0) {
      this.watchAbortController = new AbortController();
      this.watchTask = this.watchFs(
        existingWatchRoots,
        (batch) => this.onWatchBatch(batch),
        {
          debounceMs: this.watchDebounceMs,
          recursive: true,
          signal: this.watchAbortController.signal,
          now: this.now,
        },
      ).catch(async (error) => {
        await this.operationalLogger.error(
          "provider.ingestion.watch.failed",
          "Provider ingestion watch loop failed",
          {
            provider: this.provider,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    }
  }

  async poll(): Promise<ProviderIngestionPollResult> {
    if (!this.started) {
      throw new Error(
        `Provider ingestion runner not started: ${this.provider}`,
      );
    }

    if (this.needsDiscovery || this.now().getTime() >= this.nextDiscoveryAtMs) {
      await this.discoverAndTrackSessions();
    }

    for (const path of this.pendingBatchPaths) {
      const sessionId = this.sessionByFilePath.get(path);
      if (sessionId) {
        this.dirtySessions.add(sessionId);
      } else {
        this.needsDiscovery = true;
      }
    }
    this.pendingBatchPaths.clear();

    if (this.needsDiscovery) {
      await this.discoverAndTrackSessions();
    }

    const dirtySessions = Array.from(this.dirtySessions.values()).sort();
    this.dirtySessions.clear();

    let sessionsUpdated = 0;
    let eventsObserved = 0;

    for (const sessionId of dirtySessions) {
      const result = await this.ingestSession(sessionId);
      if (result.updated) sessionsUpdated += 1;
      eventsObserved += result.eventsObserved;
    }

    return {
      provider: this.provider,
      polledAt: this.now().toISOString(),
      sessionsUpdated,
      eventsObserved,
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.watchAbortController) {
      this.watchAbortController.abort();
      this.watchAbortController = undefined;
    }
    if (this.watchTask) {
      await this.watchTask;
      this.watchTask = undefined;
    }

    await this.operationalLogger.info(
      "provider.ingestion.stopped",
      "Provider ingestion runner stopped",
      { provider: this.provider },
    );
  }

  private async onWatchBatch(batch: DebouncedWatchBatch): Promise<void> {
    for (const path of batch.paths) {
      this.pendingBatchPaths.add(path);
      if (!this.sessionByFilePath.has(path)) {
        this.needsDiscovery = true;
      }
    }
    await this.operationalLogger.debug(
      "provider.ingestion.watch.batch",
      "Provider ingestion watch batch received",
      { provider: this.provider, paths: batch.paths, kinds: batch.kinds },
    );
  }

  private async logReadDenied(
    operation: ProviderReadOperation,
    targetPath: string,
    error: Error,
  ): Promise<void> {
    const attributes = {
      provider: this.provider,
      operation,
      targetPath,
      reason: error.message,
    };

    await this.operationalLogger.warn(
      "provider.ingestion.read_denied",
      "Provider ingestion read access denied",
      attributes,
    );
    await this.auditLogger.record(
      "provider.ingestion.read_denied",
      "Provider ingestion read access denied",
      attributes,
    );
  }

  private async handleReadDenied(
    error: unknown,
    fallbackOperation: ProviderReadOperation,
    fallbackTargetPath: string,
  ): Promise<boolean> {
    if (error instanceof ProviderIngestionReadDeniedError) {
      await this.logReadDenied(
        error.operation,
        error.targetPath,
        error.causeError,
      );
      return true;
    }
    if (error instanceof Deno.errors.PermissionDenied) {
      await this.logReadDenied(fallbackOperation, fallbackTargetPath, error);
      return true;
    }
    return false;
  }

  private async discoverAndTrackSessions(): Promise<void> {
    let discovered: ProviderSessionFile[];
    try {
      discovered = await this.discoverSessions();
    } catch (error) {
      if (
        await this.handleReadDenied(
          error,
          "readDir",
          this.watchRoots[0] ?? "unknown",
        )
      ) {
        this.needsDiscovery = false;
        this.nextDiscoveryAtMs = this.now().getTime() +
          this.discoveryIntervalMs;
        return;
      }
      throw error;
    }
    const deduped = await this.dedupeDiscoveredSessions(discovered);
    const activeSessionIds = new Set<string>();

    for (const session of deduped) {
      activeSessionIds.add(session.sessionId);
      const current = this.sessions.get(session.sessionId);
      if (!current || current.filePath !== session.filePath) {
        this.sessions.set(session.sessionId, session);
        this.sessionByFilePath.set(session.filePath, session.sessionId);
        if (current && current.filePath !== session.filePath) {
          this.sessionByFilePath.delete(current.filePath);
        }
        this.dirtySessions.add(session.sessionId);
      }
    }

    for (const [sessionId, existing] of this.sessions) {
      if (!activeSessionIds.has(sessionId)) {
        this.sessions.delete(sessionId);
        this.sessionByFilePath.delete(existing.filePath);
      }
    }

    this.needsDiscovery = false;
    this.nextDiscoveryAtMs = this.now().getTime() + this.discoveryIntervalMs;
  }

  private async dedupeDiscoveredSessions(
    sessions: ProviderSessionFile[],
  ): Promise<ProviderSessionFile[]> {
    const bySessionId = new Map<string, ProviderSessionFile>();
    const duplicateSessionIds = new Set<string>();
    let droppedEvents = 0;

    const sorted = [...sessions].sort((a, b) => {
      if (a.sessionId === b.sessionId) return b.modifiedAtMs - a.modifiedAtMs;
      return a.sessionId.localeCompare(b.sessionId);
    });

    for (const session of sorted) {
      if (!bySessionId.has(session.sessionId)) {
        bySessionId.set(session.sessionId, session);
      } else {
        droppedEvents += 1;
        duplicateSessionIds.add(session.sessionId);
      }
    }

    if (droppedEvents > 0) {
      const warningKey = `${droppedEvents}:${
        Array.from(duplicateSessionIds)
          .sort()
          .join(",")
      }`;
      if (this.lastDuplicateDiscoveryWarningKey === warningKey) {
        return Array.from(bySessionId.values());
      }
      this.lastDuplicateDiscoveryWarningKey = warningKey;
      await this.operationalLogger.debug(
        "provider.ingestion.events_dropped",
        "Dropped duplicate session discovery events",
        {
          provider: this.provider,
          droppedEvents,
          reason: "duplicate-session-id",
          duplicateSessionIds: Array.from(duplicateSessionIds).sort(),
        },
      );
    } else {
      this.lastDuplicateDiscoveryWarningKey = undefined;
    }

    return Array.from(bySessionId.values());
  }

  private async ingestSession(sessionId: string): Promise<IngestSessionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { updated: false, eventsObserved: 0 };

    const currentSnapshot = this.sessionSnapshotStore.get(sessionId);
    let stateMetadata: SessionMetadataV1 | undefined;
    if (this.sessionStateStore) {
      try {
        stateMetadata = await this.sessionStateStore.getOrCreateSessionMetadata(
          {
            provider: this.provider,
            providerSessionId: sessionId,
            sourceFilePath: session.filePath,
            initialCursor: this.cursors.get(sessionId) ??
              makeDefaultSessionCursor(this.provider),
          },
        );
        this.failedClosedSessions.delete(`${this.provider}:${sessionId}`);
      } catch (error) {
        if (error instanceof SessionStateLoadError) {
          const sessionKey = `${this.provider}:${sessionId}`;
          if (!this.failedClosedSessions.has(sessionKey)) {
            const attributes = {
              provider: this.provider,
              sessionId,
              metadataPath: error.metadataPath,
              reason: error.reason,
              action: "delete metadata file to rebuild from source",
              error: error.message,
            };
            await this.operationalLogger.error(
              "session.state.fail_closed",
              "Failing closed for session state due to invalid or unsupported metadata",
              attributes,
            );
            await this.auditLogger.record(
              "session.state.fail_closed",
              "Failing closed for session state due to invalid or unsupported metadata",
              attributes,
            );
            this.failedClosedSessions.add(sessionKey);
          }
          return { updated: false, eventsObserved: 0 };
        }
        throw error;
      }
    }

    let existingCursor = stateMetadata?.ingestCursor ??
      this.cursors.get(sessionId);
    const resumeSource = stateMetadata
      ? "persisted"
      : this.cursors.has(sessionId)
      ? "memory"
      : "default";
    let fromOffset = resolveCursorPosition(existingCursor);
    let fileStat: Deno.FileInfo;
    try {
      fileStat = await Deno.stat(session.filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { updated: false, eventsObserved: 0 };
      }
      if (await this.handleReadDenied(error, "stat", session.filePath)) {
        return { updated: false, eventsObserved: 0 };
      }
      throw error;
    }

    if (existingCursor?.kind === "byte-offset") {
      const fileSize = fileStat.size ?? 0;
      if (fromOffset > fileSize) {
        fromOffset = 0;
        existingCursor = makeByteOffsetCursor(0);
        this.cursors.set(sessionId, existingCursor);
        if (stateMetadata) {
          stateMetadata.ingestCursor = existingCursor;
        }
        await this.operationalLogger.warn(
          "provider.ingestion.cursor.reset",
          "Provider ingestion cursor reset after file truncation",
          { provider: this.provider, sessionId, filePath: session.filePath },
        );
      }
    }

    await this.operationalLogger.debug(
      "provider.ingestion.cursor.resume",
      "Resuming provider ingestion cursor",
      {
        provider: this.provider,
        sessionId,
        filePath: session.filePath,
        source: resumeSource,
        cursorKind: existingCursor?.kind ?? "unknown",
        fromOffset,
      },
    );

    let geminiMessagesCache: Record<string, unknown>[] | undefined;
    const loadGeminiMessagesForAnchor = async (
      forceRefresh: boolean = false,
    ): Promise<Record<string, unknown>[] | undefined> => {
      if (this.provider !== "gemini") {
        return undefined;
      }
      if (!forceRefresh && geminiMessagesCache !== undefined) {
        return geminiMessagesCache;
      }
      geminiMessagesCache = await readGeminiMessages(session.filePath);
      return geminiMessagesCache;
    };

    let replayedFromStart = false;
    if (
      this.provider === "gemini" &&
      stateMetadata &&
      existingCursor?.kind === "item-index" &&
      fromOffset > 0 &&
      stateMetadata.ingestAnchor
    ) {
      let messages: Record<string, unknown>[] | undefined;
      try {
        messages = await loadGeminiMessagesForAnchor();
      } catch (error) {
        if (await this.handleReadDenied(error, "open", session.filePath)) {
          return { updated: false, eventsObserved: 0 };
        }
        throw error;
      }

      if (messages) {
        const expectedAnchor = stateMetadata.ingestAnchor;
        const currentAnchor = messages[fromOffset - 1]
          ? buildGeminiMessageAnchor(messages[fromOffset - 1]!)
          : undefined;

        if (!anchorsEqual(expectedAnchor, currentAnchor)) {
          const previousOffset = fromOffset;
          const realignedIndex = findGeminiAnchorIndex(
            messages,
            expectedAnchor,
          );
          if (realignedIndex === undefined) {
            fromOffset = 0;
            existingCursor = makeItemIndexCursor(0);
            stateMetadata.ingestCursor = existingCursor;
            this.cursors.set(sessionId, existingCursor);
            replayedFromStart = true;
            await this.operationalLogger.warn(
              "provider.ingestion.anchor.not_found",
              "Gemini anchor missing; replaying session from start with dedupe",
              {
                provider: this.provider,
                sessionId,
                filePath: session.filePath,
                previousCursor: previousOffset,
                anchor: expectedAnchor,
              },
            );
          } else {
            const realignedOffset = realignedIndex + 1;
            if (realignedOffset !== fromOffset) {
              fromOffset = realignedOffset;
              existingCursor = makeItemIndexCursor(realignedOffset);
              stateMetadata.ingestCursor = existingCursor;
              this.cursors.set(sessionId, existingCursor);
              await this.operationalLogger.warn(
                "provider.ingestion.anchor.realigned",
                "Gemini anchor mismatch resolved by re-aligning cursor",
                {
                  provider: this.provider,
                  sessionId,
                  filePath: session.filePath,
                  previousCursor: previousOffset,
                  realignedCursor: realignedOffset,
                  anchor: expectedAnchor,
                },
              );
            }
          }
        }
      }
    }

    if (stateMetadata && this.sessionStateStore) {
      const hasActiveRecordings = stateMetadata.recordings.some((recording) =>
        recording.desiredState === "on"
      );
      const shouldAppendTwin = this.autoGenerateSnapshots ||
        hasActiveRecordings;
      if (shouldAppendTwin) {
        let twinExists = true;
        try {
          await Deno.stat(stateMetadata.twinPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            twinExists = false;
          } else if (
            await this.handleReadDenied(error, "stat", stateMetadata.twinPath)
          ) {
            return { updated: false, eventsObserved: 0 };
          } else {
            throw error;
          }
        }

        const needsBootstrap = !twinExists &&
          (
            fromOffset > 0 ||
            stateMetadata.nextTwinSeq > 1 ||
            stateMetadata.recentFingerprints.length > 0
          );
        if (needsBootstrap) {
          await this.operationalLogger.info(
            "provider.ingestion.twin.bootstrap",
            "Session twin missing; rebuilding twin from source",
            {
              provider: this.provider,
              sessionId,
              filePath: session.filePath,
              twinPath: stateMetadata.twinPath,
            },
          );

          stateMetadata.nextTwinSeq = 1;
          stateMetadata.recentFingerprints = [];
          const bootstrapEvents: ConversationEvent[] = [];
          let bootstrapCursor: ProviderCursor = this.provider === "gemini"
            ? makeItemIndexCursor(0)
            : makeByteOffsetCursor(0);
          try {
            for await (
              const { event, cursor } of this.parseEvents(
                session.filePath,
                0,
                { provider: this.provider, sessionId },
              )
            ) {
              bootstrapEvents.push(event);
              if (
                cursor.kind === "byte-offset" || cursor.kind === "item-index"
              ) {
                const current = resolveCursorPosition(bootstrapCursor);
                const incoming = resolveCursorPosition(cursor);
                if (
                  cursor.kind !== bootstrapCursor.kind || incoming > current
                ) {
                  bootstrapCursor = cursor;
                }
              } else {
                bootstrapCursor = cursor;
              }
            }
          } catch (error) {
            if (await this.handleReadDenied(error, "open", session.filePath)) {
              return { updated: false, eventsObserved: 0 };
            }
            throw error;
          }

          if (bootstrapEvents.length > 0) {
            const twinDrafts = mapConversationEventsToTwin({
              provider: this.provider,
              providerSessionId: sessionId,
              sessionId: stateMetadata.sessionId,
              events: bootstrapEvents,
              mode: "backfill",
            });
            const appendResult = await this.sessionStateStore.appendTwinEvents(
              stateMetadata,
              twinDrafts,
            );
            if (appendResult.droppedAsDuplicate > 0) {
              await this.operationalLogger.debug(
                "provider.ingestion.events_dropped",
                "Provider ingestion dropped duplicate events during twin bootstrap",
                {
                  provider: this.provider,
                  sessionId,
                  droppedEvents: appendResult.droppedAsDuplicate,
                  reason: "duplicate-session-twin-bootstrap",
                },
              );
            }
          }

          fromOffset = resolveCursorPosition(bootstrapCursor);
          existingCursor = bootstrapCursor;
          stateMetadata.ingestCursor = bootstrapCursor;
          stateMetadata.lastObservedMtimeMs = fileStat.mtime?.getTime();
          stateMetadata.sourceFilePath = session.filePath;
          await this.sessionStateStore.saveSessionMetadata(stateMetadata);
          this.cursors.set(sessionId, bootstrapCursor);
        }
      }
    }

    const incomingEvents: ConversationEvent[] = [];
    let latestCursor: ProviderCursor = existingCursor?.kind === "item-index"
      ? makeItemIndexCursor(fromOffset)
      : makeByteOffsetCursor(fromOffset);

    try {
      for await (
        const { event, cursor } of this.parseEvents(
          session.filePath,
          fromOffset,
          { provider: this.provider, sessionId },
        )
      ) {
        incomingEvents.push(event);
        if (cursor.kind === "byte-offset" || cursor.kind === "item-index") {
          const current = resolveCursorPosition(latestCursor);
          const incoming = resolveCursorPosition(cursor);
          if (cursor.kind !== latestCursor.kind || incoming > current) {
            latestCursor = cursor;
          }
        } else {
          latestCursor = cursor;
        }
      }
    } catch (error) {
      if (await this.handleReadDenied(error, "open", session.filePath)) {
        return { updated: false, eventsObserved: 0 };
      }
      await this.operationalLogger.error(
        "provider.ingestion.parse_error",
        "Provider ingestion parse failed",
        {
          provider: this.provider,
          sessionId,
          filePath: session.filePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return { updated: false, eventsObserved: 0 };
    }

    const latestOffset = resolveCursorPosition(latestCursor);
    const fileModifiedAtMs = fileStat.mtime?.getTime();

    if (stateMetadata && this.sessionStateStore) {
      const hasActiveRecordings = stateMetadata.recordings.some((recording) =>
        recording.desiredState === "on"
      );
      const shouldAppendTwin = this.autoGenerateSnapshots ||
        hasActiveRecordings;
      let appendedTwinCount = 0;
      let appendedTwinEvents: ReturnType<typeof mapConversationEventsToTwin> =
        [];

      if (shouldAppendTwin && incomingEvents.length > 0) {
        const twinDrafts = mapConversationEventsToTwin({
          provider: this.provider,
          providerSessionId: sessionId,
          sessionId: stateMetadata.sessionId,
          events: incomingEvents,
          mode: "live",
          capturedAt: this.now().toISOString(),
        });
        const appendResult = await this.sessionStateStore.appendTwinEvents(
          stateMetadata,
          twinDrafts,
        );
        appendedTwinCount = appendResult.appended.length;
        appendedTwinEvents = appendResult.appended;
        if (appendResult.droppedAsDuplicate > 0) {
          await this.operationalLogger.debug(
            "provider.ingestion.events_dropped",
            "Provider ingestion dropped duplicate events during twin append",
            {
              provider: this.provider,
              sessionId,
              droppedEvents: appendResult.droppedAsDuplicate,
              reason: replayedFromStart
                ? "duplicate-session-twin-anchor-replay"
                : "duplicate-session-twin",
              replayedFromStart,
            },
          );
        }
      }

      let anchorChanged = false;
      if (this.provider === "gemini" && latestCursor.kind === "item-index") {
        let nextAnchor: SessionIngestAnchorV1 | undefined;
        const latestIndex = resolveItemIndex(latestCursor);
        if (latestIndex > 0) {
          try {
            const messages = await loadGeminiMessagesForAnchor(true);
            const message = messages?.[latestIndex - 1];
            if (message) {
              nextAnchor = buildGeminiMessageAnchor(message);
            }
          } catch (error) {
            if (
              !(await this.handleReadDenied(error, "open", session.filePath))
            ) {
              throw error;
            }
          }
        }
        if (!anchorsEqual(stateMetadata.ingestAnchor, nextAnchor)) {
          stateMetadata.ingestAnchor = nextAnchor;
          anchorChanged = true;
        }
      }

      const cursorChanged = !cursorsEqual(
        stateMetadata.ingestCursor,
        latestCursor,
      );
      const fileMtimeChanged =
        stateMetadata.lastObservedMtimeMs !== fileModifiedAtMs;
      const sourceFileChanged =
        stateMetadata.sourceFilePath !== session.filePath;
      if (
        cursorChanged || fileMtimeChanged || sourceFileChanged || anchorChanged
      ) {
        stateMetadata.ingestCursor = latestCursor;
        stateMetadata.lastObservedMtimeMs = fileModifiedAtMs;
        stateMetadata.sourceFilePath = session.filePath;
        await this.sessionStateStore.saveSessionMetadata(stateMetadata);
      }

      const shouldHydrateSnapshot = appendedTwinCount > 0 ||
        !currentSnapshot ||
        cursorChanged ||
        fileMtimeChanged ||
        sourceFileChanged ||
        anchorChanged;

      if (shouldHydrateSnapshot) {
        if (shouldAppendTwin) {
          const existingSnapshotEvents =
            currentSnapshot?.provider === this.provider
              ? currentSnapshot.events
              : undefined;

          if (!existingSnapshotEvents) {
            const twinEvents = await this.sessionStateStore.readTwinEvents(
              stateMetadata,
              1,
            );
            const rebuiltSnapshotEvents = mapTwinEventsToConversation(
              twinEvents,
            );
            this.sessionSnapshotStore.upsert({
              provider: this.provider,
              sessionId,
              cursor: latestCursor,
              events: rebuiltSnapshotEvents,
              fileModifiedAtMs,
            });
          } else if (appendedTwinEvents.length > 0) {
            const appendedSnapshotEvents = mapTwinEventsToConversation(
              appendedTwinEvents,
            );
            const merged = mergeEvents(
              existingSnapshotEvents,
              appendedSnapshotEvents,
            );
            if (merged.droppedEvents > 0) {
              await this.operationalLogger.debug(
                "provider.ingestion.events_dropped",
                "Provider ingestion dropped duplicate events while merging appended twin events",
                {
                  provider: this.provider,
                  sessionId,
                  droppedEvents: merged.droppedEvents,
                  reason: "duplicate-session-twin-snapshot",
                },
              );
            }
            this.sessionSnapshotStore.upsert({
              provider: this.provider,
              sessionId,
              cursor: latestCursor,
              events: merged.mergedEvents,
              fileModifiedAtMs,
            });
          } else {
            this.sessionSnapshotStore.upsert({
              provider: this.provider,
              sessionId,
              cursor: latestCursor,
              events: existingSnapshotEvents,
              fileModifiedAtMs,
            });
          }
        } else if (incomingEvents.length > 0 || currentSnapshot) {
          const existingEvents = currentSnapshot?.provider === this.provider
            ? currentSnapshot.events
            : [];
          const merged = mergeEvents(existingEvents, incomingEvents);
          if (merged.droppedEvents > 0) {
            await this.operationalLogger.debug(
              "provider.ingestion.events_dropped",
              "Provider ingestion dropped duplicate events",
              {
                provider: this.provider,
                sessionId,
                droppedEvents: merged.droppedEvents,
                reason: "duplicate-event",
              },
            );
          }
          this.sessionSnapshotStore.upsert({
            provider: this.provider,
            sessionId,
            cursor: latestCursor,
            events: merged.mergedEvents,
            fileModifiedAtMs,
          });
        }
      }

      this.cursors.set(sessionId, latestCursor);
      return {
        updated: shouldHydrateSnapshot || latestOffset !== fromOffset,
        eventsObserved: incomingEvents.length,
      };
    }

    if (incomingEvents.length === 0 && latestOffset === fromOffset) {
      return { updated: false, eventsObserved: 0 };
    }

    const existingEvents = currentSnapshot?.provider === this.provider
      ? currentSnapshot.events
      : [];
    const merged = mergeEvents(existingEvents, incomingEvents);

    if (merged.droppedEvents > 0) {
      await this.operationalLogger.debug(
        "provider.ingestion.events_dropped",
        "Provider ingestion dropped duplicate events",
        {
          provider: this.provider,
          sessionId,
          droppedEvents: merged.droppedEvents,
          reason: "duplicate-event",
        },
      );
    }

    this.sessionSnapshotStore.upsert({
      provider: this.provider,
      sessionId,
      cursor: latestCursor,
      events: merged.mergedEvents,
      fileModifiedAtMs,
    });
    this.cursors.set(sessionId, latestCursor);

    return { updated: true, eventsObserved: incomingEvents.length };
  }
}

export function createClaudeIngestionRunner(
  options: CreateProviderIngestionRunnerOptions,
): ProviderIngestionRunner {
  const roots = resolveClaudeSessionRoots(options.sessionRoots);
  return new FileProviderIngestionRunner({
    provider: "claude",
    watchRoots: roots,
    discoverSessions: () => discoverClaudeSessions(roots),
    parseEvents: (filePath, fromOffset, ctx) =>
      parseClaudeEvents(filePath, fromOffset, ctx),
    sessionSnapshotStore: options.sessionSnapshotStore,
    sessionStateStore: options.sessionStateStore,
    autoGenerateSnapshots: options.autoGenerateSnapshots,
    now: options.now,
    discoveryIntervalMs: options.discoveryIntervalMs,
    watchDebounceMs: options.watchDebounceMs,
    watchFs: options.watchFs,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
  });
}

export function createCodexIngestionRunner(
  options: CreateProviderIngestionRunnerOptions,
): ProviderIngestionRunner {
  const roots = resolveCodexSessionRoots(options.sessionRoots);
  return new FileProviderIngestionRunner({
    provider: "codex",
    watchRoots: roots,
    discoverSessions: () => discoverCodexSessions(roots),
    parseEvents: (filePath, fromOffset, ctx) =>
      parseCodexEvents(filePath, fromOffset, ctx),
    sessionSnapshotStore: options.sessionSnapshotStore,
    sessionStateStore: options.sessionStateStore,
    autoGenerateSnapshots: options.autoGenerateSnapshots,
    now: options.now,
    discoveryIntervalMs: options.discoveryIntervalMs,
    watchDebounceMs: options.watchDebounceMs,
    watchFs: options.watchFs,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
  });
}

export function createGeminiIngestionRunner(
  options: CreateProviderIngestionRunnerOptions,
): ProviderIngestionRunner {
  const roots = resolveGeminiSessionRoots(options.sessionRoots);
  return new FileProviderIngestionRunner({
    provider: "gemini",
    watchRoots: roots,
    discoverSessions: () => discoverGeminiSessions(roots),
    parseEvents: (filePath, fromOffset, ctx) =>
      parseGeminiEvents(filePath, fromOffset, ctx),
    sessionSnapshotStore: options.sessionSnapshotStore,
    sessionStateStore: options.sessionStateStore,
    autoGenerateSnapshots: options.autoGenerateSnapshots,
    now: options.now,
    discoveryIntervalMs: options.discoveryIntervalMs,
    watchDebounceMs: options.watchDebounceMs,
    watchFs: options.watchFs,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
  });
}

export function createDefaultProviderIngestionRunners(
  options: ProviderIngestionFactoryOptions,
): ProviderIngestionRunner[] {
  const resolveAutoGenerate = (provider: "claude" | "codex" | "gemini") =>
    options.providerAutoGenerateSnapshots?.[provider] ??
      options.globalAutoGenerateSnapshots ??
      false;

  return [
    createClaudeIngestionRunner({
      sessionSnapshotStore: options.sessionSnapshotStore,
      sessionStateStore: options.sessionStateStore,
      autoGenerateSnapshots: resolveAutoGenerate("claude"),
      sessionRoots: options.claudeSessionRoots,
      now: options.now,
      watchDebounceMs: options.watchDebounceMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      watchFs: options.watchFs,
      operationalLogger: options.operationalLogger,
      auditLogger: options.auditLogger,
    }),
    createCodexIngestionRunner({
      sessionSnapshotStore: options.sessionSnapshotStore,
      sessionStateStore: options.sessionStateStore,
      autoGenerateSnapshots: resolveAutoGenerate("codex"),
      sessionRoots: options.codexSessionRoots,
      now: options.now,
      watchDebounceMs: options.watchDebounceMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      watchFs: options.watchFs,
      operationalLogger: options.operationalLogger,
      auditLogger: options.auditLogger,
    }),
    createGeminiIngestionRunner({
      sessionSnapshotStore: options.sessionSnapshotStore,
      sessionStateStore: options.sessionStateStore,
      autoGenerateSnapshots: resolveAutoGenerate("gemini"),
      sessionRoots: options.geminiSessionRoots,
      now: options.now,
      watchDebounceMs: options.watchDebounceMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      watchFs: options.watchFs,
      operationalLogger: options.operationalLogger,
      auditLogger: options.auditLogger,
    }),
  ];
}
