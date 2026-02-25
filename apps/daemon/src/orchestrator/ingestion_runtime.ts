import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import { utf8ByteLength } from "../utils/text.ts";

export interface SessionSnapshotStatusMetadata {
  updatedAt: string;
  eventCount: number;
  truncatedEvents: number;
  lastEventAt?: string;
  /** File mtime in milliseconds when the session was last ingested. */
  fileModifiedAtMs?: number;
}

export interface RuntimeSessionSnapshot {
  provider: string;
  sessionId: string;
  cursor: ProviderCursor;
  events: ConversationEvent[];
  conversationSchemaVersion: 2;
  metadata: SessionSnapshotStatusMetadata;
}

export interface SessionSnapshotUpsert {
  provider: string;
  sessionId: string;
  cursor: ProviderCursor;
  events: ConversationEvent[];
  fileModifiedAtMs?: number;
}

export interface SessionSnapshotStore {
  upsert(snapshot: SessionSnapshotUpsert): RuntimeSessionSnapshot;
  get(sessionId: string): RuntimeSessionSnapshot | undefined;
  list(): RuntimeSessionSnapshot[];
  getMemoryStats?(): SnapshotMemoryStats;
}

export interface ProviderIngestionPollResult {
  provider: string;
  polledAt: string;
  sessionsUpdated: number;
  eventsObserved: number;
}

export interface ProviderIngestionRunner {
  readonly provider: string;
  start(): Promise<void>;
  poll(): Promise<ProviderIngestionPollResult>;
  stop(): Promise<void>;
}

export interface SessionSnapshotStoreRetentionPolicy {
  maxSessions: number;
  maxEventsPerSession: number;
}

export const DEFAULT_SESSION_SNAPSHOT_RETENTION_POLICY:
  SessionSnapshotStoreRetentionPolicy = {
    maxSessions: 200,
    maxEventsPerSession: 10000,
  };

export interface InMemorySessionSnapshotStoreOptions {
  retention?: Partial<SessionSnapshotStoreRetentionPolicy>;
  daemonMaxMemoryMb?: number;
  now?: () => Date;
}

export interface SnapshotMemoryStats {
  estimatedBytes: number;
  sessionCount: number;
  eventCount: number;
  evictionsTotal: number;
  bytesReclaimedTotal: number;
  evictionsByReason: Record<string, number>;
  overBudget: boolean;
}

export class SessionSnapshotMemoryBudgetExceededError extends Error {
  readonly sessionId: string;
  readonly estimatedBytes: number;
  readonly daemonMaxMemoryBytes: number;

  constructor(
    sessionId: string,
    estimatedBytes: number,
    daemonMaxMemoryBytes: number,
  ) {
    super(
      `Session '${sessionId}' exceeds daemon memory budget (${estimatedBytes} > ${daemonMaxMemoryBytes})`,
    );
    this.name = "SessionSnapshotMemoryBudgetExceededError";
    this.sessionId = sessionId;
    this.estimatedBytes = estimatedBytes;
    this.daemonMaxMemoryBytes = daemonMaxMemoryBytes;
  }
}

function cloneSnapshot(
  snapshot: RuntimeSessionSnapshot,
): RuntimeSessionSnapshot {
  return structuredClone(snapshot);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function resolveRetentionPolicy(
  retention?: Partial<SessionSnapshotStoreRetentionPolicy>,
): SessionSnapshotStoreRetentionPolicy {
  const maxSessions = retention?.maxSessions ??
    DEFAULT_SESSION_SNAPSHOT_RETENTION_POLICY.maxSessions;
  const maxEventsPerSession = retention?.maxEventsPerSession ??
    DEFAULT_SESSION_SNAPSHOT_RETENTION_POLICY.maxEventsPerSession;

  if (!isPositiveSafeInteger(maxSessions)) {
    throw new Error("Session snapshot retention maxSessions must be > 0");
  }
  if (!isPositiveSafeInteger(maxEventsPerSession)) {
    throw new Error(
      "Session snapshot retention maxEventsPerSession must be > 0",
    );
  }

  return {
    maxSessions,
    maxEventsPerSession,
  };
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Session snapshot ${fieldName} must be non-empty`);
  }
  return value;
}

function readLastEventAt(events: ConversationEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const timestamp = events[i]?.timestamp;
    if (typeof timestamp === "string" && timestamp.length > 0) {
      return timestamp;
    }
  }
  return undefined;
}

export class InMemorySessionSnapshotStore implements SessionSnapshotStore {
  private readonly retention: SessionSnapshotStoreRetentionPolicy;
  private readonly now: () => Date;
  private readonly snapshots = new Map<string, RuntimeSessionSnapshot>();
  private readonly snapshotSizes = new Map<string, number>();

  private readonly daemonMaxMemoryBytes: number;
  private currentEstimatedBytes = 0;
  private currentEventCount = 0;
  private evictionsTotal = 0;
  private bytesReclaimedTotal = 0;
  private evictionsByReason: Record<string, number> = {};
  private isOverBudget = false;

  constructor(options: InMemorySessionSnapshotStoreOptions = {}) {
    this.retention = resolveRetentionPolicy(options.retention);
    const daemonMaxMemoryMb = options.daemonMaxMemoryMb ?? 200;
    if (!isPositiveSafeInteger(daemonMaxMemoryMb)) {
      throw new Error("Session snapshot daemonMaxMemoryMb must be > 0");
    }
    this.daemonMaxMemoryBytes = daemonMaxMemoryMb * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  getMemoryStats(): SnapshotMemoryStats {
    return {
      estimatedBytes: this.currentEstimatedBytes,
      sessionCount: this.snapshots.size,
      eventCount: this.currentEventCount,
      evictionsTotal: this.evictionsTotal,
      bytesReclaimedTotal: this.bytesReclaimedTotal,
      evictionsByReason: { ...this.evictionsByReason },
      overBudget: this.isOverBudget,
    };
  }

  private estimateSnapshotBytes(snapshot: RuntimeSessionSnapshot): number {
    return utf8ByteLength(JSON.stringify(snapshot));
  }

  private recordEviction(reason: string, bytes: number) {
    this.evictionsTotal++;
    this.bytesReclaimedTotal += bytes;
    this.evictionsByReason[reason] = (this.evictionsByReason[reason] ?? 0) + 1;
  }

  upsert(input: SessionSnapshotUpsert): RuntimeSessionSnapshot {
    const provider = requireNonEmpty(input.provider, "provider");
    const sessionId = requireNonEmpty(input.sessionId, "sessionId");
    const retainedEvents = input.events.slice(
      -this.retention.maxEventsPerSession,
    );
    const truncatedEvents = Math.max(
      0,
      input.events.length - retainedEvents.length,
    );
    const updatedAt = this.now().toISOString();
    const lastEventAt = readLastEventAt(retainedEvents);

    const snapshot: RuntimeSessionSnapshot = {
      provider,
      sessionId,
      cursor: structuredClone(input.cursor),
      events: structuredClone(retainedEvents),
      conversationSchemaVersion: 2,
      metadata: {
        updatedAt,
        eventCount: retainedEvents.length,
        truncatedEvents,
        ...(lastEventAt ? { lastEventAt } : {}),
        ...(input.fileModifiedAtMs !== undefined
          ? { fileModifiedAtMs: input.fileModifiedAtMs }
          : {}),
      },
    };

    if (this.snapshots.has(sessionId)) {
      const oldSize = this.snapshotSizes.get(sessionId) ?? 0;
      const oldSnapshot = this.snapshots.get(sessionId)!;
      this.currentEstimatedBytes -= oldSize;
      this.currentEventCount -= oldSnapshot.events.length;
      this.snapshots.delete(sessionId);
      this.snapshotSizes.delete(sessionId);
    }

    const newSize = this.estimateSnapshotBytes(snapshot);
    this.snapshots.set(sessionId, snapshot);
    this.snapshotSizes.set(sessionId, newSize);
    this.currentEstimatedBytes += newSize;
    this.currentEventCount += retainedEvents.length;

    this.enforceBudget();

    return cloneSnapshot(snapshot);
  }

  get(sessionId: string): RuntimeSessionSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return undefined;
    }
    return cloneSnapshot(snapshot);
  }

  list(): RuntimeSessionSnapshot[] {
    const snapshots = Array.from(this.snapshots.values(), cloneSnapshot);
    snapshots.reverse();
    return snapshots;
  }

  private enforceBudget(): void {
    // 1. Enforce max sessions first
    while (this.snapshots.size > this.retention.maxSessions) {
      const oldestSessionId = this.snapshots.keys().next().value;
      if (typeof oldestSessionId !== "string") {
        break;
      }
      this.evict(oldestSessionId, "max_sessions");
    }

    // 2. Enforce memory budget
    while (
      this.currentEstimatedBytes > this.daemonMaxMemoryBytes &&
      this.snapshots.size > 0
    ) {
      if (this.snapshots.size === 1) {
        this.isOverBudget = true;
        const overBudgetSessionId = this.snapshots.keys().next().value;
        throw new SessionSnapshotMemoryBudgetExceededError(
          typeof overBudgetSessionId === "string"
            ? overBudgetSessionId
            : "unknown-session",
          this.currentEstimatedBytes,
          this.daemonMaxMemoryBytes,
        );
      }

      const oldestSessionId = this.snapshots.keys().next().value;
      if (typeof oldestSessionId !== "string") {
        break;
      }
      this.evict(oldestSessionId, "memory_pressure");
    }

    this.isOverBudget = this.currentEstimatedBytes > this.daemonMaxMemoryBytes;
  }

  private evict(sessionId: string, reason: string) {
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      return;
    }
    const size = this.snapshotSizes.get(sessionId) ?? 0;

    this.snapshots.delete(sessionId);
    this.snapshotSizes.delete(sessionId);
    this.currentEstimatedBytes -= size;
    this.currentEventCount -= snapshot.events.length;

    this.recordEviction(reason, size);
  }
}
