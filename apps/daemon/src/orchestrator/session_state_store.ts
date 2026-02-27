import type {
  DaemonControlIndexV1,
  DaemonControlSessionIndexEntryV1,
  ProviderCursor,
  SessionMetadataV1,
  SessionTwinEventV1,
} from "@kato/shared";
import {
  DAEMON_CONTROL_SCHEMA_VERSION,
  isDaemonControlIndexV1,
  isSessionMetadataV1,
  isSessionTwinEventV1,
  SESSION_METADATA_SCHEMA_VERSION,
} from "@kato/shared";
import { dirname, join } from "@std/path";
import { resolveHomeDir } from "../utils/env.ts";
import { hashStringFNV1a, stableStringify } from "../utils/hash.ts";

const DEFAULT_KATO_DIRNAME = ".kato";
const DEFAULT_SESSIONS_DIRNAME = "sessions";
const DEFAULT_DAEMON_CONTROL_FILENAME = "daemon-control.json";
const SESSION_META_SUFFIX = ".meta.json";
const SESSION_TWIN_SUFFIX = ".twin.jsonl";
const DEFAULT_RECENT_FINGERPRINT_LIMIT = 512;
const UTF8_ENCODER = new TextEncoder();

export interface SessionStateIdentity {
  provider: string;
  providerSessionId: string;
}

export interface SessionStateLocation {
  sessionKey: string;
  metadataPath: string;
  twinPath: string;
}

export interface GetOrCreateSessionMetadataInput extends SessionStateIdentity {
  sourceFilePath: string;
  initialCursor: ProviderCursor;
}

export interface PersistentSessionStateStoreOptions {
  katoDir?: string;
  daemonControlIndexPath?: string;
  sessionsDir?: string;
  now?: () => Date;
  makeSessionId?: () => string;
  recentFingerprintLimit?: number;
}

export interface SaveSessionMetadataOptions {
  touchUpdatedAt?: boolean;
}

export interface AppendTwinEventsOptions {
  touchUpdatedAt?: boolean;
}

interface TwinAppendResult {
  appended: SessionTwinEventV1[];
  droppedAsDuplicate: number;
}

export type SessionStateLoadFailureReason =
  | "invalid_json"
  | "unsupported_schema";

export class SessionStateLoadError extends Error {
  readonly reason: SessionStateLoadFailureReason;
  readonly metadataPath: string;

  constructor(
    reason: SessionStateLoadFailureReason,
    metadataPath: string,
    message?: string,
  ) {
    super(
      message ?? `Session metadata load failed (${reason}): ${metadataPath}`,
    );
    this.name = "SessionStateLoadError";
    this.reason = reason;
    this.metadataPath = metadataPath;
  }
}

export function resolveDefaultKatoDir(): string {
  const home = resolveHomeDir();
  if (home) {
    return join(home, DEFAULT_KATO_DIRNAME);
  }
  return DEFAULT_KATO_DIRNAME;
}

export function resolveDefaultSessionsDir(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, DEFAULT_SESSIONS_DIRNAME);
}

export function resolveDefaultDaemonControlIndexPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, DEFAULT_DAEMON_CONTROL_FILENAME);
}

function cloneCursor(cursor: ProviderCursor): ProviderCursor {
  return { ...cursor };
}

function cloneSessionMetadata(metadata: SessionMetadataV1): SessionMetadataV1 {
  return {
    schemaVersion: metadata.schemaVersion,
    sessionKey: metadata.sessionKey,
    provider: metadata.provider,
    providerSessionId: metadata.providerSessionId,
    sessionId: metadata.sessionId,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    sourceFilePath: metadata.sourceFilePath,
    ...(metadata.lastObservedMtimeMs !== undefined
      ? { lastObservedMtimeMs: metadata.lastObservedMtimeMs }
      : {}),
    ingestCursor: cloneCursor(metadata.ingestCursor),
    ...(metadata.ingestAnchor
      ? { ingestAnchor: { ...metadata.ingestAnchor } }
      : {}),
    twinPath: metadata.twinPath,
    nextTwinSeq: metadata.nextTwinSeq,
    recentFingerprints: [...metadata.recentFingerprints],
    ...(metadata.commandCursor !== undefined
      ? { commandCursor: metadata.commandCursor }
      : {}),
    recordings: metadata.recordings.map((recording) => ({
      recordingId: recording.recordingId,
      destination: recording.destination,
      desiredState: recording.desiredState,
      writeCursor: recording.writeCursor,
      ...(recording.createdAt ? { createdAt: recording.createdAt } : {}),
      periods: recording.periods.map((period) => ({ ...period })),
    })),
  };
}

function sanitizeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function toSessionKey(identity: SessionStateIdentity): string {
  return `${identity.provider}:${identity.providerSessionId}`;
}

function toStorageKey(identity: SessionStateIdentity): string {
  return `${sanitizeKeyPart(identity.provider)}:${
    sanitizeKeyPart(identity.providerSessionId)
  }`;
}

function toSessionFilePaths(
  sessionsDir: string,
  identity: SessionStateIdentity,
): { metadataPath: string; twinPath: string } {
  const storageKey = toStorageKey(identity);
  return {
    metadataPath: join(sessionsDir, `${storageKey}${SESSION_META_SUFFIX}`),
    twinPath: join(sessionsDir, `${storageKey}${SESSION_TWIN_SUFFIX}`),
  };
}

function makeSessionShortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function writeTextAtomically(
  path: string,
  content: string,
): Promise<void> {
  await ensureDir(dirname(path));
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(tmpPath, {
      create: true,
      write: true,
      truncate: true,
    });
    await file.write(UTF8_ENCODER.encode(content));
    await file.sync();
  } finally {
    file?.close();
  }
  try {
    await Deno.rename(tmpPath, path);
  } catch (error) {
    try {
      await Deno.remove(tmpPath);
    } catch {
      // Best-effort cleanup; preserve the original rename failure.
    }
    throw error;
  }
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

function asCursorForProvider(provider: string): ProviderCursor {
  if (provider === "gemini") {
    return { kind: "item-index", value: 0 };
  }
  return { kind: "byte-offset", value: 0 };
}

function buildTwinFingerprint(event: SessionTwinEventV1): string {
  const source = event.source;
  const cursorKey = `${source.cursor.kind}:${String(source.cursor.value)}`;
  const primary = [
    event.session.provider,
    event.session.providerSessionId,
    cursorKey,
    String(source.emitIndex),
    event.kind,
    source.providerEventType,
    source.providerEventId ?? "",
  ].join("\u0000");

  const payloadHash = hashStringFNV1a(stableStringify({
    kind: event.kind,
    payload: event.payload,
    turnId: event.turnId,
    model: event.model,
  }));
  return `${primary}\u0000h:${payloadHash}`;
}

function cloneSessionTwinEvent(event: SessionTwinEventV1): SessionTwinEventV1 {
  return structuredClone(event);
}

function cloneDaemonControlIndex(
  index: DaemonControlIndexV1,
): DaemonControlIndexV1 {
  return {
    schemaVersion: index.schemaVersion,
    updatedAt: index.updatedAt,
    sessions: index.sessions.map((entry) => ({ ...entry })),
  };
}

export class PersistentSessionStateStore {
  private readonly daemonControlIndexPath: string;
  private readonly sessionsDir: string;
  private readonly now: () => Date;
  private readonly makeSessionId: () => string;
  private readonly recentFingerprintLimit: number;
  private readonly metadataCache = new Map<string, SessionMetadataV1>();
  private daemonIndexCache: DaemonControlIndexV1 | undefined;

  constructor(options: PersistentSessionStateStoreOptions = {}) {
    const katoDir = options.katoDir ?? resolveDefaultKatoDir();
    this.daemonControlIndexPath = options.daemonControlIndexPath ??
      resolveDefaultDaemonControlIndexPath(katoDir);
    this.sessionsDir = options.sessionsDir ??
      resolveDefaultSessionsDir(katoDir);
    this.now = options.now ?? (() => new Date());
    this.makeSessionId = options.makeSessionId ?? (() => crypto.randomUUID());
    this.recentFingerprintLimit = options.recentFingerprintLimit ??
      DEFAULT_RECENT_FINGERPRINT_LIMIT;
  }

  resolveLocation(identity: SessionStateIdentity): SessionStateLocation {
    const sessionKey = toSessionKey(identity);
    const paths = toSessionFilePaths(this.sessionsDir, identity);
    return {
      sessionKey,
      metadataPath: paths.metadataPath,
      twinPath: paths.twinPath,
    };
  }

  async getOrCreateSessionMetadata(
    input: GetOrCreateSessionMetadataInput,
  ): Promise<SessionMetadataV1> {
    const sessionKey = toSessionKey(input);
    const cached = this.metadataCache.get(sessionKey);
    if (cached) {
      return cloneSessionMetadata(cached);
    }

    const { metadataPath, twinPath } = toSessionFilePaths(
      this.sessionsDir,
      input,
    );
    const existing = await this.loadMetadataFromDisk(metadataPath);
    if (existing) {
      this.metadataCache.set(sessionKey, existing);
      return cloneSessionMetadata(existing);
    }

    const nowIso = this.now().toISOString();
    const created: SessionMetadataV1 = {
      schemaVersion: SESSION_METADATA_SCHEMA_VERSION,
      sessionKey,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      sessionId: this.makeSessionId(),
      createdAt: nowIso,
      updatedAt: nowIso,
      sourceFilePath: input.sourceFilePath,
      ingestCursor: cloneCursor(input.initialCursor),
      twinPath,
      nextTwinSeq: 1,
      recentFingerprints: [],
      commandCursor: 0,
      recordings: [],
    };

    await ensureDir(this.sessionsDir);
    await writeJsonAtomically(metadataPath, created);
    await this.upsertDaemonControlEntry({
      sessionKey: created.sessionKey,
      provider: created.provider,
      providerSessionId: created.providerSessionId,
      sessionId: created.sessionId,
      sessionShortId: makeSessionShortId(created.sessionId),
      metadataPath,
      twinPath,
      updatedAt: created.updatedAt,
    });
    this.metadataCache.set(sessionKey, created);
    return cloneSessionMetadata(created);
  }

  async saveSessionMetadata(
    metadata: SessionMetadataV1,
    options: SaveSessionMetadataOptions = {},
  ): Promise<void> {
    const cloned = cloneSessionMetadata(metadata);
    if (options.touchUpdatedAt) {
      cloned.updatedAt = this.now().toISOString();
    }
    const location = this.resolveLocation({
      provider: cloned.provider,
      providerSessionId: cloned.providerSessionId,
    });
    await writeJsonAtomically(location.metadataPath, cloned);
    this.metadataCache.set(cloned.sessionKey, cloned);
    await this.upsertDaemonControlEntry({
      sessionKey: cloned.sessionKey,
      provider: cloned.provider,
      providerSessionId: cloned.providerSessionId,
      sessionId: cloned.sessionId,
      sessionShortId: makeSessionShortId(cloned.sessionId),
      metadataPath: location.metadataPath,
      twinPath: cloned.twinPath,
      updatedAt: cloned.updatedAt,
    });
  }

  async listSessionMetadata(): Promise<SessionMetadataV1[]> {
    const index = await this.loadDaemonControlIndex();
    const items: SessionMetadataV1[] = [];
    for (const entry of index.sessions) {
      let metadata: SessionMetadataV1 | undefined;
      try {
        metadata = await this.loadMetadataFromDisk(entry.metadataPath);
      } catch (error) {
        if (error instanceof SessionStateLoadError) {
          continue;
        }
        throw error;
      }
      if (!metadata) {
        continue;
      }
      this.metadataCache.set(metadata.sessionKey, metadata);
      items.push(cloneSessionMetadata(metadata));
    }
    return items;
  }

  async appendTwinEvents(
    metadata: SessionMetadataV1,
    events: SessionTwinEventV1[],
    options: AppendTwinEventsOptions = {},
  ): Promise<TwinAppendResult> {
    if (events.length === 0) {
      return { appended: [], droppedAsDuplicate: 0 };
    }
    const current = await this.getOrCreateSessionMetadata({
      provider: metadata.provider,
      providerSessionId: metadata.providerSessionId,
      sourceFilePath: metadata.sourceFilePath,
      initialCursor: metadata.ingestCursor,
    });

    const fingerprints = new Set(current.recentFingerprints);
    const appended: SessionTwinEventV1[] = [];
    let droppedAsDuplicate = 0;
    let nextSeq = current.nextTwinSeq;
    const lines: string[] = [];

    for (const incoming of events) {
      const event: SessionTwinEventV1 = {
        ...cloneSessionTwinEvent(incoming),
        schemaVersion: 1,
        seq: nextSeq,
      };
      const fingerprint = buildTwinFingerprint(event);
      if (fingerprints.has(fingerprint)) {
        droppedAsDuplicate += 1;
        continue;
      }
      fingerprints.add(fingerprint);
      current.recentFingerprints.push(fingerprint);
      appended.push(event);
      lines.push(JSON.stringify(event));
      nextSeq += 1;
    }

    if (lines.length > 0) {
      await ensureDir(dirname(current.twinPath));
      const text = `${lines.join("\n")}\n`;
      const file = await Deno.open(current.twinPath, {
        create: true,
        append: true,
        write: true,
      });
      try {
        await file.write(UTF8_ENCODER.encode(text));
        await file.sync();
      } finally {
        file.close();
      }
    }

    if (appended.length > 0) {
      if (current.recentFingerprints.length > this.recentFingerprintLimit) {
        current.recentFingerprints = current.recentFingerprints.slice(
          -this.recentFingerprintLimit,
        );
      }
      current.nextTwinSeq = nextSeq;
      await this.saveSessionMetadata(current, {
        touchUpdatedAt: options.touchUpdatedAt,
      });
    }

    return { appended, droppedAsDuplicate };
  }

  async readTwinEvents(
    metadata: SessionMetadataV1,
    fromSeq: number = 1,
  ): Promise<SessionTwinEventV1[]> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(metadata.twinPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    const events: SessionTwinEventV1[] = [];
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isSessionTwinEventV1(parsed)) {
        continue;
      }
      if (parsed.seq < fromSeq) {
        continue;
      }
      events.push(parsed);
    }
    return events;
  }

  async loadDaemonControlIndex(): Promise<DaemonControlIndexV1> {
    if (this.daemonIndexCache) {
      return cloneDaemonControlIndex(this.daemonIndexCache);
    }

    let raw: string | undefined;
    try {
      raw = await Deno.readTextFile(this.daemonControlIndexPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (isDaemonControlIndexV1(parsed)) {
          this.daemonIndexCache = parsed;
          return cloneDaemonControlIndex(parsed);
        }
      } catch {
        // rebuild below
      }
    }

    const rebuilt = await this.rebuildDaemonControlIndex();
    this.daemonIndexCache = rebuilt;
    return cloneDaemonControlIndex(rebuilt);
  }

  async rebuildDaemonControlIndex(): Promise<DaemonControlIndexV1> {
    const sessions: DaemonControlSessionIndexEntryV1[] = [];
    await ensureDir(this.sessionsDir);
    for await (const entry of Deno.readDir(this.sessionsDir)) {
      if (!entry.isFile || !entry.name.endsWith(SESSION_META_SUFFIX)) {
        continue;
      }
      const metadataPath = join(this.sessionsDir, entry.name);
      let metadata: SessionMetadataV1 | undefined;
      try {
        metadata = await this.loadMetadataFromDisk(metadataPath);
      } catch (error) {
        if (error instanceof SessionStateLoadError) {
          continue;
        }
        throw error;
      }
      if (!metadata) {
        continue;
      }
      this.metadataCache.set(metadata.sessionKey, metadata);
      sessions.push({
        sessionKey: metadata.sessionKey,
        provider: metadata.provider,
        providerSessionId: metadata.providerSessionId,
        sessionId: metadata.sessionId,
        sessionShortId: makeSessionShortId(metadata.sessionId),
        metadataPath,
        twinPath: metadata.twinPath,
        updatedAt: metadata.updatedAt,
      });
    }

    sessions.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
    const rebuilt: DaemonControlIndexV1 = {
      schemaVersion: DAEMON_CONTROL_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      sessions,
    };
    await writeJsonAtomically(this.daemonControlIndexPath, rebuilt);
    this.daemonIndexCache = rebuilt;
    return rebuilt;
  }

  async deleteSessionTwinFiles(): Promise<{ deleted: number; failed: number }> {
    const metadata = await this.listSessionMetadata();
    let deleted = 0;
    let failed = 0;

    for (const session of metadata) {
      try {
        await Deno.remove(session.twinPath);
        deleted += 1;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          continue;
        }
        console.error(
          `failed to remove session twin file '${session.twinPath}':`,
          error,
        );
        failed += 1;
      }
    }

    return { deleted, failed };
  }

  private async loadMetadataFromDisk(
    metadataPath: string,
  ): Promise<SessionMetadataV1 | undefined> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(metadataPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new SessionStateLoadError(
        "invalid_json",
        metadataPath,
        `Session metadata file contains invalid JSON: ${metadataPath}`,
      );
    }
    if (!isSessionMetadataV1(parsed)) {
      throw new SessionStateLoadError(
        "unsupported_schema",
        metadataPath,
        `Session metadata file has unsupported schema: ${metadataPath}`,
      );
    }
    return parsed;
  }

  private async upsertDaemonControlEntry(
    entry: DaemonControlSessionIndexEntryV1,
  ): Promise<void> {
    const index = await this.loadDaemonControlIndex();
    const existingIdx = index.sessions.findIndex((item) =>
      item.sessionKey === entry.sessionKey
    );
    if (existingIdx >= 0) {
      index.sessions[existingIdx] = { ...entry };
    } else {
      index.sessions.push({ ...entry });
    }
    index.sessions.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
    index.updatedAt = this.now().toISOString();
    await writeJsonAtomically(this.daemonControlIndexPath, index);
    this.daemonIndexCache = index;
  }
}

export function makeDefaultSessionCursor(provider: string): ProviderCursor {
  return asCursorForProvider(provider);
}
