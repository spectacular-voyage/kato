import type {
  ConversationEvent,
  DaemonIngestionFailureStatus,
  DaemonWatchDegradedStatus,
  ProviderAutoGenerateTwins,
  ProviderCursor,
  ProviderSessionTitleSource,
  SecretsPolicyConfig,
  SessionIngestAnchorV1,
  SessionMetadataV1,
} from "@kato/shared";
import {
  DEFAULT_GLOBAL_AUTO_GENERATE_TWINS,
  extractSnippet,
} from "@kato/shared";
import {
  createSecretsRedactor,
  redactConversationEvents,
  type SecretsRedactor,
} from "../policy/mod.ts";
import { basename, join, normalize, relative } from "@std/path";
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
import {
  parseClaudeEvents,
  resolveClaudeSessionParseOptions,
} from "../providers/claude/mod.ts";
import {
  type CodexSessionMeta,
  parseCodexEvents,
  readCodexSessionMeta,
} from "../providers/codex/mod.ts";
import { parseGeminiEvents } from "../providers/gemini/mod.ts";
import type {
  ProviderParseCheckpoint,
  ProviderParseResumeOptions,
} from "../providers/parse_checkpoint.ts";
import {
  type JsonlCheckpoint,
  openJsonlLineReader,
} from "../utils/jsonl_line_reader.ts";
import type {
  ProviderIngestionPollResult,
  ProviderIngestionRunner,
  SessionSnapshotStore,
} from "./ingestion_runtime.ts";
import { shouldReplaceProviderTitle } from "./ingestion_runtime.ts";
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
import {
  compareDiscoveredSessionCandidates,
  dedupeDiscoveredSessions,
} from "./provider_session_discovery.ts";
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

/** Provider-maintained session title observed while parsing source lines. */
export interface ProviderIngestionTitleUpdate {
  title: string;
  source: ProviderSessionTitleSource;
}

export interface ProviderSessionFile {
  sessionId: string;
  parentProviderSessionId?: string;
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

/** Context passed to provider parsers; Gemini ignores the resume options. */
export type ProviderParseContext =
  & { provider: string; sessionId: string }
  & ProviderParseResumeOptions;

/**
 * Timing for watcher-led discovery. Every field has a default; tests shorten
 * them. See task.2026.2026-11-10-watcher-led-discovery.
 */
export interface DiscoveryTimingOptions {
  /** Walk interval for roots the watcher does not cover (default 5 s). */
  degradedDiscoveryIntervalMs?: number;
  /** How often recently changed sessions are stat-checked (default 5 s). */
  hotPollIntervalMs?: number;
  /** A session changed within this window is stat-checked (default 10 min). */
  hotWindowMs?: number;
  /** A change younger than this may still have its event in flight (3 s). */
  watchMissGraceMs?: number;
  /** Unreported changes within the window that degrade a root (default 3). */
  watchMissThreshold?: number;
  watchMissWindowMs?: number;
  /** Delays before restarting a failed watcher; the last one repeats. */
  watchRestartDelaysMs?: number[];
}

export interface FileProviderIngestionRunnerOptions {
  provider: string;
  watchRoots: string[];
  /**
   * Walks `roots` (all of `watchRoots`, or some of them) and returns every
   * session file found under them. Fakes may ignore the argument.
   */
  discoverSessions: (roots: string[]) => Promise<ProviderSessionFile[]>;
  /**
   * Describes one file the watcher reported, given the root it is under;
   * `undefined` when it is not a trackable session. Without it, a reported
   * path Kato does not track makes its root be walked instead.
   */
  describeSessionFile?: (
    filePath: string,
    root: string,
  ) => Promise<ProviderSessionFile | undefined>;
  /** Whether a path's name can be a session file (default: any path). */
  isSessionFilePath?: (filePath: string) => boolean;
  discoveryTiming?: DiscoveryTimingOptions;
  parseEvents: (
    filePath: string,
    fromOffset: number,
    ctx: ProviderParseContext,
  ) => AsyncIterable<{
    event?: ConversationEvent;
    titleUpdate?: ProviderIngestionTitleUpdate;
    cursor: ProviderCursor;
  }>;
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore?: PersistentSessionStateStore;
  autoGenerateTwins?: boolean;
  /** Walk interval for roots the watcher covers (default 5 minutes). */
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
  /** Defaults to fail-closed `redact` mode when omitted. */
  secretsPolicy?: SecretsPolicyConfig;
}

export interface ProviderIngestionFactoryOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore?: PersistentSessionStateStore;
  globalAutoGenerateTwins?: boolean;
  providerAutoGenerateTwins?: ProviderAutoGenerateTwins;
  now?: () => Date;
  watchDebounceMs?: number;
  discoveryIntervalMs?: number;
  discoveryTiming?: DiscoveryTimingOptions;
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
  /** Defaults to fail-closed `redact` mode when omitted. */
  secretsPolicy?: SecretsPolicyConfig;
}

export interface CreateProviderIngestionRunnerOptions {
  sessionSnapshotStore: SessionSnapshotStore;
  sessionStateStore?: PersistentSessionStateStore;
  autoGenerateTwins?: boolean;
  sessionRoots?: string[];
  now?: () => Date;
  watchDebounceMs?: number;
  discoveryIntervalMs?: number;
  discoveryTiming?: DiscoveryTimingOptions;
  watchFs?: (
    watchPaths: string[],
    onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void,
    options: WatchDebounceOptions,
  ) => Promise<void>;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
  /** Defaults to fail-closed `redact` mode when omitted. */
  secretsPolicy?: SecretsPolicyConfig;
}

interface IngestSessionResult {
  updated: boolean;
  eventsObserved: number;
}

interface GeminiSessionDiscovery {
  sessionId: string;
  contentUpdatedAtMs?: number;
  layoutType: "hash" | "slug" | "unknown";
}

const DEFAULT_DISCOVERY_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DEGRADED_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_HOT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HOT_WINDOW_MS = 10 * 60_000;
const DEFAULT_WATCH_MISS_GRACE_MS = 3_000;
const DEFAULT_WATCH_MISS_THRESHOLD = 3;
const DEFAULT_WATCH_MISS_WINDOW_MS = 10 * 60_000;
const DEFAULT_WATCH_RESTART_DELAYS_MS = [5_000, 30_000, 5 * 60_000];
const DEFAULT_WATCH_DEBOUNCE_MS = 250;
/** Upper bound on events scanned from the source head for a stable snippet. */
const HEAD_SNIPPET_MAX_EVENTS = 200;
const CODEX_COMPACTION_BACKTRACK_BYTES = 4 * 1024;
const PARSE_FAILURE_INITIAL_BACKOFF_MS = 30_000;
const PARSE_FAILURE_MAX_BACKOFF_MS = 15 * 60_000;

/** Discovery schedule and watcher trust for one session root. */
interface RootDiscoveryState {
  /** The root as configured; passed to walks and the watcher. */
  root: string;
  /** `toPathKey(root)`, or `""` for a runner with no roots. */
  key: string;
  nextWalkAtMs: number;
  walkRequested: boolean;
  /** Start of the last completed walk; unset before the first. */
  lastWalkAtMs?: number;
  /** Times of recent unreported changes, oldest first. */
  missTimesMs: number[];
  missedChanges: number;
  /** Set once unreported changes reach the threshold; never cleared. */
  degradedAtMs?: number;
}

/**
 * Maps watcher paths under a root's real path back to the configured root,
 * for watchers that report resolved paths (macOS FSEvents: /private/var).
 */
interface WatchPathAlias {
  fromKey: string;
  fromPrefix: string;
  toPrefix: string;
}

function trimTrailingSeparators(path: string): string {
  let trimmed = path;
  while (
    trimmed.length > 1 && /[\\/]$/.test(trimmed) &&
    !/^[A-Za-z]:[\\/]$/.test(trimmed)
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

async function resolveWatchPathAliases(
  roots: string[],
): Promise<WatchPathAlias[]> {
  const aliases: WatchPathAlias[] = [];
  for (const root of roots) {
    let real: string;
    try {
      real = await Deno.realPath(root);
    } catch {
      continue;
    }
    const fromKey = toPathKey(real);
    if (fromKey === toPathKey(root)) continue;
    aliases.push({
      fromKey,
      fromPrefix: trimTrailingSeparators(normalize(real)),
      toPrefix: trimTrailingSeparators(normalize(root)),
    });
  }
  return aliases;
}

/** A remedy to log with a watcher failure, when the cause is recognizable. */
function describeWatchFailureHint(message: string): string | undefined {
  if (/os error 28\b|no space left on device/i.test(message)) {
    return "The inotify watch limit was reached; raise fs.inotify.max_user_watches with sysctl";
  }
  if (/os error 24\b|too many open files/i.test(message)) {
    return "Too many open files or inotify instances; raise fs.inotify.max_user_instances or the open-file limit";
  }
  return undefined;
}

/** Latest parse checkpoint for a session, kept in memory only. */
interface SessionParseCheckpoint {
  filePath: string;
  /** Persisted cursor value produced by the parse that made the checkpoint. */
  cursorAtCheckpoint: number;
  checkpoint: ProviderParseCheckpoint;
}

/** Incremental Codex compaction-marker scan state for one session. */
interface CodexCompactionScanState {
  filePath: string;
  /** End of the last newline-terminated line scanned, with its guard. */
  checkpoint: JsonlCheckpoint;
  /** Latest compaction marker on a terminated line at or before checkpoint. */
  latestTerminated?: ProviderIngestionCodexCompactionAnchor;
}

interface IngestionFailureState {
  error: string;
  firstFailedAtMs: number;
  lastFailedAtMs: number;
  consecutiveFailures: number;
  nextRetryAtMs: number;
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}
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

function resolveEventWorkingDirectory(
  event: ConversationEvent,
): string | undefined {
  const value = event.source.workingDirectory;
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  return value.trim();
}

function inferSessionWorkingDirectory(
  provider: string,
  events: ConversationEvent[],
  current?: string,
): string | undefined {
  if (provider !== "claude") {
    return current;
  }
  for (const event of events) {
    const workingDirectory = resolveEventWorkingDirectory(event);
    if (workingDirectory) {
      return workingDirectory;
    }
  }
  return current;
}

function normalizeRoots(paths: string[]): string[] {
  const deduped = new Set<string>();
  for (const path of paths) {
    if (!isNonEmptyString(path)) continue;
    deduped.add(expandHomePath(path.trim()));
  }
  return Array.from(deduped);
}

/** Windows paths compare case-insensitively; others exactly. */
const PATH_KEYS_FOLD_CASE = Deno.build.os === "windows";

/** A path normalized for prefix comparison (no trailing separator). */
function toPathKey(path: string): string {
  const key = trimTrailingSeparators(normalize(path));
  return PATH_KEYS_FOLD_CASE ? key.toLowerCase() : key;
}

/** Whether `pathKey` is `rootKey` or beneath it; `""` contains everything. */
function isPathKeyWithin(pathKey: string, rootKey: string): boolean {
  if (rootKey === "" || pathKey === rootKey) return true;
  if (!pathKey.startsWith(rootKey)) return false;
  if (/[\\/]$/.test(rootKey)) return true;
  const next = pathKey.charAt(rootKey.length);
  return next === "/" || next === "\\";
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

/**
 * Yields every regular file under `root` whose name matches. Symlinks are
 * skipped, so a walk and `describe*SessionFile` agree on what is a file.
 */
async function* walkMatchingFiles(
  root: string,
  matchesName: (name: string) => boolean,
): AsyncGenerator<string> {
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
    try {
      for await (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile && matchesName(entry.name)) {
          yield fullPath;
        }
      }
    } catch (error) {
      // A directory removed mid-walk; the rest of the walk still counts.
      if (error instanceof Deno.errors.NotFound) continue;
      if (error instanceof Deno.errors.PermissionDenied) {
        throw new ProviderIngestionReadDeniedError("readDir", current, error);
      }
      throw error;
    }
  }
}

function isJsonlName(name: string): boolean {
  return name.endsWith(".jsonl");
}

function isGeminiSessionName(name: string): boolean {
  return name.startsWith("session-") && name.endsWith(".json");
}

/** Whether a path's name can be a Claude or Codex session transcript. */
export function isJsonlSessionPath(path: string): boolean {
  return isJsonlName(basename(path));
}

/** Whether a path's name can be a Gemini session file. */
export function isGeminiSessionPath(path: string): boolean {
  return isGeminiSessionName(basename(path));
}

/**
 * `lstat` that maps a vanished path to `undefined`. `lstat` (not `stat`)
 * matches the walk, which skips symlinks.
 */
async function lstatSessionFile(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) {
      return undefined;
    }
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("stat", path, error);
    }
    throw error;
  }
}

/** Describes one Claude transcript, or `undefined` if it is not one. */
export async function describeClaudeSessionFile(
  filePath: string,
): Promise<ProviderSessionFile | undefined> {
  if (!isJsonlSessionPath(filePath)) return undefined;
  const sessionId = basename(filePath, ".jsonl");
  if (!isNonEmptyString(sessionId)) return undefined;
  const info = await lstatSessionFile(filePath);
  if (!info?.isFile) return undefined;
  return { sessionId, filePath, modifiedAtMs: info.mtime?.getTime() ?? 0 };
}

export async function discoverClaudeSessions(
  roots: string[],
): Promise<ProviderSessionFile[]> {
  const sessions: ProviderSessionFile[] = [];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for await (const filePath of walkMatchingFiles(root, isJsonlName)) {
      const session = await describeClaudeSessionFile(filePath);
      if (session) sessions.push(session);
    }
  }
  return sessions;
}

function parseCompactionLine(
  text: string,
  lineEnd: number,
): ProviderIngestionCodexCompactionAnchor | undefined {
  if (!text.includes('"type":"compacted"')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecordValue(parsed) || parsed["type"] !== "compacted") {
    return undefined;
  }
  return {
    lineEnd,
    anchor: {
      messageId: `codex-compacted:${lineEnd}`,
      payloadHash: hashStringFNV1a(text),
    },
  };
}

/**
 * Finds the latest Codex `compacted` marker, scanning only bytes appended
 * since `previous` when its guard still matches (otherwise from the start).
 * Returns the anchor (including an unterminated final line, as the full scan
 * always did) and the next scan state (terminated lines only).
 */
async function scanCodexCompactionAnchor(
  filePath: string,
  previous: CodexCompactionScanState | undefined,
): Promise<{
  latest: ProviderIngestionCodexCompactionAnchor | undefined;
  state: CodexCompactionScanState | undefined;
}> {
  try {
    let opened = previous && previous.filePath === filePath
      ? await openJsonlLineReader(filePath, {
        startOffset: previous.checkpoint.offset,
        expectedGuard: previous.checkpoint.guard,
      })
      : undefined;
    let latestTerminated = opened && !opened.guardMismatch
      ? previous?.latestTerminated
      : undefined;
    if (!opened || opened.guardMismatch) {
      opened = await openJsonlLineReader(filePath);
      latestTerminated = undefined;
    }
    if (opened.guardMismatch) {
      throw new Error("unreachable: guard mismatch without expected guard");
    }
    const reader = opened.reader;
    let latest = latestTerminated;
    try {
      for await (const line of reader.lines()) {
        const anchor = parseCompactionLine(line.text, line.end);
        if (!anchor) continue;
        latest = anchor;
        if (line.terminated) {
          latestTerminated = anchor;
        }
      }
    } finally {
      reader.close();
    }
    const checkpoint = reader.checkpoint();
    return {
      latest,
      state: checkpoint
        ? { filePath, checkpoint, latestTerminated }
        : undefined,
    };
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ProviderIngestionReadDeniedError("open", filePath, error);
    }
    if (error instanceof Deno.errors.NotFound) {
      return { latest: undefined, state: undefined };
    }
    throw error;
  }
}

interface CodexSessionMetaCacheEntry {
  ino: number | null;
  size: number;
  meta: CodexSessionMeta;
}

/**
 * Per-runner memo of each rollout's first-line `session_meta`, keyed by path.
 * Rollouts are append-only, so the first line is stable while the file keeps
 * its inode and never shrinks; replaced or truncated files are re-read.
 */
export type CodexSessionMetaCache = Map<string, CodexSessionMetaCacheEntry>;

/**
 * Describes one Codex rollout, or `undefined` if it is not a trackable
 * session (not a rollout, `exec` source, or no complete first line yet).
 */
export async function describeCodexSessionFile(
  filePath: string,
  metaCache?: CodexSessionMetaCache,
): Promise<ProviderSessionFile | undefined> {
  if (!isJsonlSessionPath(filePath)) return undefined;
  const info = await lstatSessionFile(filePath);
  if (!info?.isFile) {
    metaCache?.delete(filePath);
    return undefined;
  }
  const cached = metaCache?.get(filePath);
  let meta: CodexSessionMeta | undefined;
  if (cached && cached.ino === info.ino && info.size >= cached.size) {
    cached.size = info.size;
    meta = cached.meta;
  } else {
    try {
      meta = await readCodexSessionMeta(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        metaCache?.delete(filePath);
        return undefined;
      }
      if (error instanceof Deno.errors.PermissionDenied) {
        throw new ProviderIngestionReadDeniedError("open", filePath, error);
      }
      throw error;
    }
    if (meta) {
      metaCache?.set(filePath, { ino: info.ino, size: info.size, meta });
    } else {
      // No complete first line yet: retry on the next look at this file.
      metaCache?.delete(filePath);
    }
  }
  if (!meta || meta.source === "exec") return undefined;
  return {
    sessionId: meta.id,
    ...(meta.parentProviderSessionId
      ? { parentProviderSessionId: meta.parentProviderSessionId }
      : {}),
    filePath,
    modifiedAtMs: info.mtime?.getTime() ?? 0,
  };
}

export async function discoverCodexSessions(
  roots: string[],
  metaCache?: CodexSessionMetaCache,
): Promise<ProviderSessionFile[]> {
  const sessions: ProviderSessionFile[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for await (const filePath of walkMatchingFiles(root, isJsonlName)) {
      seenPaths.add(filePath);
      const session = await describeCodexSessionFile(filePath, metaCache);
      if (session) sessions.push(session);
    }
  }
  if (metaCache) {
    pruneCacheUnderRoots(metaCache, roots, seenPaths);
  }
  return sessions;
}

/** Drops cache entries under the walked roots that the walk did not see. */
function pruneCacheUnderRoots<V>(
  cache: Map<string, V>,
  roots: string[],
  seenPaths: Set<string>,
): void {
  const rootKeys = roots.map(toPathKey);
  for (const path of cache.keys()) {
    if (seenPaths.has(path)) continue;
    const key = toPathKey(path);
    if (rootKeys.some((rootKey) => isPathKeyWithin(key, rootKey))) {
      cache.delete(path);
    }
  }
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

interface GeminiDiscoveryCacheEntry {
  mtimeMs: number;
  size: number;
  discovery: GeminiSessionDiscovery | undefined;
}

/**
 * Per-runner memo of each Gemini session file's discovery fields, keyed by
 * path. Gemini rewrites the whole file, so an unchanged mtime and size mean
 * the file need not be read and parsed again.
 */
export type GeminiDiscoveryCache = Map<string, GeminiDiscoveryCacheEntry>;

/** Describes one Gemini session file, or `undefined` if it is not one. */
export async function describeGeminiSessionFile(
  filePath: string,
  discoveryRoot: string,
  cache?: GeminiDiscoveryCache,
): Promise<ProviderSessionFile | undefined> {
  if (!isGeminiSessionPath(filePath)) return undefined;
  const info = await lstatSessionFile(filePath);
  if (!info?.isFile) {
    cache?.delete(filePath);
    return undefined;
  }
  const mtimeMs = info.mtime?.getTime() ?? 0;
  const cached = cache?.get(filePath);
  let discovery: GeminiSessionDiscovery | undefined;
  if (cached && cached.mtimeMs === mtimeMs && cached.size === info.size) {
    discovery = cached.discovery;
  } else {
    discovery = await readGeminiSessionDiscovery(filePath, discoveryRoot);
    cache?.set(filePath, { mtimeMs, size: info.size, discovery });
  }
  if (!discovery) return undefined;
  return {
    sessionId: discovery.sessionId,
    filePath,
    modifiedAtMs: mtimeMs,
    ...(discovery.contentUpdatedAtMs !== undefined
      ? { contentUpdatedAtMs: discovery.contentUpdatedAtMs }
      : {}),
    layoutType: discovery.layoutType,
  };
}

export async function discoverGeminiSessions(
  roots: string[],
  cache?: GeminiDiscoveryCache,
): Promise<ProviderSessionFile[]> {
  const sessions: ProviderSessionFile[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    for await (const filePath of walkMatchingFiles(root, isGeminiSessionName)) {
      seenPaths.add(filePath);
      const session = await describeGeminiSessionFile(filePath, root, cache);
      if (session) sessions.push(session);
    }
  }
  if (cache) {
    pruneCacheUnderRoots(cache, roots, seenPaths);
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

export class FileProviderIngestionRunner implements ProviderIngestionRunner {
  readonly provider: string;
  private readonly now: () => Date;
  private readonly discoveryIntervalMs: number;
  private readonly degradedDiscoveryIntervalMs: number;
  private readonly hotPollIntervalMs: number;
  private readonly hotWindowMs: number;
  private readonly watchMissGraceMs: number;
  private readonly watchMissThreshold: number;
  private readonly watchMissWindowMs: number;
  private readonly watchRestartDelaysMs: number[];
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
  private readonly autoGenerateTwins: boolean;
  private readonly discoverSessions: (
    roots: string[],
  ) => Promise<ProviderSessionFile[]>;
  private readonly describeSessionFile:
    | ((
      filePath: string,
      root: string,
    ) => Promise<ProviderSessionFile | undefined>)
    | undefined;
  private readonly isSessionFilePath: (filePath: string) => boolean;
  private readonly parseEvents: (
    filePath: string,
    fromOffset: number,
    ctx: ProviderParseContext,
  ) => AsyncIterable<{
    event?: ConversationEvent;
    titleUpdate?: ProviderIngestionTitleUpdate;
    cursor: ProviderCursor;
  }>;
  private readonly watchRoots: string[];
  private readonly sessions = new Map<string, ProviderSessionFile>();
  private readonly sessionByFilePath = new Map<string, string>();
  private readonly dirtySessions = new Set<string>();
  /**
   * Tracked sessions whose source gained content kato never ingested (written
   * while the daemon was down or while ingestion kept failing). Drained one
   * per poll so a large backlog cannot stall the daemon loop.
   */
  private readonly catchUpQueue: string[] = [];
  private readonly catchUpPending = new Set<string>();
  private readonly cursors = new Map<string, ProviderCursor>();
  private readonly cursorSourcePaths = new Map<string, string>();
  private readonly pendingBatchPaths = new Set<string>();
  private readonly rootStates: RootDiscoveryState[];
  /**
   * Session-file paths the watcher reported since a stat last looked at
   * them. A change a stat finds for a path not in here was missed.
   */
  private readonly eventSeenPaths = new Set<string>();
  private nextHotPollAtMs = 0;
  private started = false;
  private startedAtMs = 0;
  private lastDuplicateDiscoveryWarningKey: string | undefined;
  private watchAbortController: AbortController | undefined;
  private watchTask: Promise<void> | undefined;
  /** Bumped on every watcher (re)start, so stale callbacks are ignored. */
  private watchGeneration = 0;
  private watcherState: "off" | "watching" | "down" = "off";
  private watchedRoots: string[] = [];
  private watchedRootKeys = new Set<string>();
  private watchPathAliases: WatchPathAlias[] = [];
  private watcherDownSinceMs = 0;
  private watchFailures = 0;
  private watchRestartAtMs: number | undefined;
  private watchRestartRequested = false;
  private rescanRequested = false;
  private readonly failedClosedSessions = new Set<string>();
  private readonly secretsRedactor: SecretsRedactor;
  /**
   * Per-run cache of first-user-message snippets read from source heads,
   * keyed by `sessionId:filePath`. Caches `undefined` results too so a
   * session with no user message is not re-scanned every poll.
   */
  private readonly headSnippets = new Map<string, string | undefined>();
  private readonly providerTitleBackfills = new Map<
    string,
    ProviderIngestionTitleUpdate | undefined
  >();
  /** Latest complete-parse checkpoint per session (memory only). */
  private readonly parseCheckpoints = new Map<string, SessionParseCheckpoint>();
  private readonly compactionScans = new Map<
    string,
    CodexCompactionScanState
  >();
  private readonly ingestionFailures = new Map<string, IngestionFailureState>();

  constructor(options: FileProviderIngestionRunnerOptions) {
    this.provider = options.provider;
    this.watchRoots = normalizeRoots(options.watchRoots);
    this.discoverSessions = options.discoverSessions;
    this.describeSessionFile = options.describeSessionFile;
    this.isSessionFilePath = options.isSessionFilePath ?? (() => true);
    this.parseEvents = options.parseEvents;
    this.sessionSnapshotStore = options.sessionSnapshotStore;
    this.sessionStateStore = options.sessionStateStore;
    this.autoGenerateTwins = options.autoGenerateTwins ?? false;
    this.now = options.now ?? (() => new Date());
    this.discoveryIntervalMs = options.discoveryIntervalMs ??
      DEFAULT_DISCOVERY_INTERVAL_MS;
    const timing = options.discoveryTiming ?? {};
    this.degradedDiscoveryIntervalMs = Math.min(
      timing.degradedDiscoveryIntervalMs ??
        DEFAULT_DEGRADED_DISCOVERY_INTERVAL_MS,
      this.discoveryIntervalMs,
    );
    this.hotPollIntervalMs = timing.hotPollIntervalMs ??
      DEFAULT_HOT_POLL_INTERVAL_MS;
    this.hotWindowMs = timing.hotWindowMs ?? DEFAULT_HOT_WINDOW_MS;
    this.watchMissGraceMs = timing.watchMissGraceMs ??
      DEFAULT_WATCH_MISS_GRACE_MS;
    this.watchMissThreshold = Math.max(
      1,
      timing.watchMissThreshold ?? DEFAULT_WATCH_MISS_THRESHOLD,
    );
    this.watchMissWindowMs = timing.watchMissWindowMs ??
      DEFAULT_WATCH_MISS_WINDOW_MS;
    this.watchRestartDelaysMs = timing.watchRestartDelaysMs &&
        timing.watchRestartDelaysMs.length > 0
      ? [...timing.watchRestartDelaysMs]
      : DEFAULT_WATCH_RESTART_DELAYS_MS;
    this.rootStates =
      (this.watchRoots.length > 0
        ? this.watchRoots.map((root) => ({ root, key: toPathKey(root) }))
        : [{ root: "", key: "" }]).map(({ root, key }) => ({
          root,
          key,
          nextWalkAtMs: 0,
          walkRequested: true,
          missTimesMs: [],
          missedChanges: 0,
        }));
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.watchFs = options.watchFs ?? watchFsDebounced;
    this.operationalLogger = options.operationalLogger ??
      makeNoopOperationalLogger(this.now);
    this.auditLogger = options.auditLogger ?? makeNoopAuditLogger(this.now);
    // Fail-closed: absent policy means redact, never pass-through.
    this.secretsRedactor = createSecretsRedactor(
      options.secretsPolicy ??
        { mode: "redact", disabledRules: [], allowlist: [] },
    );
  }

  /**
   * Applies the secrets policy to freshly parsed events before any
   * snapshot/twin/snippet consumption. Events the transform fails on are
   * dropped (fail-closed) and surfaced via audit logging.
   */
  private async applySecretsPolicy(
    events: ConversationEvent[],
    sessionId: string,
  ): Promise<ConversationEvent[]> {
    if (this.secretsRedactor.mode === "off" || events.length === 0) {
      return events;
    }
    const result = redactConversationEvents(events, this.secretsRedactor);
    if (result.redactedEvents.length > 0) {
      const countsByRule: Record<string, number> = {};
      for (const outcome of result.redactedEvents) {
        for (const match of outcome.matches) {
          countsByRule[match.ruleId] = (countsByRule[match.ruleId] ?? 0) +
            match.count;
        }
      }
      await this.auditLogger.record(
        this.secretsRedactor.mode === "redact"
          ? "secrets.redacted"
          : "secrets.detected",
        this.secretsRedactor.mode === "redact"
          ? "Secrets redacted from ingested conversation events"
          : "Secrets detected in ingested conversation events",
        {
          provider: this.provider,
          sessionId,
          mode: this.secretsRedactor.mode,
          eventsAffected: result.redactedEvents.length,
          countsByRule,
        },
      );
    }
    if (result.droppedEventIds.length > 0) {
      await this.auditLogger.record(
        "secrets.events_dropped",
        "Events dropped because secrets redaction failed",
        {
          provider: this.provider,
          sessionId,
          droppedEventIds: result.droppedEventIds,
        },
      );
      await this.operationalLogger.error(
        "provider.ingestion.secrets_redaction_failed",
        "Secrets redaction failed for events; events dropped fail-closed",
        {
          provider: this.provider,
          sessionId,
          droppedEvents: result.droppedEventIds.length,
        },
      );
    }
    return result.events;
  }

  /**
   * Bounded read of the source-file head to recover the conversation's first
   * user message as a stable session snippet when no full-history snapshot
   * (twin hydration) is available. Secrets policy applies before extraction
   * so a credential in the opening message cannot leak via the label. Never
   * fails ingestion: any error resolves to `undefined`.
   */
  private async resolveHeadSnippet(
    sessionId: string,
    filePath: string,
  ): Promise<string | undefined> {
    const cacheKey = `${sessionId}:${filePath}`;
    if (this.headSnippets.has(cacheKey)) {
      return this.headSnippets.get(cacheKey);
    }

    let snippet: string | undefined;
    try {
      let scanned = 0;
      for await (
        const { event } of this.parseEvents(filePath, 0, {
          provider: this.provider,
          sessionId,
        })
      ) {
        if (!event) {
          continue;
        }
        scanned += 1;
        if (event.kind === "message.user") {
          const candidate = extractSnippet(
            await this.applySecretsPolicy([event], sessionId),
          );
          if (candidate) {
            snippet = candidate;
            break;
          }
        }
        if (scanned >= HEAD_SNIPPET_MAX_EVENTS) {
          break;
        }
      }
    } catch (error) {
      await this.operationalLogger.debug(
        "provider.ingestion.head_snippet_failed",
        "Source head read for session snippet failed; label stays unset",
        {
          provider: this.provider,
          sessionId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    this.headSnippets.set(cacheKey, snippet);
    return snippet;
  }

  /**
   * Applies the secrets policy to a provider session title with the same
   * fail-closed semantics as event redaction: a title the transform throws on
   * is dropped, never passed through. Audit events carry rule counts only,
   * never title text.
   */
  private async applySecretsPolicyToTitle(
    update: ProviderIngestionTitleUpdate,
    sessionId: string,
  ): Promise<ProviderIngestionTitleUpdate | undefined> {
    if (this.secretsRedactor.mode === "off") {
      return update;
    }
    try {
      const result = this.secretsRedactor.processText(update.title);
      if (result.matches.length > 0) {
        const countsByRule: Record<string, number> = {};
        for (const match of result.matches) {
          countsByRule[match.ruleId] = (countsByRule[match.ruleId] ?? 0) +
            match.count;
        }
        await this.auditLogger.record(
          this.secretsRedactor.mode === "redact"
            ? "secrets.redacted"
            : "secrets.detected",
          this.secretsRedactor.mode === "redact"
            ? "Secrets redacted from provider session title"
            : "Secrets detected in provider session title",
          {
            provider: this.provider,
            sessionId,
            mode: this.secretsRedactor.mode,
            field: "providerTitle",
            countsByRule,
          },
        );
      }
      return this.secretsRedactor.mode === "redact"
        ? { ...update, title: result.text }
        : update;
    } catch {
      await this.operationalLogger.error(
        "provider.ingestion.secrets_redaction_failed",
        "Secrets redaction failed for provider session title; title dropped fail-closed",
        { provider: this.provider, sessionId },
      );
      return undefined;
    }
  }

  /**
   * One-time full-file scan recovering provider title lines for sessions whose
   * cursor already passed them (pre-feature snapshots, mid-file resumes).
   * Never fails ingestion: any error resolves to `undefined`. Results
   * (including misses) are cached per session/file for the daemon's lifetime.
   */
  private async resolveProviderTitleBackfill(
    sessionId: string,
    filePath: string,
  ): Promise<ProviderIngestionTitleUpdate | undefined> {
    const cacheKey = `${sessionId}:${filePath}`;
    if (this.providerTitleBackfills.has(cacheKey)) {
      return this.providerTitleBackfills.get(cacheKey);
    }

    const latest: { custom?: string; ai?: string } = {};
    try {
      for await (
        const { titleUpdate } of this.parseEvents(filePath, 0, {
          provider: this.provider,
          sessionId,
        })
      ) {
        if (titleUpdate) {
          latest[titleUpdate.source] = titleUpdate.title;
        }
      }
    } catch (error) {
      await this.operationalLogger.debug(
        "provider.ingestion.title_backfill_failed",
        "Source scan for provider session title failed; title stays unset",
        {
          provider: this.provider,
          sessionId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const update: ProviderIngestionTitleUpdate | undefined =
      latest.custom !== undefined
        ? { title: latest.custom, source: "custom" }
        : latest.ai !== undefined
        ? { title: latest.ai, source: "ai" }
        : undefined;
    const processed = update
      ? await this.applySecretsPolicyToTitle(update, sessionId)
      : undefined;
    this.providerTitleBackfills.set(cacheKey, processed);
    return processed;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAtMs = this.now().getTime();
    this.nextHotPollAtMs = this.startedAtMs + this.hotPollIntervalMs;
    for (const state of this.rootStates) {
      state.walkRequested = true;
    }

    await this.operationalLogger.info(
      "provider.ingestion.started",
      "Provider ingestion runner started",
      { provider: this.provider, watchRoots: this.watchRoots },
    );

    await this.launchWatcher();
  }

  async poll(): Promise<ProviderIngestionPollResult> {
    if (!this.started) {
      throw new Error(
        `Provider ingestion runner not started: ${this.provider}`,
      );
    }

    await this.maintainWatcher(this.now().getTime());
    if (this.rescanRequested) {
      this.rescanRequested = false;
      for (const state of this.rootStates) {
        state.walkRequested = true;
      }
      await this.operationalLogger.info(
        "provider.ingestion.watch.rescan",
        "Watcher reported dropped events; rescanning all roots",
        { provider: this.provider },
      );
    }

    await this.walkDueRoots(this.now().getTime());
    await this.processPendingWatchPaths();
    // Reported paths that could not be resolved on their own ask for a walk.
    await this.walkDueRoots(this.now().getTime());
    const hotPollNowMs = this.now().getTime();
    if (hotPollNowMs >= this.nextHotPollAtMs) {
      await this.hotPoll(hotPollNowMs);
    }

    this.scheduleNextCatchUp();
    const dirtySessions = Array.from(this.dirtySessions.values()).sort();
    this.dirtySessions.clear();

    let sessionsUpdated = 0;
    let eventsObserved = 0;
    const nowMs = this.now().getTime();

    for (const sessionId of dirtySessions) {
      const failure = this.ingestionFailures.get(sessionId);
      if (failure && failure.nextRetryAtMs > nowMs) {
        // Backing off after parse failures; retry when due.
        this.dirtySessions.add(sessionId);
        continue;
      }
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
    this.watchGeneration += 1;

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

  /** The session files this runner tracks, by session id (diagnostics). */
  listTrackedSessions(): ProviderSessionFile[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  /** Roots whose watcher is not trusted right now, grouped by reason. */
  getWatchDegraded(): DaemonWatchDegradedStatus[] {
    const entries: DaemonWatchDegradedStatus[] = [];
    if (this.watcherState === "down") {
      entries.push({
        provider: this.provider,
        reason: "watcher-down",
        roots: [...this.watchedRoots],
        since: new Date(this.watcherDownSinceMs).toISOString(),
      });
    }
    const degraded = this.rootStates.filter((state) =>
      state.degradedAtMs !== undefined
    );
    if (degraded.length > 0) {
      entries.push({
        provider: this.provider,
        reason: "missed-changes",
        roots: degraded.map((state) => state.root),
        since: new Date(
          Math.min(...degraded.map((state) => state.degradedAtMs!)),
        ).toISOString(),
        missedChanges: degraded.reduce(
          (total, state) => total + state.missedChanges,
          0,
        ),
      });
    }
    return entries;
  }

  /** Starts the watcher over the roots that exist now. */
  private async launchWatcher(): Promise<void> {
    this.watchRestartAtMs = undefined;
    this.watchRestartRequested = false;
    const existingRoots: string[] = [];
    for (const state of this.rootStates) {
      if (state.key === "") continue;
      try {
        if (await pathExists(state.root)) {
          existingRoots.push(state.root);
        }
      } catch (error) {
        if (!(await this.handleReadDenied(error, "stat", state.root))) {
          throw error;
        }
      }
    }

    const generation = ++this.watchGeneration;
    this.watchedRoots = existingRoots;
    this.watchedRootKeys = new Set(existingRoots.map(toPathKey));
    if (existingRoots.length === 0) {
      this.watcherState = "off";
      return;
    }
    this.watchPathAliases = await resolveWatchPathAliases(existingRoots);

    const controller = new AbortController();
    this.watchAbortController = controller;
    this.watcherState = "watching";
    this.watchTask = this.watchFs(
      existingRoots,
      (batch) => this.onWatchBatch(batch, generation),
      {
        debounceMs: this.watchDebounceMs,
        recursive: true,
        signal: controller.signal,
        now: this.now,
      },
    ).then(
      () => this.onWatcherEnded(generation, controller, undefined),
      (error) => this.onWatcherEnded(generation, controller, error),
    );
  }

  /** Stops the current watcher, if any, and starts a new one. */
  private async relaunchWatcher(): Promise<void> {
    const controller = this.watchAbortController;
    const task = this.watchTask;
    this.watchAbortController = undefined;
    this.watchTask = undefined;
    controller?.abort();
    if (task) await task;
    await this.launchWatcher();
  }

  /**
   * A watcher ended without being asked to: every root loses its trust and
   * is walked on the fast interval until a restart, with backoff.
   */
  private async onWatcherEnded(
    generation: number,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (
      controller.signal.aborted || generation !== this.watchGeneration ||
      !this.started
    ) {
      return;
    }
    const nowMs = this.now().getTime();
    const delayMs = this.watchRestartDelaysMs[
      Math.min(this.watchFailures, this.watchRestartDelaysMs.length - 1)
    ];
    this.watchFailures += 1;
    this.watcherState = "down";
    this.watcherDownSinceMs = nowMs;
    this.watchedRootKeys = new Set();
    this.watchAbortController = undefined;
    this.watchRestartAtMs = nowMs + delayMs;
    this.tightenWalkSchedules(nowMs);

    const message = error === undefined
      ? "watcher stopped unexpectedly"
      : error instanceof Error
      ? error.message
      : String(error);
    const hint = describeWatchFailureHint(message);
    await this.operationalLogger.error(
      "provider.ingestion.watch.failed",
      "Provider ingestion watch loop failed; rescanning roots until it restarts",
      {
        provider: this.provider,
        error: message,
        retryInMs: delayMs,
        ...(hint ? { hint } : {}),
      },
    );
  }

  /** Restarts a failed watcher when due, or one asked for by a new root. */
  private async maintainWatcher(nowMs: number): Promise<void> {
    const restartDue = this.watcherState === "down" &&
      this.watchRestartAtMs !== undefined && nowMs >= this.watchRestartAtMs;
    if (!restartDue && !this.watchRestartRequested) return;
    const wasDown = this.watcherState === "down";
    await this.relaunchWatcher();
    if (this.watcherState !== "watching") return;
    // Whatever changed while a root was unwatched is found by walking it.
    for (const state of this.rootStates) {
      state.walkRequested = true;
    }
    if (wasDown) {
      await this.operationalLogger.info(
        "provider.ingestion.watch.restarted",
        "Provider ingestion watcher restarted",
        {
          provider: this.provider,
          attempt: this.watchFailures,
          watchRoots: this.watchedRoots,
        },
      );
    }
  }

  private isRootTrusted(state: RootDiscoveryState): boolean {
    return this.watcherState === "watching" &&
      this.watchedRootKeys.has(state.key) &&
      state.degradedAtMs === undefined;
  }

  private walkIntervalFor(state: RootDiscoveryState): number {
    return this.isRootTrusted(state)
      ? this.discoveryIntervalMs
      : this.degradedDiscoveryIntervalMs;
  }

  /** Brings untrusted roots' next walk forward to the fast interval. */
  private tightenWalkSchedules(nowMs: number): void {
    for (const state of this.rootStates) {
      if (this.isRootTrusted(state)) continue;
      state.nextWalkAtMs = Math.min(
        state.nextWalkAtMs,
        nowMs + this.degradedDiscoveryIntervalMs,
      );
    }
  }

  private rootStateFor(path: string): RootDiscoveryState | undefined {
    const key = toPathKey(path);
    let best: RootDiscoveryState | undefined;
    for (const state of this.rootStates) {
      if (
        isPathKeyWithin(key, state.key) &&
        (!best || state.key.length > best.key.length)
      ) {
        best = state;
      }
    }
    return best;
  }

  private requestWalk(state: RootDiscoveryState | undefined): void {
    for (const candidate of state ? [state] : this.rootStates) {
      candidate.walkRequested = true;
    }
  }

  /** Rewrites a watcher path into the form walks produce. */
  private normalizeEventPath(rawPath: string): string {
    const path = normalize(rawPath);
    const key = toPathKey(path);
    for (const alias of this.watchPathAliases) {
      if (isPathKeyWithin(key, alias.fromKey)) {
        return alias.toPrefix + path.slice(alias.fromPrefix.length);
      }
    }
    return path;
  }

  private async onWatchBatch(
    batch: DebouncedWatchBatch,
    generation: number,
  ): Promise<void> {
    if (generation !== this.watchGeneration) return;
    this.watchFailures = 0;
    for (const rawPath of batch.paths) {
      const path = this.normalizeEventPath(rawPath);
      this.pendingBatchPaths.add(path);
      if (this.isSessionFilePath(path)) {
        this.eventSeenPaths.add(path);
      }
    }
    if (batch.rescan) {
      this.rescanRequested = true;
    }
    await this.operationalLogger.debug(
      "provider.ingestion.watch.batch",
      "Provider ingestion watch batch received",
      {
        provider: this.provider,
        paths: batch.paths,
        kinds: batch.kinds,
        ...(batch.rescan ? { rescan: true } : {}),
      },
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

  private async walkDueRoots(nowMs: number): Promise<void> {
    const due = this.rootStates.filter((state) =>
      state.walkRequested || nowMs >= state.nextWalkAtMs
    );
    if (due.length === 0) return;
    await this.walkRoots(due, nowMs);
  }

  /**
   * Walks some roots and reconciles what they hold. A walk of every root
   * behaves as discovery always did; a walk of some roots drops only
   * sessions under those roots.
   */
  private async walkRoots(
    states: RootDiscoveryState[],
    walkStartMs: number,
  ): Promise<void> {
    const full = states.length === this.rootStates.length;
    for (const state of states) {
      state.walkRequested = false;
      state.nextWalkAtMs = walkStartMs + this.walkIntervalFor(state);
    }
    await this.noticeAppearedRoots(states);

    let discovered: ProviderSessionFile[];
    try {
      discovered = await this.discoverSessions(
        full ? this.watchRoots : states.map((state) => state.root),
      );
    } catch (error) {
      if (
        await this.handleReadDenied(
          error,
          "readDir",
          states[0]?.root || this.watchRoots[0] || "unknown",
        )
      ) {
        return;
      }
      throw error;
    }

    const stateKeys = states.map((state) => state.key);
    const inScope = full ? () => true : (path: string) => {
      const key = toPathKey(path);
      return stateKeys.some((stateKey) => isPathKeyWithin(key, stateKey));
    };
    const deduped = await this.dedupeDiscoveredSessions(discovered);
    const activeSessionIds = new Set<string>();
    const catchUpCandidates: ProviderSessionFile[] = [];

    for (const session of deduped) {
      if (!inScope(session.filePath)) continue;
      const current = this.sessions.get(session.sessionId);
      if (
        !full && current && current.filePath !== session.filePath &&
        !inScope(current.filePath) &&
        !(await this.candidateWins(session, current))
      ) {
        continue;
      }
      activeSessionIds.add(session.sessionId);
      await this.checkWalkObservation(session, current, walkStartMs);
      if (await this.trackDiscoveredSession(session)) {
        catchUpCandidates.push(session);
      }
    }

    for (const [sessionId, existing] of [...this.sessions]) {
      if (activeSessionIds.has(sessionId) || !inScope(existing.filePath)) {
        continue;
      }
      this.untrackSession(sessionId);
    }
    for (const path of [...this.eventSeenPaths]) {
      if (inScope(path)) this.eventSeenPaths.delete(path);
    }
    for (const state of states) {
      state.lastWalkAtMs = walkStartMs;
    }

    await this.queueStaleSessionCatchUp(catchUpCandidates);
    await this.operationalLogger.debug(
      "provider.ingestion.discovery.walked",
      "Walked provider session roots",
      {
        provider: this.provider,
        roots: full ? this.watchRoots.length : states.length,
        full,
        sessionsFound: deduped.length,
      },
    );
  }

  /** Asks for a watcher restart when an unwatched root now exists. */
  private async noticeAppearedRoots(
    states: RootDiscoveryState[],
  ): Promise<void> {
    if (this.watcherState === "down" || this.watchRestartRequested) return;
    for (const state of states) {
      if (state.key === "" || this.watchedRootKeys.has(state.key)) continue;
      let exists = false;
      try {
        exists = await pathExists(state.root);
      } catch {
        // Unreadable roots are reported by the walk itself.
      }
      if (exists) {
        this.watchRestartRequested = true;
        return;
      }
    }
  }

  /** Counts a walk's finding as missed when the watcher never reported it. */
  private async checkWalkObservation(
    session: ProviderSessionFile,
    current: ProviderSessionFile | undefined,
    nowMs: number,
  ): Promise<void> {
    if (current) {
      if (
        current.filePath === session.filePath &&
        current.modifiedAtMs !== session.modifiedAtMs
      ) {
        await this.noteObservedChange(
          session.filePath,
          session.modifiedAtMs,
          nowMs,
        );
      }
      return;
    }
    const state = this.rootStateFor(session.filePath);
    if (
      state?.lastWalkAtMs !== undefined &&
      session.modifiedAtMs > state.lastWalkAtMs
    ) {
      await this.noteObservedChange(
        session.filePath,
        session.modifiedAtMs,
        nowMs,
      );
    }
  }

  /**
   * A stat found a change (new mtime, or a new file) for `path`. If the
   * watcher had not reported it and it is old enough that its event cannot
   * still be in flight, it counts against the root's watcher.
   */
  private async noteObservedChange(
    path: string,
    mtimeMs: number,
    nowMs: number,
  ): Promise<void> {
    if (this.eventSeenPaths.has(path)) return;
    if (nowMs - mtimeMs < this.watchMissGraceMs) return;
    const state = this.rootStateFor(path);
    if (
      !state || state.degradedAtMs !== undefined || !this.isRootTrusted(state)
    ) {
      return;
    }
    state.missTimesMs = state.missTimesMs.filter((time) =>
      nowMs - time < this.watchMissWindowMs
    );
    state.missTimesMs.push(nowMs);
    state.missedChanges += 1;
    await this.operationalLogger.debug(
      "provider.ingestion.watch.missed",
      "A rescan found a change the watcher did not report",
      {
        provider: this.provider,
        root: state.root,
        path,
        missesInWindow: state.missTimesMs.length,
      },
    );
    if (state.missTimesMs.length < this.watchMissThreshold) return;
    state.degradedAtMs = nowMs;
    state.nextWalkAtMs = Math.min(
      state.nextWalkAtMs,
      nowMs + this.degradedDiscoveryIntervalMs,
    );
    await this.operationalLogger.warn(
      "provider.ingestion.watch.degraded",
      "Watcher missed changes under a session root; rescanning it every few seconds",
      {
        provider: this.provider,
        root: state.root,
        missedChanges: state.missedChanges,
        windowMs: this.watchMissWindowMs,
        rescanIntervalMs: this.degradedDiscoveryIntervalMs,
        lastMissedPath: path,
      },
    );
  }

  /** Resolves the paths the watcher reported since the last poll. */
  private async processPendingWatchPaths(): Promise<void> {
    if (this.pendingBatchPaths.size === 0) return;
    const paths = [...this.pendingBatchPaths];
    this.pendingBatchPaths.clear();
    const catchUpCandidates: ProviderSessionFile[] = [];
    for (const path of paths) {
      const sessionId = this.sessionByFilePath.get(path);
      if (sessionId) {
        this.dirtySessions.add(sessionId);
        continue;
      }
      const state = this.rootStateFor(path);
      if (!this.describeSessionFile) {
        this.requestWalk(state);
        continue;
      }
      if (!state) continue;
      if (this.isSessionFilePath(path)) {
        await this.resolveReportedFile(path, state, catchUpCandidates);
      } else {
        await this.resolveReportedOtherPath(path, state, catchUpCandidates);
      }
    }
    await this.queueStaleSessionCatchUp(catchUpCandidates);
  }

  /** Tracks one reported file, as a walk that found it would. */
  private async resolveReportedFile(
    path: string,
    state: RootDiscoveryState,
    catchUpCandidates: ProviderSessionFile[],
  ): Promise<void> {
    let session: ProviderSessionFile | undefined;
    try {
      session = await this.describeSessionFile!(path, state.root);
    } catch (error) {
      if (await this.handleReadDenied(error, "stat", path)) return;
      throw error;
    }
    if (!session) return;
    const current = this.sessions.get(session.sessionId);
    if (
      current && current.filePath !== session.filePath &&
      !(await this.candidateWins(session, current))
    ) {
      return;
    }
    if (await this.trackDiscoveredSession(session)) {
      catchUpCandidates.push(session);
    }
  }

  /**
   * A reported path that cannot be a session file: a new directory is read
   * (files made before its watch existed would be missed otherwise), and a
   * vanished one takes its sessions with it.
   */
  private async resolveReportedOtherPath(
    path: string,
    state: RootDiscoveryState,
    catchUpCandidates: ProviderSessionFile[],
  ): Promise<void> {
    let info: Deno.FileInfo | undefined;
    try {
      info = await lstatSessionFile(path);
    } catch (error) {
      if (await this.handleReadDenied(error, "stat", path)) return;
      throw error;
    }
    if (info?.isDirectory) {
      try {
        for await (
          const filePath of walkMatchingFiles(
            path,
            (name) => this.isSessionFilePath(name),
          )
        ) {
          if (!this.sessionByFilePath.has(filePath)) {
            await this.resolveReportedFile(filePath, state, catchUpCandidates);
          }
        }
      } catch (error) {
        if (await this.handleReadDenied(error, "readDir", path)) return;
        throw error;
      }
      return;
    }
    if (info) return;
    const key = toPathKey(path);
    for (const [sessionId, session] of [...this.sessions]) {
      if (!isPathKeyWithin(toPathKey(session.filePath), key)) continue;
      try {
        if (!(await lstatSessionFile(session.filePath))) {
          this.untrackSession(sessionId);
        }
      } catch (error) {
        if (!(await this.handleReadDenied(error, "stat", session.filePath))) {
          throw error;
        }
      }
    }
  }

  /**
   * Stat-checks sessions that changed recently, so active sessions never
   * depend on the watcher alone.
   */
  private async hotPoll(nowMs: number): Promise<void> {
    this.nextHotPollAtMs = nowMs + this.hotPollIntervalMs;
    const cutoffMs = nowMs - this.hotWindowMs;
    for (const [sessionId, session] of [...this.sessions]) {
      if (session.modifiedAtMs < cutoffMs) continue;
      let info: Deno.FileInfo | undefined;
      try {
        info = await lstatSessionFile(session.filePath);
      } catch (error) {
        if (await this.handleReadDenied(error, "stat", session.filePath)) {
          continue;
        }
        throw error;
      }
      if (!info) {
        this.untrackSession(sessionId);
        continue;
      }
      const mtimeMs = info.mtime?.getTime() ?? 0;
      if (mtimeMs !== session.modifiedAtMs) {
        await this.noteObservedChange(session.filePath, mtimeMs, nowMs);
        this.sessions.set(sessionId, { ...session, modifiedAtMs: mtimeMs });
        this.dirtySessions.add(sessionId);
      }
      this.eventSeenPaths.delete(session.filePath);
    }
  }

  /**
   * Whether `candidate` should replace the tracked file for the same
   * session id: when that file is gone (a rename) or loses the same
   * comparison a walk's dedupe uses.
   */
  private async candidateWins(
    candidate: ProviderSessionFile,
    current: ProviderSessionFile,
  ): Promise<boolean> {
    let fresh: ProviderSessionFile | undefined = current;
    if (this.describeSessionFile) {
      try {
        fresh = await this.describeSessionFile(
          current.filePath,
          this.rootStateFor(current.filePath)?.root ?? "",
        );
      } catch (error) {
        if (!(await this.handleReadDenied(error, "stat", current.filePath))) {
          throw error;
        }
      }
    }
    if (!fresh || fresh.sessionId !== current.sessionId) return true;
    return compareDiscoveredSessionCandidates(candidate, fresh) < 0;
  }

  /**
   * Records a discovered session file. Returns true for a new session that
   * was not marked for ingestion, so its caller can queue a catch-up check.
   */
  private async trackDiscoveredSession(
    session: ProviderSessionFile,
  ): Promise<boolean> {
    const current = this.sessions.get(session.sessionId);
    const isNewSession = !current;
    const filePathChanged = current
      ? current.filePath !== session.filePath
      : false;
    const modifiedAtChanged = current
      ? current.modifiedAtMs !== session.modifiedAtMs
      : false;
    const parentChanged = current
      ? current.parentProviderSessionId !== session.parentProviderSessionId
      : session.parentProviderSessionId !== undefined;
    if (
      !isNewSession && !filePathChanged && !modifiedAtChanged && !parentChanged
    ) {
      return false;
    }
    if ((isNewSession || parentChanged) && session.parentProviderSessionId) {
      await this.reconcileDiscoveredSessionParent(session);
    }
    this.sessions.set(session.sessionId, session);
    this.sessionByFilePath.set(session.filePath, session.sessionId);
    if (current && current.filePath !== session.filePath) {
      this.sessionByFilePath.delete(current.filePath);
      this.cursors.delete(session.sessionId);
      this.cursorSourcePaths.delete(session.sessionId);
      this.forgetSessionParseCaches(session.sessionId);
    }
    if (
      filePathChanged ||
      modifiedAtChanged ||
      this.shouldProactivelyIngestDiscoveredSession(session)
    ) {
      this.dirtySessions.add(session.sessionId);
      return false;
    }
    return isNewSession;
  }

  private untrackSession(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    this.sessions.delete(sessionId);
    if (this.sessionByFilePath.get(existing.filePath) === sessionId) {
      this.sessionByFilePath.delete(existing.filePath);
    }
    this.cursors.delete(sessionId);
    this.cursorSourcePaths.delete(sessionId);
    this.forgetSessionParseCaches(sessionId);
    this.ingestionFailures.delete(sessionId);
    this.catchUpPending.delete(sessionId);
    this.dirtySessions.delete(sessionId);
  }

  private async reconcileDiscoveredSessionParent(
    session: ProviderSessionFile,
  ): Promise<void> {
    if (!this.sessionStateStore || !session.parentProviderSessionId) {
      return;
    }
    try {
      const result = await this.sessionStateStore
        .reconcileSessionParentProviderSessionId({
          provider: this.provider,
          providerSessionId: session.sessionId,
          sourceFilePath: session.filePath,
          parentProviderSessionId: session.parentProviderSessionId,
        });
      if (result === "updated") {
        await this.operationalLogger.debug(
          "session.state.parent_backfilled",
          "Backfilled provider parent relationship without replaying the session",
          {
            provider: this.provider,
            sessionId: session.sessionId,
            parentProviderSessionId: session.parentProviderSessionId,
          },
        );
      }
    } catch (error) {
      if (error instanceof SessionStateLoadError) {
        await this.operationalLogger.debug(
          "session.state.parent_backfill_skipped",
          "Skipped provider parent backfill for invalid session metadata",
          {
            provider: this.provider,
            sessionId: session.sessionId,
            metadataPath: error.metadataPath,
            reason: error.reason,
          },
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Queues tracked sessions whose source has content kato has not ingested
   * although it predates this runner. Only sessions with persisted metadata
   * are considered, so startup never replays the whole provider history.
   * A source counts as stale when its mtime is newer than the last ingested
   * mtime and, for byte-offset cursors, its size differs from the cursor:
   * a touched-but-unchanged file must not trigger a Codex warm-up pass.
   */
  private async queueStaleSessionCatchUp(
    candidates: ProviderSessionFile[],
  ): Promise<void> {
    if (!this.sessionStateStore || candidates.length === 0) return;
    const bySessionKey = new Map(
      candidates.map((session) => [
        `${this.provider}:${session.sessionId}`,
        session,
      ]),
    );
    let metadataEntries: SessionMetadataV1[];
    try {
      metadataEntries = await this.sessionStateStore
        .listSessionMetadataForKeys(bySessionKey.keys());
    } catch (error) {
      await this.operationalLogger.warn(
        "provider.ingestion.catch_up.skipped",
        "Could not load session metadata to detect stale sessions",
        {
          provider: this.provider,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return;
    }

    const stale: Array<
      { session: ProviderSessionFile; backlogBytes?: number }
    > = [];
    for (const metadata of metadataEntries) {
      const session = bySessionKey.get(metadata.sessionKey);
      if (!session || metadata.sourceFilePath !== session.filePath) continue;
      const lastObservedMtimeMs = metadata.lastObservedMtimeMs;
      if (
        lastObservedMtimeMs === undefined ||
        session.modifiedAtMs <= lastObservedMtimeMs
      ) {
        continue;
      }
      let backlogBytes: number | undefined;
      if (metadata.ingestCursor.kind === "byte-offset") {
        let size: number;
        try {
          size = (await Deno.stat(session.filePath)).size;
        } catch {
          // Missing or unreadable now; regular ingestion reports it later.
          continue;
        }
        if (size === metadata.ingestCursor.value) continue;
        backlogBytes = size - metadata.ingestCursor.value;
      }
      stale.push({ session, backlogBytes });
    }
    if (stale.length === 0) return;

    // Most recently active first: those are the sessions people look at.
    stale.sort((a, b) => b.session.modifiedAtMs - a.session.modifiedAtMs);
    let queued = 0;
    for (const { session } of stale) {
      if (this.catchUpPending.has(session.sessionId)) continue;
      this.catchUpPending.add(session.sessionId);
      this.catchUpQueue.push(session.sessionId);
      queued += 1;
    }
    if (queued === 0) return;
    await this.operationalLogger.info(
      "provider.ingestion.catch_up.queued",
      "Queued stale sessions for catch-up ingestion",
      {
        provider: this.provider,
        sessions: queued,
        backlogBytes: stale.reduce(
          (total, entry) => total + Math.max(0, entry.backlogBytes ?? 0),
          0,
        ),
        sessionIds: stale.map((entry) => entry.session.sessionId),
      },
    );
  }

  /**
   * Moves at most one queued catch-up session into this poll's work. Sessions
   * already ingested since they were queued (e.g. after a watch event) are
   * skipped.
   */
  private scheduleNextCatchUp(): void {
    while (this.catchUpQueue.length > 0) {
      const sessionId = this.catchUpQueue.shift()!;
      if (!this.catchUpPending.delete(sessionId)) continue;
      if (!this.sessions.has(sessionId)) continue;
      if (this.dirtySessions.has(sessionId)) continue;
      this.dirtySessions.add(sessionId);
      return;
    }
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

  /**
   * Returns the session's cached checkpoint when resuming from it yields the
   * same events as parsing from `fromOffset`: either the checkpoint is at or
   * before `fromOffset` (provider state carries forward; nothing is skipped),
   * or `fromOffset` is exactly the cursor the checkpointed parse persisted, so
   * the skipped range `(fromOffset, checkpoint]` produced no events.
   */
  private resolveResumeFrom(
    sessionId: string,
    filePath: string,
    fromOffset: number,
    fileSize: number,
  ): ProviderParseCheckpoint | undefined {
    const entry = this.parseCheckpoints.get(sessionId);
    if (!entry || entry.filePath !== filePath) {
      return undefined;
    }
    const { checkpoint } = entry;
    if (checkpoint.offset > fileSize) {
      return undefined;
    }
    if (
      checkpoint.offset <= fromOffset ||
      fromOffset === entry.cursorAtCheckpoint
    ) {
      return checkpoint;
    }
    return undefined;
  }

  private forgetSessionParseCaches(sessionId: string): void {
    this.parseCheckpoints.delete(sessionId);
    this.compactionScans.delete(sessionId);
  }

  /** Sessions whose source currently fails to ingest. */
  getIngestionFailures(): DaemonIngestionFailureStatus[] {
    return [...this.ingestionFailures.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sessionId, failure]) => ({
        provider: this.provider,
        sessionId,
        error: failure.error,
        firstFailedAt: new Date(failure.firstFailedAtMs).toISOString(),
        lastFailedAt: new Date(failure.lastFailedAtMs).toISOString(),
        consecutiveFailures: failure.consecutiveFailures,
        nextRetryAt: new Date(failure.nextRetryAtMs).toISOString(),
      }));
  }

  /**
   * Records a parse failure with exponential backoff. Logs the first failure,
   * each doubling of the failure count, and any change of error message, so a
   * deterministic failure cannot flood the log.
   */
  private async recordParseFailure(
    sessionId: string,
    filePath: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const nowMs = this.now().getTime();
    const previous = this.ingestionFailures.get(sessionId);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const backoffMs = Math.min(
      PARSE_FAILURE_INITIAL_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
      PARSE_FAILURE_MAX_BACKOFF_MS,
    );
    const failure: IngestionFailureState = {
      error: message,
      firstFailedAtMs: previous?.firstFailedAtMs ?? nowMs,
      lastFailedAtMs: nowMs,
      consecutiveFailures,
      nextRetryAtMs: nowMs + backoffMs,
    };
    this.ingestionFailures.set(sessionId, failure);
    this.forgetSessionParseCaches(sessionId);
    // Stay dirty so the session is retried once the backoff elapses, even if
    // the source stops changing.
    this.dirtySessions.add(sessionId);

    if (
      consecutiveFailures === 1 || isPowerOfTwo(consecutiveFailures) ||
      previous?.error !== message
    ) {
      await this.operationalLogger.error(
        "provider.ingestion.parse_error",
        "Provider ingestion parse failed",
        {
          provider: this.provider,
          sessionId,
          filePath,
          error: message,
          consecutiveFailures,
          firstFailedAt: new Date(failure.firstFailedAtMs).toISOString(),
          nextRetryAt: new Date(failure.nextRetryAtMs).toISOString(),
        },
      );
    }
  }

  private async clearParseFailure(
    sessionId: string,
    filePath: string,
  ): Promise<void> {
    const previous = this.ingestionFailures.get(sessionId);
    if (!previous) return;
    this.ingestionFailures.delete(sessionId);
    await this.operationalLogger.info(
      "provider.ingestion.parse_recovered",
      "Provider ingestion recovered after parse failures",
      {
        provider: this.provider,
        sessionId,
        filePath,
        consecutiveFailures: previous.consecutiveFailures,
        firstFailedAt: new Date(previous.firstFailedAtMs).toISOString(),
      },
    );
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
    // Any ingest reads to EOF, which satisfies a pending catch-up.
    this.catchUpPending.delete(sessionId);

    const currentSnapshot = this.sessionSnapshotStore.get(sessionId);
    let stateMetadata: SessionMetadataV1 | undefined;
    if (this.sessionStateStore) {
      try {
        stateMetadata = await this.sessionStateStore.getOrCreateSessionMetadata(
          {
            provider: this.provider,
            providerSessionId: sessionId,
            ...(session.parentProviderSessionId
              ? {
                parentProviderSessionId: session.parentProviderSessionId,
              }
              : {}),
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
        this.untrackSession(sessionId);
        return { updated: false, eventsObserved: 0 };
      }
      if (await this.handleReadDenied(error, "stat", session.filePath)) {
        return { updated: false, eventsObserved: 0 };
      }
      throw error;
    }

    // Keep the tracked mtime current, so later stats and walks see only
    // changes made after this read.
    const statMtimeMs = fileStat.mtime?.getTime();
    if (
      statMtimeMs !== undefined && statMtimeMs !== session.modifiedAtMs &&
      this.sessions.get(sessionId) === session
    ) {
      this.sessions.set(sessionId, { ...session, modifiedAtMs: statMtimeMs });
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
      this.forgetSessionParseCaches(sessionId);
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
        const scan = await scanCodexCompactionAnchor(
          session.filePath,
          this.compactionScans.get(sessionId),
        );
        latestCompactionAnchor = scan.latest;
        if (scan.state) {
          this.compactionScans.set(sessionId, scan.state);
        } else {
          this.compactionScans.delete(sessionId);
        }
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

    const batchTitles: { custom?: string; ai?: string } = {};

    let twinAvailableForHydration = false;
    if (stateMetadata && this.sessionStateStore) {
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

      const needsBootstrap = this.autoGenerateTwins &&
        !twinExists &&
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
        let bootstrapCheckpoint: ProviderParseCheckpoint | undefined;
        try {
          for await (
            const { event, titleUpdate, cursor } of this.parseEvents(
              session.filePath,
              0,
              {
                provider: this.provider,
                sessionId,
                onCheckpoint: (checkpoint) => {
                  bootstrapCheckpoint = checkpoint;
                },
              },
            )
          ) {
            if (titleUpdate) {
              batchTitles[titleUpdate.source] = titleUpdate.title;
            }
            if (event) {
              bootstrapEvents.push(event);
            }
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
          await this.recordParseFailure(sessionId, session.filePath, error);
          return { updated: false, eventsObserved: 0 };
        }
        if (bootstrapCheckpoint) {
          this.parseCheckpoints.set(sessionId, {
            filePath: session.filePath,
            cursorAtCheckpoint: resolveCursorPosition(bootstrapCursor),
            checkpoint: bootstrapCheckpoint,
          });
        }

        const redactedBootstrapEvents = await this.applySecretsPolicy(
          bootstrapEvents,
          sessionId,
        );

        let bootstrappedTwinCount = 0;
        if (redactedBootstrapEvents.length > 0) {
          const twinDrafts = mapConversationEventsToTwin({
            provider: this.provider,
            providerSessionId: sessionId,
            sessionId: stateMetadata.sessionId,
            events: redactedBootstrapEvents,
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
          bootstrappedTwinCount = appendResult.appended.length;
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
        stateMetadata = await this.sessionStateStore.getOrCreateSessionMetadata(
          {
            provider: this.provider,
            providerSessionId: sessionId,
            sourceFilePath: session.filePath,
            initialCursor: stateMetadata.ingestCursor,
          },
        );

        twinExists = twinExists || bootstrappedTwinCount > 0;
        fromOffset = resolveCursorPosition(bootstrapCursor);
        existingCursor = bootstrapCursor;
        stateMetadata.ingestCursor = bootstrapCursor;
        stateMetadata.lastObservedMtimeMs = fileStat.mtime?.getTime();
        stateMetadata.sourceFilePath = session.filePath;
        await this.sessionStateStore.saveSessionMetadata(stateMetadata);
        this.setCursor(sessionId, bootstrapCursor, session.filePath);
      }

      twinAvailableForHydration = twinExists;
    }

    let incomingEvents: ConversationEvent[] = [];
    let latestCursor: ProviderCursor = existingCursor?.kind === "item-index"
      ? makeItemIndexCursor(fromOffset)
      : makeByteOffsetCursor(fromOffset);
    const resumeFrom = existingCursor?.kind === "item-index"
      ? undefined
      : this.resolveResumeFrom(
        sessionId,
        session.filePath,
        fromOffset,
        fileStat.size ?? 0,
      );
    let parseCheckpoint: ProviderParseCheckpoint | undefined;

    try {
      for await (
        const { event, titleUpdate, cursor } of this.parseEvents(
          session.filePath,
          fromOffset,
          {
            provider: this.provider,
            sessionId,
            ...(resumeFrom ? { resumeFrom } : {}),
            onCheckpoint: (checkpoint) => {
              parseCheckpoint = checkpoint;
            },
          },
        )
      ) {
        if (titleUpdate) {
          batchTitles[titleUpdate.source] = titleUpdate.title;
        }
        if (event) {
          incomingEvents.push(event);
        }
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
      await this.recordParseFailure(sessionId, session.filePath, error);
      return { updated: false, eventsObserved: 0 };
    }
    await this.clearParseFailure(sessionId, session.filePath);
    if (parseCheckpoint) {
      this.parseCheckpoints.set(sessionId, {
        filePath: session.filePath,
        cursorAtCheckpoint: resolveCursorPosition(latestCursor),
        checkpoint: parseCheckpoint,
      });
    } else {
      this.parseCheckpoints.delete(sessionId);
    }

    incomingEvents = await this.applySecretsPolicy(incomingEvents, sessionId);

    const batchTitleUpdate: ProviderIngestionTitleUpdate | undefined =
      batchTitles.custom !== undefined
        ? { title: batchTitles.custom, source: "custom" }
        : batchTitles.ai !== undefined
        ? { title: batchTitles.ai, source: "ai" }
        : undefined;
    let providerTitleUpdate = batchTitleUpdate
      ? await this.applySecretsPolicyToTitle(batchTitleUpdate, sessionId)
      : undefined;
    if (
      !providerTitleUpdate &&
      this.provider === "claude" &&
      fromOffset > 0 &&
      stateMetadata?.providerTitle === undefined &&
      currentSnapshot?.metadata.providerTitle === undefined
    ) {
      // Sessions ingested before title support (or resumed mid-file) already
      // consumed the offsets holding their title lines; recover them once
      // from the source head-to-tail scan.
      providerTitleUpdate = await this.resolveProviderTitleBackfill(
        sessionId,
        session.filePath,
      );
    }

    const latestOffset = resolveCursorPosition(latestCursor);
    const fileModifiedAtMs = fileStat.mtime?.getTime();
    let snippetOverride = isNonEmptyString(currentSnapshot?.metadata.snippet)
      ? currentSnapshot.metadata.snippet
      : undefined;
    if (!snippetOverride && fromOffset === 0) {
      snippetOverride = extractSnippet(incomingEvents);
    }
    if (
      !snippetOverride &&
      fromOffset > 0 &&
      !currentSnapshot &&
      !twinAvailableForHydration
    ) {
      // Creating a snapshot from a mid-file resume with no full-history twin
      // hydration: without this, the snapshot window starts at the resume
      // cursor and the session label drifts to whatever the user typed after
      // the latest daemon restart. Read the source head once to pin the
      // conversation's true first user message.
      snippetOverride = await this.resolveHeadSnippet(
        sessionId,
        session.filePath,
      );
    }

    if (stateMetadata && this.sessionStateStore) {
      const shouldAppendTwin = this.autoGenerateTwins;
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
      }

      let anchorChanged = false;
      let nextAnchor: SessionIngestAnchorV1 | undefined = stateMetadata
        .ingestAnchor;
      try {
        const geminiMessagesArg = this.provider === "gemini"
          ? (geminiMessagesCache ?? await loadGeminiMessagesForAnchor())
          : undefined;
        const anchorResolution = resolveNextIngestAnchor({
          provider: this.provider,
          previousAnchor: stateMetadata.ingestAnchor,
          latestCursor,
          geminiMessages: geminiMessagesArg,
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
      const nextWorkingDirectory = inferSessionWorkingDirectory(
        this.provider,
        incomingEvents,
        stateMetadata.workingDirectory,
      );
      const workingDirectoryChanged =
        stateMetadata.workingDirectory !== nextWorkingDirectory;
      const fileMtimeChanged =
        stateMetadata.lastObservedMtimeMs !== fileModifiedAtMs;
      const sourceFileChanged =
        stateMetadata.sourceFilePath !== session.filePath;
      let providerTitleChanged = false;
      if (
        providerTitleUpdate &&
        shouldReplaceProviderTitle(
          stateMetadata.providerTitleSource,
          providerTitleUpdate.source,
        ) &&
        (stateMetadata.providerTitle !== providerTitleUpdate.title ||
          stateMetadata.providerTitleSource !== providerTitleUpdate.source)
      ) {
        stateMetadata.providerTitle = providerTitleUpdate.title;
        stateMetadata.providerTitleSource = providerTitleUpdate.source;
        providerTitleChanged = true;
      }
      if (
        cursorChanged ||
        fileMtimeChanged ||
        sourceFileChanged ||
        workingDirectoryChanged ||
        anchorChanged ||
        providerTitleChanged
      ) {
        stateMetadata.ingestCursor = latestCursor;
        if (nextWorkingDirectory) {
          stateMetadata.workingDirectory = nextWorkingDirectory;
        } else {
          delete stateMetadata.workingDirectory;
        }
        stateMetadata.lastObservedMtimeMs = fileModifiedAtMs;
        stateMetadata.sourceFilePath = session.filePath;
        await this.sessionStateStore.saveSessionMetadata(stateMetadata);
      }

      // Snapshot upserts use the resolved persisted title so a cold snapshot
      // store cannot let an incoming ai title shadow a persisted custom one.
      const snapshotProviderTitle = stateMetadata.providerTitle !== undefined &&
          stateMetadata.providerTitleSource !== undefined
        ? {
          title: stateMetadata.providerTitle,
          source: stateMetadata.providerTitleSource,
        }
        : providerTitleUpdate;

      const shouldHydrateSnapshot = appendedTwinCount > 0 ||
        (!currentSnapshot && twinAvailableForHydration) ||
        cursorChanged ||
        fileMtimeChanged ||
        sourceFileChanged ||
        anchorChanged ||
        providerTitleChanged;
      const shouldHydrateFromTwin = twinAvailableForHydration &&
        !currentSnapshot;

      if (shouldHydrateSnapshot) {
        if (shouldHydrateFromTwin) {
          const twinEvents = await this.sessionStateStore.readTwinEvents(
            stateMetadata,
            1,
          );
          const rebuiltSnapshotEvents = mapTwinEventsToConversation(
            twinEvents,
          );
          const rebuiltMerged = mergeEvents(
            rebuiltSnapshotEvents,
            incomingEvents,
            codexCompactionMergeOptions,
          );
          if (rebuiltMerged.droppedEvents > 0) {
            await this.operationalLogger.debug(
              "provider.ingestion.events_dropped",
              "Provider ingestion dropped duplicate events while rebuilding snapshot from twin history",
              {
                provider: this.provider,
                sessionId,
                droppedEvents: rebuiltMerged.droppedEvents,
                reason: "duplicate-session-twin-snapshot-rebuild",
              },
            );
          }
          if (rebuiltMerged.mergedEvents.length > 0) {
            this.sessionSnapshotStore.upsert({
              provider: this.provider,
              sessionId,
              cursor: latestCursor,
              events: rebuiltMerged.mergedEvents,
              fileModifiedAtMs,
              ...(snippetOverride ? { snippetOverride } : {}),
              ...(snapshotProviderTitle
                ? { providerTitle: snapshotProviderTitle }
                : {}),
            });
          }
        } else if (
          appendedTwinEvents.length > 0 &&
          currentSnapshot?.provider === this.provider
        ) {
          const appendedSnapshotEvents = mapTwinEventsToConversation(
            appendedTwinEvents,
          );
          const merged = mergeEvents(
            currentSnapshot.events,
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
            ...(snapshotProviderTitle
              ? { providerTitle: snapshotProviderTitle }
              : {}),
          });
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
            ...(snapshotProviderTitle
              ? { providerTitle: snapshotProviderTitle }
              : {}),
          });
        }
      }

      this.setCursor(sessionId, latestCursor, session.filePath);
      return {
        updated: shouldHydrateSnapshot || latestOffset !== fromOffset,
        eventsObserved: incomingEvents.length,
      };
    }

    const providerTitleAdvancesSnapshot = providerTitleUpdate !== undefined &&
      currentSnapshot !== undefined &&
      shouldReplaceProviderTitle(
        currentSnapshot.metadata.providerTitleSource,
        providerTitleUpdate.source,
      ) &&
      currentSnapshot.metadata.providerTitle !== providerTitleUpdate.title;
    if (
      incomingEvents.length === 0 && latestOffset === fromOffset &&
      !providerTitleAdvancesSnapshot
    ) {
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
      ...(providerTitleUpdate ? { providerTitle: providerTitleUpdate } : {}),
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
    discoverSessions: (walkRoots) => discoverClaudeSessions(walkRoots),
    describeSessionFile: (filePath) => describeClaudeSessionFile(filePath),
    isSessionFilePath: isJsonlSessionPath,
    parseEvents: (filePath, fromOffset, ctx) =>
      parseClaudeEvents(filePath, fromOffset, {
        ...ctx,
        ...resolveClaudeSessionParseOptions("claude", filePath),
      }),
    sessionSnapshotStore: options.sessionSnapshotStore,
    sessionStateStore: options.sessionStateStore,
    autoGenerateTwins: options.autoGenerateTwins,
    now: options.now,
    discoveryIntervalMs: options.discoveryIntervalMs,
    discoveryTiming: options.discoveryTiming,
    watchDebounceMs: options.watchDebounceMs,
    watchFs: options.watchFs,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
    secretsPolicy: options.secretsPolicy,
  });
}

export function createCodexIngestionRunner(
  options: CreateProviderIngestionRunnerOptions,
): ProviderIngestionRunner {
  const roots = resolveCodexSessionRoots(options.sessionRoots);
  const metaCache: CodexSessionMetaCache = new Map();
  return new FileProviderIngestionRunner({
    provider: "codex",
    watchRoots: roots,
    discoverSessions: (walkRoots) =>
      discoverCodexSessions(walkRoots, metaCache),
    describeSessionFile: (filePath) =>
      describeCodexSessionFile(filePath, metaCache),
    isSessionFilePath: isJsonlSessionPath,
    parseEvents: (filePath, fromOffset, ctx) =>
      parseCodexEvents(filePath, fromOffset, ctx),
    sessionSnapshotStore: options.sessionSnapshotStore,
    sessionStateStore: options.sessionStateStore,
    autoGenerateTwins: options.autoGenerateTwins,
    now: options.now,
    discoveryIntervalMs: options.discoveryIntervalMs,
    discoveryTiming: options.discoveryTiming,
    watchDebounceMs: options.watchDebounceMs,
    watchFs: options.watchFs,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
    secretsPolicy: options.secretsPolicy,
  });
}

export function createGeminiIngestionRunner(
  options: CreateProviderIngestionRunnerOptions,
): ProviderIngestionRunner {
  const roots = resolveGeminiSessionRoots(options.sessionRoots);
  const discoveryCache: GeminiDiscoveryCache = new Map();
  return new FileProviderIngestionRunner({
    provider: "gemini",
    watchRoots: roots,
    discoverSessions: (walkRoots) =>
      discoverGeminiSessions(walkRoots, discoveryCache),
    describeSessionFile: (filePath, root) =>
      describeGeminiSessionFile(filePath, root, discoveryCache),
    isSessionFilePath: isGeminiSessionPath,
    parseEvents: (filePath, fromOffset, ctx) =>
      parseGeminiEvents(filePath, fromOffset, ctx),
    sessionSnapshotStore: options.sessionSnapshotStore,
    sessionStateStore: options.sessionStateStore,
    autoGenerateTwins: options.autoGenerateTwins,
    now: options.now,
    discoveryIntervalMs: options.discoveryIntervalMs,
    discoveryTiming: options.discoveryTiming,
    watchDebounceMs: options.watchDebounceMs,
    watchFs: options.watchFs,
    operationalLogger: options.operationalLogger,
    auditLogger: options.auditLogger,
    secretsPolicy: options.secretsPolicy,
  });
}

export function createDefaultProviderIngestionRunners(
  options: ProviderIngestionFactoryOptions,
): ProviderIngestionRunner[] {
  const resolveAutoGenerateTwins = (
    provider: "claude" | "codex" | "gemini",
  ) =>
    options.providerAutoGenerateTwins?.[provider] ??
      options.globalAutoGenerateTwins ??
      DEFAULT_GLOBAL_AUTO_GENERATE_TWINS;

  return [
    createClaudeIngestionRunner({
      sessionSnapshotStore: options.sessionSnapshotStore,
      sessionStateStore: options.sessionStateStore,
      autoGenerateTwins: resolveAutoGenerateTwins("claude"),
      sessionRoots: options.claudeSessionRoots,
      now: options.now,
      watchDebounceMs: options.watchDebounceMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      discoveryTiming: options.discoveryTiming,
      watchFs: options.watchFs,
      operationalLogger: options.operationalLogger,
      auditLogger: options.auditLogger,
      secretsPolicy: options.secretsPolicy,
    }),
    createCodexIngestionRunner({
      sessionSnapshotStore: options.sessionSnapshotStore,
      sessionStateStore: options.sessionStateStore,
      autoGenerateTwins: resolveAutoGenerateTwins("codex"),
      sessionRoots: options.codexSessionRoots,
      now: options.now,
      watchDebounceMs: options.watchDebounceMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      discoveryTiming: options.discoveryTiming,
      watchFs: options.watchFs,
      operationalLogger: options.operationalLogger,
      auditLogger: options.auditLogger,
      secretsPolicy: options.secretsPolicy,
    }),
    createGeminiIngestionRunner({
      sessionSnapshotStore: options.sessionSnapshotStore,
      sessionStateStore: options.sessionStateStore,
      autoGenerateTwins: resolveAutoGenerateTwins("gemini"),
      sessionRoots: options.geminiSessionRoots,
      now: options.now,
      watchDebounceMs: options.watchDebounceMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      discoveryTiming: options.discoveryTiming,
      watchFs: options.watchFs,
      operationalLogger: options.operationalLogger,
      auditLogger: options.auditLogger,
      secretsPolicy: options.secretsPolicy,
    }),
  ];
}
