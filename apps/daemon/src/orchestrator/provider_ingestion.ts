import type {
  ConversationEvent,
  ProviderAutoGenerateSnapshots,
  ProviderCursor,
  SessionIngestAnchorV1,
  SessionMetadataV1,
} from "@kato/shared";
import { extractSnippet } from "@kato/shared";
import { basename, join, relative } from "@std/path";
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
import { hashStringFNV1a } from "../utils/hash.ts";
import { dedupeDiscoveredSessions } from "./provider_session_discovery.ts";
import {
  cursorsEqual,
  makeByteOffsetCursor,
  makeItemIndexCursor,
  type ProviderIngestionCodexCompactionAnchor,
  resolveByteOffsetResume,
  resolveCodexCompactionResume,
  resolveCursorPosition,
  resolveGeminiAnchorResume,
  resolveInitialIngestionCursor,
  resolveNextIngestAnchor,
} from "./provider_ingestion_resume.ts";
import {
  mergeEvents,
  type MergeEventsOptions,
} from "./provider_ingestion_merge.ts";

export interface ProviderSessionFile {
  sessionId: string;
  filePath: string;
  modifiedAtMs: number;
  /**
   * Provider-native "content updated" timestamp when available.
   * Used for deterministic dedupe of duplicate source files.
   */
  contentUpdatedAtMs?: number;
  /**
   * Provider-specific discovery layout hint (for tie-breakers/telemetry).
   */
  layoutType?: "hash" | "slug" | "unknown";
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

interface GeminiSessionDiscovery {
  sessionId: string;
  contentUpdatedAtMs?: number;
  layoutType: "hash" | "slug" | "unknown";
}

const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_DEBOUNCE_MS = 250;
const CODEX_COMPACTION_BACKTRACK_BYTES = 4 * 1024;
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
    if (error instanceof Deno.errors.NotFound) {
      return 0;
    }
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

async function readLatestCodexCompactionAnchor(
  filePath: string,
): Promise<ProviderIngestionCodexCompactionAnchor | undefined> {
  let file: Deno.FsFile | undefined;
  let lineEnd = 0;
  let latest: ProviderIngestionCodexCompactionAnchor | undefined;
  const decoder = new TextDecoder();

  const processLine = (
    lineBytes: Uint8Array,
    hasTrailingNewline: boolean,
  ): void => {
    const line = decoder.decode(lineBytes);
    lineEnd += lineBytes.length + (hasTrailingNewline ? 1 : 0);
    if (!line.includes('"type":"compacted"')) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecordValue(parsed) || parsed["type"] !== "compacted") {
      return;
    }
    latest = {
      lineEnd,
      anchor: {
        messageId: `codex-compacted:${lineEnd}`,
        payloadHash: hashStringFNV1a(line),
      },
    };
  };

  try {
    file = await Deno.open(filePath, { read: true });
    const reader = file.readable.getReader();
    let pending = new Uint8Array(0);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.length === 0) {
          continue;
        }
        const chunk = pending.length === 0 ? value : (() => {
          const combined = new Uint8Array(pending.length + value.length);
          combined.set(pending);
          combined.set(value, pending.length);
          return combined;
        })();
        let lineStart = 0;
        for (let i = 0; i < chunk.length; i += 1) {
          if (chunk[i] !== 0x0a) {
            continue;
          }
          processLine(chunk.subarray(lineStart, i), true);
          lineStart = i + 1;
        }
        pending = lineStart === 0 ? chunk : chunk.subarray(lineStart);
        if (pending.length > 0 && pending.buffer === chunk.buffer) {
          pending = pending.slice();
        }
      }
      if (pending.length > 0) {
        processLine(pending, false);
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("open", filePath, error);
    }
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  } finally {
    if (file) {
      try {
        file.close();
      } catch {
        // file.readable may already close the file once the stream drains
      }
    }
  }

  return latest;
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

function readTimeMs(value: unknown): number | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? undefined : parsed;
}

function classifyGeminiLayout(
  filePath: string,
  discoveryRoot: string,
): "hash" | "slug" | "unknown" {
  const relativePath = relative(discoveryRoot, filePath).trim();
  if (
    relativePath.length === 0 || relativePath === "." ||
    relativePath.startsWith("..")
  ) {
    return "unknown";
  }
  const firstSegment = relativePath.split(/[\\/]/)[0]?.trim();
  if (!firstSegment || firstSegment === "chats") {
    return "unknown";
  }
  if (/^[a-f0-9]{64}$/i.test(firstSegment)) {
    return "hash";
  }
  return "slug";
}

async function readGeminiSessionDiscovery(
  filePath: string,
  discoveryRoot: string,
): Promise<GeminiSessionDiscovery | undefined> {
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
  const contentUpdatedAtMs = readTimeMs(root["lastUpdated"]) ??
    readTimeMs(root["updatedAt"]);
  const layoutType = classifyGeminiLayout(filePath, discoveryRoot);
  if (isNonEmptyString(sessionId)) {
    return {
      sessionId: sessionId.trim(),
      ...(contentUpdatedAtMs !== undefined ? { contentUpdatedAtMs } : {}),
      layoutType,
    };
  }
  const fromName = basename(filePath, ".json").trim();
  if (fromName.length === 0) {
    return undefined;
  }
  return {
    sessionId: fromName,
    ...(contentUpdatedAtMs !== undefined ? { contentUpdatedAtMs } : {}),
    layoutType,
  };
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
      const discovery = await readGeminiSessionDiscovery(filePath, root);
      if (!discovery) continue;
      sessions.push({
        sessionId: discovery.sessionId,
        filePath,
        modifiedAtMs: await statModifiedAtMs(filePath),
        ...(discovery.contentUpdatedAtMs !== undefined
          ? { contentUpdatedAtMs: discovery.contentUpdatedAtMs }
          : {}),
        layoutType: discovery.layoutType,
      });
    }
  }
  return sessions;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    return undefined;
  }
  return messages.filter((item): item is Record<string, unknown> =>
    isRecordValue(item)
  );
}

function hasActiveRecordings(stateMetadata: SessionMetadataV1): boolean {
  return (stateMetadata.workspaceOutputs ?? []).some((output) =>
    output.desiredState === "on"
  );
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
  private readonly cursorSourcePaths = new Map<string, string>();
  private readonly pendingBatchPaths = new Set<string>();
  private nextDiscoveryAtMs = 0;
  private needsDiscovery = true;
  private started = false;
  private startedAtMs = 0;
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
    this.startedAtMs = this.now().getTime();
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

    await this.operationalLogger.error(
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
      const isNewSession = !current;
      const filePathChanged = current
        ? current.filePath !== session.filePath
        : false;
      const modifiedAtChanged = current
        ? current.modifiedAtMs !== session.modifiedAtMs
        : false;
      if (isNewSession || filePathChanged || modifiedAtChanged) {
        this.sessions.set(session.sessionId, session);
        this.sessionByFilePath.set(session.filePath, session.sessionId);
        if (current && current.filePath !== session.filePath) {
          this.sessionByFilePath.delete(current.filePath);
          this.cursors.delete(session.sessionId);
          this.cursorSourcePaths.delete(session.sessionId);
        }
        if (
          filePathChanged ||
          modifiedAtChanged ||
          this.shouldProactivelyIngestDiscoveredSession(session)
        ) {
          this.dirtySessions.add(session.sessionId);
        }
      }
    }

    for (const [sessionId, existing] of this.sessions) {
      if (!activeSessionIds.has(sessionId)) {
        this.sessions.delete(sessionId);
        this.sessionByFilePath.delete(existing.filePath);
        this.cursors.delete(sessionId);
        this.cursorSourcePaths.delete(sessionId);
      }
    }

    this.needsDiscovery = false;
    this.nextDiscoveryAtMs = this.now().getTime() + this.discoveryIntervalMs;
  }

  private shouldProactivelyIngestDiscoveredSession(
    session: ProviderSessionFile,
  ): boolean {
    if (session.modifiedAtMs >= this.startedAtMs) {
      return true;
    }
    if (
      this.provider === "gemini" &&
      session.contentUpdatedAtMs !== undefined &&
      session.contentUpdatedAtMs >= this.startedAtMs
    ) {
      return true;
    }
    return false;
  }

  private async dedupeDiscoveredSessions(
    sessions: ProviderSessionFile[],
  ): Promise<ProviderSessionFile[]> {
    const deduped = dedupeDiscoveredSessions(sessions);

    if (deduped.droppedEvents > 0) {
      const warningKey = `${deduped.droppedEvents}:${
        deduped.duplicateSessionIds.join(",")
      }`;
      if (this.lastDuplicateDiscoveryWarningKey === warningKey) {
        return deduped.sessions;
      }
      this.lastDuplicateDiscoveryWarningKey = warningKey;
      await this.operationalLogger.debug(
        "provider.ingestion.events_dropped",
        "Dropped duplicate session discovery events",
        {
          provider: this.provider,
          droppedEvents: deduped.droppedEvents,
          reason: "duplicate-session-id",
          duplicateSessionIds: deduped.duplicateSessionIds,
        },
      );
    } else {
      this.lastDuplicateDiscoveryWarningKey = undefined;
    }

    return deduped.sessions;
  }

  private setCursor(
    sessionId: string,
    cursor: ProviderCursor,
    sourceFilePath: string,
  ): void {
    this.cursors.set(sessionId, cursor);
    this.cursorSourcePaths.set(sessionId, sourceFilePath);
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
            // Always initialize new metadata from the start of the source.
            // This keeps snippet/history anchored to the first user message in
            // the provider session instead of a late in-memory cursor.
            initialCursor: makeDefaultSessionCursor(this.provider),
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

    const memoryCursor = this.cursors.get(sessionId);
    let { existingCursor, fromOffset, resumeSource, clearStoredCursor } =
      resolveInitialIngestionCursor({
        persistedCursor: stateMetadata?.ingestCursor,
        persistedSourceFilePath: stateMetadata?.sourceFilePath,
        memoryCursor,
        memoryCursorSourcePath: this.cursorSourcePaths.get(sessionId),
        sessionFilePath: session.filePath,
      });
    if (clearStoredCursor) {
      this.cursors.delete(sessionId);
      this.cursorSourcePaths.delete(sessionId);
    }
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

    const truncatedResume = resolveByteOffsetResume({
      existingCursor,
      fromOffset,
      fileSize: fileStat.size ?? 0,
    });
    existingCursor = truncatedResume.existingCursor;
    fromOffset = truncatedResume.fromOffset;
    if (truncatedResume.truncated) {
      const resetCursor = existingCursor!;
      this.setCursor(sessionId, resetCursor, session.filePath);
      if (stateMetadata) {
        stateMetadata.ingestCursor = resetCursor;
      }
      await this.operationalLogger.warn(
        "provider.ingestion.cursor.reset",
        "Provider ingestion cursor reset after file truncation",
        { provider: this.provider, sessionId, filePath: session.filePath },
      );
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
    let codexCompactionBacktrack = false;
    let codexCompactionMergeOptions: MergeEventsOptions | undefined;
    let codexCompactionAnchor: SessionIngestAnchorV1 | undefined;
    if (
      this.provider === "codex" &&
      stateMetadata &&
      existingCursor?.kind === "byte-offset" &&
      fromOffset > 0
    ) {
      let latestCompactionAnchor:
        | ProviderIngestionCodexCompactionAnchor
        | undefined;
      try {
        latestCompactionAnchor = await readLatestCodexCompactionAnchor(
          session.filePath,
        );
      } catch (error) {
        if (await this.handleReadDenied(error, "open", session.filePath)) {
          return { updated: false, eventsObserved: 0 };
        }
        throw error;
      }
      const compactionResume = resolveCodexCompactionResume({
        existingCursor,
        fromOffset,
        persistedAnchor: stateMetadata.ingestAnchor,
        latestCompactionAnchor,
        backtrackBytes: CODEX_COMPACTION_BACKTRACK_BYTES,
      });
      codexCompactionAnchor = compactionResume.compactionAnchor;
      existingCursor = compactionResume.existingCursor;
      fromOffset = compactionResume.fromOffset;
      if (compactionResume.backtracked) {
        const backtrackedCursor = existingCursor!;
        stateMetadata.ingestCursor = backtrackedCursor;
        this.setCursor(sessionId, backtrackedCursor, session.filePath);
        codexCompactionBacktrack = true;
        codexCompactionMergeOptions = {
          ignoreTimestamp: true,
          ignoreCursor: true,
        };
        await this.operationalLogger.warn(
          "provider.ingestion.codex.compaction_backtrack",
          "Codex compaction marker detected before cursor; backing up cursor with dedupe",
          {
            provider: this.provider,
            sessionId,
            filePath: session.filePath,
            previousCursor: compactionResume.previousOffset,
            compactionCursor: latestCompactionAnchor?.lineEnd,
            backtrackedCursor: compactionResume.backtrackedOffset,
          },
        );
      }
    }

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
        const anchorResume = resolveGeminiAnchorResume({
          existingCursor,
          fromOffset,
          persistedAnchor: stateMetadata.ingestAnchor,
          messages,
        });
        existingCursor = anchorResume.existingCursor;
        fromOffset = anchorResume.fromOffset;
        if (anchorResume.replayedFromStart) {
          const replayCursor = existingCursor!;
          stateMetadata.ingestCursor = replayCursor;
          this.setCursor(sessionId, replayCursor, session.filePath);
          replayedFromStart = true;
          await this.operationalLogger.warn(
            "provider.ingestion.anchor.not_found",
            "Gemini anchor missing; replaying session from start with dedupe",
            {
              provider: this.provider,
              sessionId,
              filePath: session.filePath,
              previousCursor: anchorResume.previousOffset,
              anchor: stateMetadata.ingestAnchor,
            },
          );
        } else if (anchorResume.realigned) {
          const realignedCursor = existingCursor!;
          stateMetadata.ingestCursor = realignedCursor;
          this.setCursor(sessionId, realignedCursor, session.filePath);
          await this.operationalLogger.warn(
            "provider.ingestion.anchor.realigned",
            "Gemini anchor mismatch resolved by re-aligning cursor",
            {
              provider: this.provider,
              sessionId,
              filePath: session.filePath,
              previousCursor: anchorResume.previousOffset,
              realignedCursor: anchorResume.realignedOffset,
              anchor: stateMetadata.ingestAnchor,
            },
          );
        }
      }
    }

    if (stateMetadata && this.sessionStateStore) {
      // Persist session twin history unconditionally when session state is
      // enabled so missing twins are always rebuilt from source and stay
      // capture-complete for command-time replay.
      const shouldAppendTwin = true;
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

          // Twin rebuild should be a fresh replay from source.
          // Persist reset state before append so dedupe does not suppress
          // historical events based on stale fingerprint history.
          stateMetadata.nextTwinSeq = 1;
          stateMetadata.recentFingerprints = [];
          await this.sessionStateStore.saveSessionMetadata(stateMetadata);

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
              // Codex backfill cannot infer reliable event time from source.
              // Leave capturedAt unset so it surfaces as unknown downstream.
              ...(this.provider === "codex"
                ? {}
                : { capturedAt: this.now().toISOString() }),
            });
            const appendResult = await this.sessionStateStore.appendTwinEvents(
              stateMetadata,
              twinDrafts,
              { touchUpdatedAt: false },
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

          // appendTwinEvents persists authoritative sequence/fingerprint state;
          // reload metadata so cursor/mtime saves below do not clobber it.
          stateMetadata = await this.sessionStateStore
            .getOrCreateSessionMetadata(
              {
                provider: this.provider,
                providerSessionId: sessionId,
                sourceFilePath: session.filePath,
                initialCursor: stateMetadata.ingestCursor,
              },
            );

          fromOffset = resolveCursorPosition(bootstrapCursor);
          existingCursor = bootstrapCursor;
          stateMetadata.ingestCursor = bootstrapCursor;
          stateMetadata.lastObservedMtimeMs = fileStat.mtime?.getTime();
          stateMetadata.sourceFilePath = session.filePath;
          await this.sessionStateStore.saveSessionMetadata(stateMetadata);
          this.setCursor(sessionId, bootstrapCursor, session.filePath);
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
    let snippetOverride = stateMetadata?.snippet;
    if (
      !snippetOverride && isNonEmptyString(currentSnapshot?.metadata.snippet)
    ) {
      snippetOverride = currentSnapshot.metadata.snippet;
    }
    if (!snippetOverride && fromOffset === 0) {
      snippetOverride = extractSnippet(incomingEvents);
    }
    let snippetChanged = Boolean(
      stateMetadata &&
        snippetOverride &&
        stateMetadata.snippet !== snippetOverride,
    );
    if (snippetChanged && stateMetadata) {
      stateMetadata.snippet = snippetOverride;
    }

    if (stateMetadata && this.sessionStateStore) {
      const legacyTwinHydrationEnabled = this.autoGenerateSnapshots ||
        hasActiveRecordings(stateMetadata);
      // Persist session twin history unconditionally when session state is
      // enabled so command-time capture can resolve from twin start.
      const shouldAppendTwin = true;
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
          { touchUpdatedAt: true },
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
                : codexCompactionBacktrack
                ? "duplicate-session-twin-codex-compaction-backtrack"
                : "duplicate-session-twin",
              replayedFromStart,
              codexCompactionBacktrack,
            },
          );
        }
      }

      if (shouldAppendTwin && incomingEvents.length > 0) {
        // appendTwinEvents updates metadata (nextTwinSeq/recentFingerprints);
        // reload before saving ingestion cursor fields.
        stateMetadata = await this.sessionStateStore.getOrCreateSessionMetadata(
          {
            provider: this.provider,
            providerSessionId: sessionId,
            sourceFilePath: session.filePath,
            initialCursor: latestCursor,
          },
        );
        if (
          snippetOverride &&
          stateMetadata.snippet !== snippetOverride
        ) {
          stateMetadata.snippet = snippetOverride;
          snippetChanged = true;
        }
      }

      let anchorChanged = false;
      let nextAnchor: SessionIngestAnchorV1 | undefined = stateMetadata
        .ingestAnchor;
      try {
        const anchorResolution = resolveNextIngestAnchor({
          provider: this.provider,
          previousAnchor: stateMetadata.ingestAnchor,
          latestCursor,
          geminiMessages: this.provider === "gemini"
            ? await loadGeminiMessagesForAnchor(true)
            : undefined,
          codexCompactionAnchor,
        });
        nextAnchor = anchorResolution.nextAnchor;
        anchorChanged = anchorResolution.anchorChanged;
      } catch (error) {
        if (
          !(await this.handleReadDenied(error, "open", session.filePath))
        ) {
          throw error;
        }
      }
      if (anchorChanged) {
        stateMetadata.ingestAnchor = nextAnchor;
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
        cursorChanged ||
        fileMtimeChanged ||
        sourceFileChanged ||
        anchorChanged ||
        snippetChanged
      ) {
        stateMetadata.ingestCursor = latestCursor;
        stateMetadata.lastObservedMtimeMs = fileModifiedAtMs;
        stateMetadata.sourceFilePath = session.filePath;
        await this.sessionStateStore.saveSessionMetadata(stateMetadata);
      }

      const snapshotSnippetMismatch = snippetOverride !== undefined &&
        currentSnapshot?.metadata.snippet !== snippetOverride;
      const shouldHydrateSnapshot = appendedTwinCount > 0 ||
        !currentSnapshot ||
        cursorChanged ||
        fileMtimeChanged ||
        sourceFileChanged ||
        anchorChanged ||
        snapshotSnippetMismatch;
      const shouldHydrateFromTwin = legacyTwinHydrationEnabled ||
        !currentSnapshot;

      if (shouldHydrateSnapshot) {
        if (shouldHydrateFromTwin) {
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
              ...(snippetOverride ? { snippetOverride } : {}),
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
              ...(snippetOverride ? { snippetOverride } : {}),
            });
          } else {
            this.sessionSnapshotStore.upsert({
              provider: this.provider,
              sessionId,
              cursor: latestCursor,
              events: existingSnapshotEvents,
              fileModifiedAtMs,
              ...(snippetOverride ? { snippetOverride } : {}),
            });
          }
        } else if (incomingEvents.length > 0 || currentSnapshot) {
          const merged = mergeEvents(
            currentSnapshot?.provider === this.provider
              ? currentSnapshot.events
              : [],
            incomingEvents,
            codexCompactionMergeOptions,
          );
          const mergedEvents = merged.mergedEvents;
          const droppedEvents = merged.droppedEvents;
          if (droppedEvents > 0) {
            await this.operationalLogger.debug(
              "provider.ingestion.events_dropped",
              "Provider ingestion dropped duplicate events",
              {
                provider: this.provider,
                sessionId,
                droppedEvents,
                reason: codexCompactionBacktrack
                  ? "duplicate-codex-compaction-backtrack"
                  : "duplicate-event",
              },
            );
          }
          this.sessionSnapshotStore.upsert({
            provider: this.provider,
            sessionId,
            cursor: latestCursor,
            events: mergedEvents,
            fileModifiedAtMs,
            ...(snippetOverride ? { snippetOverride } : {}),
          });
        }
      }

      this.setCursor(sessionId, latestCursor, session.filePath);
      return {
        updated: shouldHydrateSnapshot || latestOffset !== fromOffset,
        eventsObserved: incomingEvents.length,
      };
    }

    if (incomingEvents.length === 0 && latestOffset === fromOffset) {
      return { updated: false, eventsObserved: 0 };
    }

    const merged = mergeEvents(
      currentSnapshot?.provider === this.provider ? currentSnapshot.events : [],
      incomingEvents,
      codexCompactionMergeOptions,
    );
    const mergedEvents = merged.mergedEvents;
    const droppedEvents = merged.droppedEvents;

    if (droppedEvents > 0) {
      await this.operationalLogger.debug(
        "provider.ingestion.events_dropped",
        "Provider ingestion dropped duplicate events",
        {
          provider: this.provider,
          sessionId,
          droppedEvents,
          reason: codexCompactionBacktrack
            ? "duplicate-codex-compaction-backtrack"
            : "duplicate-event",
        },
      );
    }

    this.sessionSnapshotStore.upsert({
      provider: this.provider,
      sessionId,
      cursor: latestCursor,
      events: mergedEvents,
      fileModifiedAtMs,
      ...(snippetOverride ? { snippetOverride } : {}),
    });
    this.setCursor(sessionId, latestCursor, session.filePath);

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
