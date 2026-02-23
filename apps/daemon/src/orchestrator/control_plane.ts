import type { DaemonStatusSnapshot } from "@kato/shared";
import { dirname, join } from "@std/path";

const DEFAULT_RUNTIME_DIR_FALLBACK = ".kato/runtime";
const DEFAULT_KATO_DIRNAME = ".kato";
const DEFAULT_RUNTIME_SUBDIR = "runtime";
const STATUS_FILENAME = "status.json";
const CONTROL_FILENAME = "control.json";
const STATUS_SCHEMA_VERSION = 1;
const CONTROL_SCHEMA_VERSION = 1;
const MAX_CONTROL_QUEUE_LENGTH = 10_000;
const DEFAULT_STALE_HEARTBEAT_THRESHOLD_MS = 30_000;

export type DaemonControlCommand = "start" | "stop" | "export" | "clean";

export interface DaemonControlRequestDraft {
  command: DaemonControlCommand;
  payload?: Record<string, unknown>;
}

export interface DaemonControlRequest extends DaemonControlRequestDraft {
  requestId: string;
  requestedAt: string;
}

interface DaemonControlQueueDocument {
  schemaVersion: number;
  requests: DaemonControlRequest[];
  lastProcessedRequestId?: string;
}

export interface DaemonStatusSnapshotStoreLike {
  load(): Promise<DaemonStatusSnapshot>;
  save(snapshot: DaemonStatusSnapshot): Promise<void>;
}

export interface DaemonControlRequestStoreLike {
  list(): Promise<DaemonControlRequest[]>;
  enqueue(request: DaemonControlRequestDraft): Promise<DaemonControlRequest>;
  markProcessed(requestId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderStatus(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value["provider"] !== "string") {
    return false;
  }
  if (
    typeof value["activeSessions"] !== "number" ||
    !Number.isFinite(value["activeSessions"]) ||
    value["activeSessions"] < 0
  ) {
    return false;
  }

  const lastMessageAt = value["lastMessageAt"];
  if (lastMessageAt !== undefined && typeof lastMessageAt !== "string") {
    return false;
  }

  return true;
}

function isRecordingStatus(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value["activeRecordings"] !== "number" ||
    !Number.isFinite(value["activeRecordings"]) ||
    value["activeRecordings"] < 0
  ) {
    return false;
  }
  if (
    typeof value["destinations"] !== "number" ||
    !Number.isFinite(value["destinations"]) ||
    value["destinations"] < 0
  ) {
    return false;
  }
  return true;
}

function isDaemonStatusSnapshot(value: unknown): value is DaemonStatusSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  if (value["schemaVersion"] !== STATUS_SCHEMA_VERSION) {
    return false;
  }
  if (typeof value["generatedAt"] !== "string") {
    return false;
  }
  if (typeof value["heartbeatAt"] !== "string") {
    return false;
  }
  if (typeof value["daemonRunning"] !== "boolean") {
    return false;
  }
  if (
    value["daemonPid"] !== undefined && typeof value["daemonPid"] !== "number"
  ) {
    return false;
  }
  if (
    !Array.isArray(value["providers"]) ||
    !value["providers"].every(isProviderStatus)
  ) {
    return false;
  }
  if (!isRecordingStatus(value["recordings"])) {
    return false;
  }
  return true;
}

function isDaemonControlRequest(value: unknown): value is DaemonControlRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value["requestId"] !== "string") {
    return false;
  }
  if (typeof value["requestedAt"] !== "string") {
    return false;
  }

  const command = value["command"];
  if (
    command !== "start" &&
    command !== "stop" &&
    command !== "export" &&
    command !== "clean"
  ) {
    return false;
  }

  const payload = value["payload"];
  if (payload !== undefined && !isRecord(payload)) {
    return false;
  }

  return true;
}

function isDaemonControlQueueDocument(
  value: unknown,
): value is DaemonControlQueueDocument {
  if (!isRecord(value)) {
    return false;
  }
  if (value["schemaVersion"] !== CONTROL_SCHEMA_VERSION) {
    return false;
  }
  if (
    !Array.isArray(value["requests"]) ||
    !value["requests"].every(isDaemonControlRequest)
  ) {
    return false;
  }

  const lastProcessedRequestId = value["lastProcessedRequestId"];
  if (
    lastProcessedRequestId !== undefined &&
    typeof lastProcessedRequestId !== "string"
  ) {
    return false;
  }
  return true;
}

function cloneRequest(request: DaemonControlRequest): DaemonControlRequest {
  return {
    requestId: request.requestId,
    requestedAt: request.requestedAt,
    command: request.command,
    ...(request.payload ? { payload: { ...request.payload } } : {}),
  };
}

function readEnvOptional(key: string): string | undefined {
  try {
    const value = Deno.env.get(key);
    if (value === undefined || value.length === 0) {
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

async function writeJsonAtomically(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true });

  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmpPath, JSON.stringify(data, null, 2));
  await Deno.rename(tmpPath, path);
}

export function createDefaultStatusSnapshot(
  now: Date = new Date(),
): DaemonStatusSnapshot {
  const nowIso = now.toISOString();
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: nowIso,
    heartbeatAt: nowIso,
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };
}

export function isStatusSnapshotStale(
  snapshot: DaemonStatusSnapshot,
  now: Date = new Date(),
  staleHeartbeatThresholdMs: number = DEFAULT_STALE_HEARTBEAT_THRESHOLD_MS,
): boolean {
  if (!snapshot.daemonRunning) {
    return false;
  }

  const heartbeatTimeMs = Date.parse(snapshot.heartbeatAt);
  if (!Number.isFinite(heartbeatTimeMs)) {
    return true;
  }

  return now.getTime() - heartbeatTimeMs > staleHeartbeatThresholdMs;
}

export function resolveDefaultRuntimeDir(): string {
  const runtimeDirOverride = readEnvOptional("KATO_RUNTIME_DIR");
  if (runtimeDirOverride) {
    return runtimeDirOverride;
  }

  const homeDir = resolveHomeDir();
  if (homeDir) {
    return join(homeDir, DEFAULT_KATO_DIRNAME, DEFAULT_RUNTIME_SUBDIR);
  }

  return DEFAULT_RUNTIME_DIR_FALLBACK;
}

export function resolveDefaultStatusPath(
  runtimeDir = resolveDefaultRuntimeDir(),
): string {
  return readEnvOptional("KATO_DAEMON_STATUS_PATH") ??
    join(runtimeDir, STATUS_FILENAME);
}

export function resolveDefaultControlPath(
  runtimeDir = resolveDefaultRuntimeDir(),
): string {
  return readEnvOptional("KATO_DAEMON_CONTROL_PATH") ??
    join(runtimeDir, CONTROL_FILENAME);
}

export class DaemonStatusSnapshotFileStore
  implements DaemonStatusSnapshotStoreLike {
  constructor(
    private readonly statusPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<DaemonStatusSnapshot> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.statusPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return createDefaultStatusSnapshot(this.now());
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isDaemonStatusSnapshot(parsed)) {
        return parsed;
      }
    } catch {
      // invalid data falls back to default status
    }

    return createDefaultStatusSnapshot(this.now());
  }

  async save(snapshot: DaemonStatusSnapshot): Promise<void> {
    await writeJsonAtomically(this.statusPath, snapshot);
  }
}

export class DaemonControlRequestFileStore
  implements DaemonControlRequestStoreLike {
  constructor(
    private readonly controlPath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly makeRequestId: () => string = () => crypto.randomUUID(),
  ) {}

  private makeDefaultDocument(): DaemonControlQueueDocument {
    return {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      requests: [],
    };
  }

  private async loadDocument(): Promise<DaemonControlQueueDocument> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.controlPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return this.makeDefaultDocument();
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isDaemonControlQueueDocument(parsed)) {
        return parsed;
      }
    } catch {
      throw new Error("Control queue file contains invalid JSON");
    }
    throw new Error("Control queue file has unsupported schema");
  }

  async list(): Promise<DaemonControlRequest[]> {
    const document = await this.loadDocument();
    return document.requests.map(cloneRequest);
  }

  async enqueue(
    request: DaemonControlRequestDraft,
  ): Promise<DaemonControlRequest> {
    const document = await this.loadDocument();
    if (document.requests.length >= MAX_CONTROL_QUEUE_LENGTH) {
      throw new Error(
        `Control queue length exceeds limit (${MAX_CONTROL_QUEUE_LENGTH})`,
      );
    }

    const queueRequest: DaemonControlRequest = {
      requestId: this.makeRequestId(),
      requestedAt: this.now().toISOString(),
      command: request.command,
      ...(request.payload ? { payload: { ...request.payload } } : {}),
    };

    document.requests.push(queueRequest);
    await writeJsonAtomically(this.controlPath, document);

    return cloneRequest(queueRequest);
  }

  async markProcessed(requestId: string): Promise<void> {
    const document = await this.loadDocument();
    const index = document.requests.findIndex((request) =>
      request.requestId === requestId
    );

    if (index < 0) {
      throw new Error(`Control queue request not found: ${requestId}`);
    }

    document.requests = document.requests.slice(index + 1);
    document.lastProcessedRequestId = requestId;
    await writeJsonAtomically(this.controlPath, document);
  }
}
