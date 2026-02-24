import type { ConversationEvent, ProviderCursor } from "@kato/shared";

export interface SessionSnapshotStatusMetadata {
  updatedAt: string;
  eventCount: number;
  truncatedEvents: number;
  lastEventAt?: string;
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
}

export interface SessionSnapshotStore {
  upsert(snapshot: SessionSnapshotUpsert): RuntimeSessionSnapshot;
  get(sessionId: string): RuntimeSessionSnapshot | undefined;
  list(): RuntimeSessionSnapshot[];
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
    maxEventsPerSession: 200,
  };

export interface InMemorySessionSnapshotStoreOptions {
  retention?: Partial<SessionSnapshotStoreRetentionPolicy>;
  now?: () => Date;
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

  constructor(options: InMemorySessionSnapshotStoreOptions = {}) {
    this.retention = resolveRetentionPolicy(options.retention);
    this.now = options.now ?? (() => new Date());
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
      },
    };

    if (this.snapshots.has(sessionId)) {
      this.snapshots.delete(sessionId);
    }
    this.snapshots.set(sessionId, snapshot);
    this.enforceSessionCap();

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

  private enforceSessionCap(): void {
    while (this.snapshots.size > this.retention.maxSessions) {
      const oldestSessionId = this.snapshots.keys().next().value;
      if (typeof oldestSessionId !== "string") {
        return;
      }
      this.snapshots.delete(oldestSessionId);
    }
  }
}
