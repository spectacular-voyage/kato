import type { Message, ProviderCursor } from "@kato/shared";

export interface SessionSnapshotStatusMetadata {
  updatedAt: string;
  messageCount: number;
  truncatedMessages: number;
  lastMessageAt?: string;
}

export interface RuntimeSessionSnapshot {
  provider: string;
  sessionId: string;
  cursor: ProviderCursor;
  messages: Message[];
  metadata: SessionSnapshotStatusMetadata;
}

export interface SessionSnapshotUpsert {
  provider: string;
  sessionId: string;
  cursor: ProviderCursor;
  messages: Message[];
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
  messagesObserved: number;
}

export interface ProviderIngestionRunner {
  readonly provider: string;
  start(): Promise<void>;
  poll(): Promise<ProviderIngestionPollResult>;
  stop(): Promise<void>;
}

export interface SessionSnapshotStoreRetentionPolicy {
  maxSessions: number;
  maxMessagesPerSession: number;
}

export const DEFAULT_SESSION_SNAPSHOT_RETENTION_POLICY:
  SessionSnapshotStoreRetentionPolicy = {
    maxSessions: 200,
    maxMessagesPerSession: 200,
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
  const maxMessagesPerSession = retention?.maxMessagesPerSession ??
    DEFAULT_SESSION_SNAPSHOT_RETENTION_POLICY.maxMessagesPerSession;

  if (!isPositiveSafeInteger(maxSessions)) {
    throw new Error("Session snapshot retention maxSessions must be > 0");
  }
  if (!isPositiveSafeInteger(maxMessagesPerSession)) {
    throw new Error(
      "Session snapshot retention maxMessagesPerSession must be > 0",
    );
  }

  return {
    maxSessions,
    maxMessagesPerSession,
  };
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Session snapshot ${fieldName} must be non-empty`);
  }
  return value;
}

function readLastMessageAt(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const timestamp = messages[i]?.timestamp;
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
    const retainedMessages = input.messages.slice(
      -this.retention.maxMessagesPerSession,
    );
    const truncatedMessages = Math.max(
      0,
      input.messages.length - retainedMessages.length,
    );
    const updatedAt = this.now().toISOString();
    const lastMessageAt = readLastMessageAt(retainedMessages);

    const snapshot: RuntimeSessionSnapshot = {
      provider,
      sessionId,
      cursor: structuredClone(input.cursor),
      messages: structuredClone(retainedMessages),
      metadata: {
        updatedAt,
        messageCount: retainedMessages.length,
        truncatedMessages,
        ...(lastMessageAt ? { lastMessageAt } : {}),
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
