import type { ProviderCursor } from "./ipc.ts";

export const DAEMON_CONTROL_SCHEMA_VERSION = 1 as const;
export const SESSION_METADATA_SCHEMA_VERSION = 1 as const;

export type RecordingDesiredState = "on" | "off";

export interface SessionRecordingPeriodV1 {
  startedCursor: number;
  stoppedCursor?: number;
  startedAt?: string;
  stoppedAt?: string;
  startedBySeq?: number;
  stoppedBySeq?: number;
}

export interface SessionRecordingStateV1 {
  recordingId: string;
  destination: string;
  desiredState: RecordingDesiredState;
  writeCursor: number;
  createdAt?: string;
  periods: SessionRecordingPeriodV1[];
}

export interface SessionIngestAnchorV1 {
  messageId?: string;
  payloadHash?: string;
}

export interface SessionMetadataV1 {
  schemaVersion: typeof SESSION_METADATA_SCHEMA_VERSION;
  sessionKey: string;
  provider: string;
  providerSessionId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  sourceFilePath: string;
  lastObservedMtimeMs?: number;
  ingestCursor: ProviderCursor;
  ingestAnchor?: SessionIngestAnchorV1;
  twinPath: string;
  nextTwinSeq: number;
  recentFingerprints: string[];
  commandCursor?: number;
  primaryRecordingDestination?: string;
  recordings: SessionRecordingStateV1[];
}

export interface DaemonControlSessionIndexEntryV1 {
  sessionKey: string;
  provider: string;
  providerSessionId: string;
  sessionId: string;
  sessionShortId: string;
  metadataPath: string;
  twinPath: string;
  updatedAt: string;
}

export interface DaemonControlIndexV1 {
  schemaVersion: typeof DAEMON_CONTROL_SCHEMA_VERSION;
  updatedAt: string;
  sessions: DaemonControlSessionIndexEntryV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProviderCursor(value: unknown): value is ProviderCursor {
  if (!isRecord(value)) {
    return false;
  }
  const kind = value["kind"];
  const cursorValue = value["value"];

  if (kind === "byte-offset" || kind === "item-index") {
    return typeof cursorValue === "number" && Number.isFinite(cursorValue);
  }
  if (kind === "opaque") {
    return typeof cursorValue === "string";
  }
  return false;
}

function isRecordingPeriod(value: unknown): value is SessionRecordingPeriodV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value["startedCursor"] !== "number" ||
    !Number.isSafeInteger(value["startedCursor"]) ||
    value["startedCursor"] < 0
  ) {
    return false;
  }
  if (
    value["stoppedCursor"] !== undefined &&
    (typeof value["stoppedCursor"] !== "number" ||
      !Number.isSafeInteger(value["stoppedCursor"]) ||
      value["stoppedCursor"] < 0)
  ) {
    return false;
  }
  if (
    value["startedAt"] !== undefined && typeof value["startedAt"] !== "string"
  ) {
    return false;
  }
  if (
    value["stoppedAt"] !== undefined && typeof value["stoppedAt"] !== "string"
  ) {
    return false;
  }
  if (
    value["startedBySeq"] !== undefined &&
    (typeof value["startedBySeq"] !== "number" ||
      !Number.isSafeInteger(value["startedBySeq"]) ||
      value["startedBySeq"] <= 0)
  ) {
    return false;
  }
  if (
    value["stoppedBySeq"] !== undefined &&
    (typeof value["stoppedBySeq"] !== "number" ||
      !Number.isSafeInteger(value["stoppedBySeq"]) ||
      value["stoppedBySeq"] <= 0)
  ) {
    return false;
  }
  return true;
}

function isRecordingState(value: unknown): value is SessionRecordingStateV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isNonEmptyString(value["recordingId"]) ||
    !isNonEmptyString(value["destination"])
  ) {
    return false;
  }
  if (value["desiredState"] !== "on" && value["desiredState"] !== "off") {
    return false;
  }
  if (
    typeof value["writeCursor"] !== "number" ||
    !Number.isSafeInteger(value["writeCursor"]) ||
    value["writeCursor"] < 0
  ) {
    return false;
  }
  if (
    value["createdAt"] !== undefined && typeof value["createdAt"] !== "string"
  ) {
    return false;
  }
  if (
    !Array.isArray(value["periods"]) ||
    !value["periods"].every((period) => isRecordingPeriod(period))
  ) {
    return false;
  }
  return true;
}

export function isSessionMetadataV1(
  value: unknown,
): value is SessionMetadataV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (value["schemaVersion"] !== SESSION_METADATA_SCHEMA_VERSION) {
    return false;
  }
  if (
    !isNonEmptyString(value["sessionKey"]) ||
    !isNonEmptyString(value["provider"]) ||
    !isNonEmptyString(value["providerSessionId"]) ||
    !isNonEmptyString(value["sessionId"]) ||
    !isNonEmptyString(value["createdAt"]) ||
    !isNonEmptyString(value["updatedAt"]) ||
    !isNonEmptyString(value["sourceFilePath"]) ||
    !isNonEmptyString(value["twinPath"])
  ) {
    return false;
  }
  if (
    value["lastObservedMtimeMs"] !== undefined &&
    (typeof value["lastObservedMtimeMs"] !== "number" ||
      !Number.isFinite(value["lastObservedMtimeMs"]) ||
      value["lastObservedMtimeMs"] < 0)
  ) {
    return false;
  }
  if (!isProviderCursor(value["ingestCursor"])) {
    return false;
  }
  if (value["ingestAnchor"] !== undefined) {
    if (!isRecord(value["ingestAnchor"])) {
      return false;
    }
    if (
      value["ingestAnchor"]["messageId"] !== undefined &&
      typeof value["ingestAnchor"]["messageId"] !== "string"
    ) {
      return false;
    }
    if (
      value["ingestAnchor"]["payloadHash"] !== undefined &&
      typeof value["ingestAnchor"]["payloadHash"] !== "string"
    ) {
      return false;
    }
  }
  if (
    typeof value["nextTwinSeq"] !== "number" ||
    !Number.isSafeInteger(value["nextTwinSeq"]) ||
    value["nextTwinSeq"] <= 0
  ) {
    return false;
  }
  if (
    !Array.isArray(value["recentFingerprints"]) ||
    value["recentFingerprints"].some((item) => typeof item !== "string")
  ) {
    return false;
  }
  if (
    value["commandCursor"] !== undefined &&
    (typeof value["commandCursor"] !== "number" ||
      !Number.isSafeInteger(value["commandCursor"]) ||
      value["commandCursor"] < 0)
  ) {
    return false;
  }
  if (
    value["primaryRecordingDestination"] !== undefined &&
    !isNonEmptyString(value["primaryRecordingDestination"])
  ) {
    return false;
  }
  if (
    !Array.isArray(value["recordings"]) ||
    !value["recordings"].every((recording) => isRecordingState(recording))
  ) {
    return false;
  }

  return true;
}

function isDaemonControlSessionIndexEntry(
  value: unknown,
): value is DaemonControlSessionIndexEntryV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value["sessionKey"]) &&
    isNonEmptyString(value["provider"]) &&
    isNonEmptyString(value["providerSessionId"]) &&
    isNonEmptyString(value["sessionId"]) &&
    isNonEmptyString(value["sessionShortId"]) &&
    isNonEmptyString(value["metadataPath"]) &&
    isNonEmptyString(value["twinPath"]) &&
    isNonEmptyString(value["updatedAt"])
  );
}

export function isDaemonControlIndexV1(
  value: unknown,
): value is DaemonControlIndexV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (value["schemaVersion"] !== DAEMON_CONTROL_SCHEMA_VERSION) {
    return false;
  }
  if (!isNonEmptyString(value["updatedAt"])) {
    return false;
  }
  if (
    !Array.isArray(value["sessions"]) ||
    !value["sessions"].every((entry) => isDaemonControlSessionIndexEntry(entry))
  ) {
    return false;
  }
  return true;
}
