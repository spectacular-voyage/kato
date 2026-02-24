import type { Message, ProviderCursor } from "@kato/shared";
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
import { parseClaudeMessages } from "../providers/claude/mod.ts";
import { parseCodexMessages } from "../providers/codex/mod.ts";
import type {
  ProviderIngestionPollResult,
  ProviderIngestionRunner,
  SessionSnapshotStore,
} from "./ingestion_runtime.ts";

export interface ProviderSessionFile {
  sessionId: string;
  filePath: string;
  modifiedAtMs: number;
}

export interface FileProviderIngestionRunnerOptions {
  provider: string;
  watchRoots: string[];
  discoverSessions: () => Promise<ProviderSessionFile[]>;
  parseMessages: (
    filePath: string,
    fromOffset: number,
  ) => AsyncIterable<{ message: Message; offset: number }>;
  sessionSnapshotStore: SessionSnapshotStore;
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
  now?: () => Date;
  watchDebounceMs?: number;
  discoveryIntervalMs?: number;
  claudeSessionRoots?: string[];
  codexSessionRoots?: string[];
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
  messagesObserved: number;
}

interface CodexSessionMeta {
  id: string;
  source: string;
}

const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_DEBOUNCE_MS = 250;

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

function makeByteOffsetCursor(offset: number): ProviderCursor {
  return {
    kind: "byte-offset",
    value: Math.max(0, Math.floor(offset)),
  };
}

function readEnvOptional(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    if (!value || value.length === 0) {
      return undefined;
    }
    return value;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      return undefined;
    }
    throw error;
  }
}

function resolveHomeDir(): string | undefined {
  return readEnvOptional("HOME") ?? readEnvOptional("USERPROFILE");
}

function expandHome(path: string): string {
  if (!path.startsWith("~")) {
    return path;
  }

  const home = resolveHomeDir();
  if (!home) {
    return path;
  }

  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return join(home, path.slice(2));
  }

  return path;
}

function normalizeRoots(paths: string[]): string[] {
  const deduped = new Set<string>();
  for (const path of paths) {
    if (!isNonEmptyString(path)) {
      continue;
    }
    deduped.add(expandHome(path.trim()));
  }
  return Array.from(deduped);
}

function parseRootsFromEnv(name: string): string[] | undefined {
  const raw = readEnvOptional(name);
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const roots = normalizeRoots(parsed.filter(isNonEmptyString));
  return roots.length > 0 ? roots : undefined;
}

function resolveClaudeSessionRoots(overrides?: string[]): string[] {
  if (overrides) {
    return normalizeRoots(overrides);
  }

  const envRoots = parseRootsFromEnv("KATO_CLAUDE_SESSION_ROOTS");
  if (envRoots && envRoots.length > 0) {
    return envRoots;
  }

  const home = resolveHomeDir();
  if (!home) {
    return [];
  }

  return normalizeRoots([
    join(home, ".claude", "projects"),
  ]);
}

function resolveCodexSessionRoots(overrides?: string[]): string[] {
  if (overrides) {
    return normalizeRoots(overrides);
  }

  const envRoots = parseRootsFromEnv("KATO_CODEX_SESSION_ROOTS");
  if (envRoots && envRoots.length > 0) {
    return envRoots;
  }

  const home = resolveHomeDir();
  if (!home) {
    return [];
  }

  return normalizeRoots([join(home, ".codex", "sessions")]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return false;
    }
    throw error;
  }
}

async function* walkJsonlFiles(root: string): AsyncGenerator<string> {
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(current);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.PermissionDenied
      ) {
        continue;
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

async function statModifiedAtMs(path: string): Promise<number> {
  const stat = await Deno.stat(path);
  return stat.mtime?.getTime() ?? 0;
}

async function discoverClaudeSessions(
  roots: string[],
): Promise<ProviderSessionFile[]> {
  const sessions: ProviderSessionFile[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) {
      continue;
    }
    for await (const filePath of walkJsonlFiles(root)) {
      const sessionId = basename(filePath, ".jsonl");
      if (!isNonEmptyString(sessionId)) {
        continue;
      }
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
  const file = await Deno.open(filePath, { read: true });
  try {
    const buffer = new Uint8Array(32 * 1024);
    const read = await file.read(buffer);
    if (read === null || read === 0) {
      return undefined;
    }

    const chunk = new TextDecoder().decode(buffer.subarray(0, read));
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.trim().length > 0) {
        return line;
      }
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
  if (!firstLine) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const entry = parsed as {
    type?: unknown;
    payload?: Record<string, unknown>;
  };
  if (entry.type !== "session_meta" || !entry.payload) {
    return undefined;
  }

  const id = entry.payload["id"];
  const source = entry.payload["source"];
  if (!isNonEmptyString(id)) {
    return undefined;
  }

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
    if (!(await pathExists(root))) {
      continue;
    }
    for await (const filePath of walkJsonlFiles(root)) {
      const meta = await readCodexSessionMeta(filePath);
      if (!meta || meta.source === "exec") {
        continue;
      }
      sessions.push({
        sessionId: meta.id,
        filePath,
        modifiedAtMs: await statModifiedAtMs(filePath),
      });
    }
  }

  return sessions;
}

function messageSignature(message: Message): string {
  return [
    message.id,
    message.role,
    message.timestamp,
    message.model ?? "",
    message.content,
  ].join("\u0000");
}

function mergeMessages(
  existingMessages: Message[],
  incomingMessages: Message[],
): { mergedMessages: Message[]; droppedEvents: number } {
  const signatures = new Set(existingMessages.map(messageSignature));
  const mergedMessages = [...existingMessages];
  let droppedEvents = 0;

  for (const message of incomingMessages) {
    const signature = messageSignature(message);
    if (signatures.has(signature)) {
      droppedEvents += 1;
      continue;
    }

    signatures.add(signature);
    mergedMessages.push(message);
  }

  return {
    mergedMessages,
    droppedEvents,
  };
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
  private readonly discoverSessions: () => Promise<ProviderSessionFile[]>;
  private readonly parseMessages: (
    filePath: string,
    fromOffset: number,
  ) => AsyncIterable<{ message: Message; offset: number }>;
  private readonly watchRoots: string[];
  private readonly sessions = new Map<string, ProviderSessionFile>();
  private readonly sessionByFilePath = new Map<string, string>();
  private readonly dirtySessions = new Set<string>();
  private readonly cursors = new Map<string, ProviderCursor>();
  private readonly pendingBatchPaths = new Set<string>();
  private nextDiscoveryAtMs = 0;
  private needsDiscovery = true;
  private started = false;
  private watchAbortController: AbortController | undefined;
  private watchTask: Promise<void> | undefined;

  constructor(options: FileProviderIngestionRunnerOptions) {
    this.provider = options.provider;
    this.watchRoots = normalizeRoots(options.watchRoots);
    this.discoverSessions = options.discoverSessions;
    this.parseMessages = options.parseMessages;
    this.sessionSnapshotStore = options.sessionSnapshotStore;
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
    if (this.started) {
      return;
    }
    this.started = true;
    this.needsDiscovery = true;

    await this.operationalLogger.info(
      "provider.ingestion.started",
      "Provider ingestion runner started",
      {
        provider: this.provider,
        watchRoots: this.watchRoots,
      },
    );
    await this.auditLogger.record(
      "provider.ingestion.started",
      "Provider ingestion runner started",
      {
        provider: this.provider,
        watchRoots: this.watchRoots,
      },
    );

    const existingWatchRoots: string[] = [];
    for (const root of this.watchRoots) {
      if (await pathExists(root)) {
        existingWatchRoots.push(root);
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

    if (
      this.needsDiscovery || this.now().getTime() >= this.nextDiscoveryAtMs
    ) {
      await this.discoverAndTrackSessions();
    }

    for (const path of this.pendingBatchPaths) {
      const sessionId = this.sessionByFilePath.get(path);
      if (sessionId) {
        this.dirtySessions.add(sessionId);
      } else if (path.endsWith(".jsonl")) {
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
    let messagesObserved = 0;

    for (const sessionId of dirtySessions) {
      const result = await this.ingestSession(sessionId);
      if (result.updated) {
        sessionsUpdated += 1;
      }
      messagesObserved += result.messagesObserved;
    }

    return {
      provider: this.provider,
      polledAt: this.now().toISOString(),
      sessionsUpdated,
      messagesObserved,
    };
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
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
      {
        provider: this.provider,
      },
    );
    await this.auditLogger.record(
      "provider.ingestion.stopped",
      "Provider ingestion runner stopped",
      {
        provider: this.provider,
      },
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
      {
        provider: this.provider,
        paths: batch.paths,
        kinds: batch.kinds,
      },
    );
  }

  private async discoverAndTrackSessions(): Promise<void> {
    const discovered = await this.discoverSessions();
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
    let droppedEvents = 0;

    const sorted = [...sessions].sort((a, b) => {
      if (a.sessionId === b.sessionId) {
        return b.modifiedAtMs - a.modifiedAtMs;
      }
      return a.sessionId.localeCompare(b.sessionId);
    });

    for (const session of sorted) {
      if (!bySessionId.has(session.sessionId)) {
        bySessionId.set(session.sessionId, session);
      } else {
        droppedEvents += 1;
      }
    }

    if (droppedEvents > 0) {
      await this.operationalLogger.warn(
        "provider.ingestion.events_dropped",
        "Dropped duplicate session discovery events",
        {
          provider: this.provider,
          droppedEvents,
          reason: "duplicate-session-id",
        },
      );
      await this.auditLogger.record(
        "provider.ingestion.events_dropped",
        "Dropped duplicate session discovery events",
        {
          provider: this.provider,
          droppedEvents,
          reason: "duplicate-session-id",
        },
      );
    }

    return Array.from(bySessionId.values());
  }

  private async ingestSession(sessionId: string): Promise<IngestSessionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { updated: false, messagesObserved: 0 };
    }

    let fromOffset = resolveByteOffset(this.cursors.get(sessionId));
    let fileStat: Deno.FileInfo;
    try {
      fileStat = await Deno.stat(session.filePath);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.PermissionDenied
      ) {
        return { updated: false, messagesObserved: 0 };
      }
      throw error;
    }

    const fileSize = fileStat.size ?? 0;
    if (fromOffset > fileSize) {
      fromOffset = 0;
      this.cursors.set(sessionId, makeByteOffsetCursor(0));
      await this.operationalLogger.warn(
        "provider.ingestion.cursor.reset",
        "Provider ingestion cursor reset after file truncation",
        {
          provider: this.provider,
          sessionId,
          filePath: session.filePath,
        },
      );
    }

    const incomingMessages: Message[] = [];
    let latestOffset = fromOffset;

    try {
      for await (
        const { message, offset } of this.parseMessages(
          session.filePath,
          fromOffset,
        )
      ) {
        incomingMessages.push(message);
        latestOffset = Math.max(latestOffset, offset);
      }
    } catch (error) {
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
      await this.auditLogger.record(
        "provider.ingestion.parse_error",
        "Provider ingestion parse failed",
        {
          provider: this.provider,
          sessionId,
          filePath: session.filePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return { updated: false, messagesObserved: 0 };
    }

    if (incomingMessages.length === 0 && latestOffset === fromOffset) {
      return { updated: false, messagesObserved: 0 };
    }

    const currentSnapshot = this.sessionSnapshotStore.get(sessionId);
    const existingMessages = currentSnapshot?.provider === this.provider
      ? currentSnapshot.messages
      : [];
    const merged = mergeMessages(existingMessages, incomingMessages);

    if (merged.droppedEvents > 0) {
      await this.operationalLogger.warn(
        "provider.ingestion.events_dropped",
        "Provider ingestion dropped duplicate message events",
        {
          provider: this.provider,
          sessionId,
          droppedEvents: merged.droppedEvents,
          reason: "duplicate-message",
        },
      );
      await this.auditLogger.record(
        "provider.ingestion.events_dropped",
        "Provider ingestion dropped duplicate message events",
        {
          provider: this.provider,
          sessionId,
          droppedEvents: merged.droppedEvents,
          reason: "duplicate-message",
        },
      );
    }

    this.sessionSnapshotStore.upsert({
      provider: this.provider,
      sessionId,
      cursor: makeByteOffsetCursor(latestOffset),
      messages: merged.mergedMessages,
    });
    this.cursors.set(sessionId, makeByteOffsetCursor(latestOffset));

    return {
      updated: true,
      messagesObserved: incomingMessages.length,
    };
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
    parseMessages: (filePath, fromOffset) =>
      parseClaudeMessages(filePath, fromOffset),
    sessionSnapshotStore: options.sessionSnapshotStore,
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
    parseMessages: (filePath, fromOffset) =>
      parseCodexMessages(filePath, fromOffset),
    sessionSnapshotStore: options.sessionSnapshotStore,
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
  return [
    createClaudeIngestionRunner({
      sessionSnapshotStore: options.sessionSnapshotStore,
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
      sessionRoots: options.codexSessionRoots,
      now: options.now,
      watchDebounceMs: options.watchDebounceMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      watchFs: options.watchFs,
      operationalLogger: options.operationalLogger,
      auditLogger: options.auditLogger,
    }),
  ];
}
