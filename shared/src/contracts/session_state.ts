import type { ProviderCursor } from "./ipc.ts";
import { normalizeOutputTags } from "../tags.ts";

export const DAEMON_CONTROL_SCHEMA_VERSION = 1 as const;
export const SESSION_METADATA_SCHEMA_VERSION = 1 as const;

export type RecordingDesiredState = "on" | "off";

export type SessionWorkspaceOutputDestinationKindV1 =
  | "workspace-relative"
  | "absolute-explicit";

export interface SessionWorkspaceRecordingCycleV1 {
  recordingCycleId: string;
  startedCursor: number;
  stoppedCursor?: number;
  startedAt?: string;
  lastWriteAt?: string;
  stoppedAt?: string;
  startedBySeq?: number;
  stoppedBySeq?: number;
}

export interface SessionWorkspaceOutputDestinationV1 {
  kind: SessionWorkspaceOutputDestinationKindV1;
  // Path hints are optional snapshots; `kind` controls rerooting semantics and
  // `currentResolvedPath` remains the authoritative resolved target.
  relativePathFromWorkspaceRoot?: string;
  absolutePath?: string;
}

// User-editable descriptive metadata. Session-level values are inherited
// defaults for outputs; per-output values win for scalar fields and tags are
// additive. Persisted session metadata is the source of truth; markdown
// frontmatter derived from it stays descriptive.
export interface SessionOutputMetadataV1 {
  displayTitle?: string;
  filenameSlug?: string;
  tags?: string[];
  personaName?: string;
  participantUsername?: string;
}

// Per-output render-policy overrides. Missing keys inherit the workspace
// default; present booleans override it. Distinct from `writerFeatureFlags`,
// which stays a refreshable snapshot of workspace defaults.
export interface SessionWorkspaceOutputWriterFeatureFlagOverridesV1 {
  writerIncludeCommentary?: boolean;
  writerIncludeThinking?: boolean;
}

export interface SessionWorkspaceOutputStateV1 {
  workspaceId: string;
  workspaceAliasSnapshot?: string;
  desiredState: RecordingDesiredState;
  currentDestination: SessionWorkspaceOutputDestinationV1;
  currentResolvedPath: string;
  sourceConfigPath?: string;
  workspaceRootSnapshot: string;
  resolvedDefaultOutputDir: string;
  filenameTemplate: string;
  // Snapshot of workspace-level default tags used when the workspace config is
  // no longer resolvable for future appends or metadata syncs.
  defaultTags?: string[];
  writerFeatureFlags: SessionWorkspaceAttachmentWriterFeatureFlagsV1;
  writerFeatureFlagOverrides?:
    SessionWorkspaceOutputWriterFeatureFlagOverridesV1;
  outputMetadata?: SessionOutputMetadataV1;
  activeRecordingCycleId?: string;
  writeCursor: number;
  createdAt?: string;
  recordingCycles: SessionWorkspaceRecordingCycleV1[];
}

export interface SessionIngestAnchorV1 {
  messageId?: string;
  payloadHash?: string;
}

export interface SessionCommandCursorAnchorV1 {
  eventId?: string;
  providerEventType?: string;
  providerEventId?: string;
  timestamp?: string;
}

export interface SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  writerIncludeCommentary: boolean;
  writerIncludeThinking: boolean;
  writerIncludeToolCalls: boolean;
  writerIncludeToolResults?: boolean;
  writerIncludeDecisionPrompt?: boolean;
  writerIncludeDecisionOptions?: boolean;
  writerIncludeDecisionSelection?: boolean;
  writerItalicizeUserMessages: boolean;
  writerRelativizeLocalLinks?: boolean;
  writerUseDendronStyleWikilinks?: boolean;
}

export interface SessionMetadataV1 {
  schemaVersion: typeof SESSION_METADATA_SCHEMA_VERSION;
  sessionKey: string;
  provider: string;
  providerSessionId: string;
  /** Provider-native immediate parent for a recognized sub-conversation. */
  parentProviderSessionId?: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  sourceFilePath: string;
  workingDirectory?: string;
  lastObservedMtimeMs?: number;
  ingestCursor: ProviderCursor;
  ingestAnchor?: SessionIngestAnchorV1;
  twinPath: string;
  nextTwinSeq: number;
  recentFingerprints: string[];
  ingestionActivatedAt?: string;
  commandCursor?: number;
  commandCursorAnchor?: SessionCommandCursorAnchorV1;
  outputMetadataDefaults?: SessionOutputMetadataV1;
  workspaceOutputs?: SessionWorkspaceOutputStateV1[];
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

function isWorkspaceRecordingCycle(
  value: unknown,
): value is SessionWorkspaceRecordingCycleV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isNonEmptyString(value["recordingCycleId"]) ||
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
    value["lastWriteAt"] !== undefined &&
    typeof value["lastWriteAt"] !== "string"
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

export function isSessionOutputMetadataV1(
  value: unknown,
): value is SessionOutputMetadataV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value["displayTitle"] !== undefined &&
    !isNonEmptyString(value["displayTitle"])
  ) {
    return false;
  }
  if (
    value["filenameSlug"] !== undefined &&
    !isNonEmptyString(value["filenameSlug"])
  ) {
    return false;
  }
  if (
    value["tags"] !== undefined &&
    (!Array.isArray(value["tags"]) ||
      value["tags"].some((tag) => typeof tag !== "string"))
  ) {
    return false;
  }
  if (Array.isArray(value["tags"])) {
    try {
      normalizeOutputTags(value["tags"], "outputMetadata.tags");
    } catch {
      return false;
    }
  }
  if (
    value["personaName"] !== undefined &&
    !isNonEmptyString(value["personaName"])
  ) {
    return false;
  }
  if (
    value["participantUsername"] !== undefined &&
    !isNonEmptyString(value["participantUsername"])
  ) {
    return false;
  }
  return true;
}

export function isSessionWorkspaceOutputWriterFeatureFlagOverridesV1(
  value: unknown,
): value is SessionWorkspaceOutputWriterFeatureFlagOverridesV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (value["writerIncludeCommentary"] === undefined ||
    typeof value["writerIncludeCommentary"] === "boolean") &&
    (value["writerIncludeThinking"] === undefined ||
      typeof value["writerIncludeThinking"] === "boolean");
}

function isWorkspaceOutputDestination(
  value: unknown,
): value is SessionWorkspaceOutputDestinationV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value["kind"] !== "workspace-relative" &&
    value["kind"] !== "absolute-explicit"
  ) {
    return false;
  }
  if (
    value["relativePathFromWorkspaceRoot"] !== undefined &&
    !isNonEmptyString(value["relativePathFromWorkspaceRoot"])
  ) {
    return false;
  }
  if (
    value["absolutePath"] !== undefined &&
    !isNonEmptyString(value["absolutePath"])
  ) {
    return false;
  }
  return true;
}

function isWorkspaceOutputState(
  value: unknown,
): value is SessionWorkspaceOutputStateV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isNonEmptyString(value["workspaceId"]) ||
    !isWorkspaceOutputDestination(value["currentDestination"]) ||
    !isNonEmptyString(value["currentResolvedPath"]) ||
    !isNonEmptyString(value["workspaceRootSnapshot"]) ||
    !isNonEmptyString(value["resolvedDefaultOutputDir"]) ||
    !isNonEmptyString(value["filenameTemplate"])
  ) {
    return false;
  }
  if (value["desiredState"] !== "on" && value["desiredState"] !== "off") {
    return false;
  }
  if (
    value["workspaceAliasSnapshot"] !== undefined &&
    !isNonEmptyString(value["workspaceAliasSnapshot"])
  ) {
    return false;
  }
  if (
    value["sourceConfigPath"] !== undefined &&
    !isNonEmptyString(value["sourceConfigPath"])
  ) {
    return false;
  }
  if (
    value["activeRecordingCycleId"] !== undefined &&
    !isNonEmptyString(value["activeRecordingCycleId"])
  ) {
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
    value["defaultTags"] !== undefined &&
    (!Array.isArray(value["defaultTags"]) ||
      value["defaultTags"].some((tag) => typeof tag !== "string"))
  ) {
    return false;
  }
  if (Array.isArray(value["defaultTags"])) {
    try {
      normalizeOutputTags(value["defaultTags"], "workspaceOutput.defaultTags");
    } catch {
      return false;
    }
  }
  if (!isWorkspaceAttachmentWriterFeatureFlags(value["writerFeatureFlags"])) {
    return false;
  }
  if (
    value["writerFeatureFlagOverrides"] !== undefined &&
    !isSessionWorkspaceOutputWriterFeatureFlagOverridesV1(
      value["writerFeatureFlagOverrides"],
    )
  ) {
    return false;
  }
  if (
    value["outputMetadata"] !== undefined &&
    !isSessionOutputMetadataV1(value["outputMetadata"])
  ) {
    return false;
  }
  if (
    !Array.isArray(value["recordingCycles"]) ||
    !value["recordingCycles"].every((cycle) => isWorkspaceRecordingCycle(cycle))
  ) {
    return false;
  }
  return true;
}

function isWorkspaceAttachmentWriterFeatureFlags(
  value: unknown,
): value is SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["writerIncludeCommentary"] === "boolean" &&
    typeof value["writerIncludeThinking"] === "boolean" &&
    typeof value["writerIncludeToolCalls"] === "boolean" &&
    (value["writerIncludeToolResults"] === undefined ||
      typeof value["writerIncludeToolResults"] === "boolean") &&
    (value["writerIncludeDecisionPrompt"] === undefined ||
      typeof value["writerIncludeDecisionPrompt"] === "boolean") &&
    (value["writerIncludeDecisionOptions"] === undefined ||
      typeof value["writerIncludeDecisionOptions"] === "boolean") &&
    (value["writerIncludeDecisionSelection"] === undefined ||
      typeof value["writerIncludeDecisionSelection"] === "boolean") &&
    typeof value["writerItalicizeUserMessages"] === "boolean" &&
    (value["writerRelativizeLocalLinks"] === undefined ||
      typeof value["writerRelativizeLocalLinks"] === "boolean") &&
    (value["writerUseDendronStyleWikilinks"] === undefined ||
      typeof value["writerUseDendronStyleWikilinks"] === "boolean");
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
    value["parentProviderSessionId"] !== undefined &&
    !isNonEmptyString(value["parentProviderSessionId"])
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
  if (
    value["workingDirectory"] !== undefined &&
    !isNonEmptyString(value["workingDirectory"])
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
    value["ingestionActivatedAt"] !== undefined &&
    !isNonEmptyString(value["ingestionActivatedAt"])
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
  if (value["commandCursorAnchor"] !== undefined) {
    if (!isRecord(value["commandCursorAnchor"])) {
      return false;
    }
    if (
      value["commandCursorAnchor"]["eventId"] !== undefined &&
      !isNonEmptyString(value["commandCursorAnchor"]["eventId"])
    ) {
      return false;
    }
    if (
      value["commandCursorAnchor"]["providerEventType"] !== undefined &&
      !isNonEmptyString(value["commandCursorAnchor"]["providerEventType"])
    ) {
      return false;
    }
    if (
      value["commandCursorAnchor"]["providerEventId"] !== undefined &&
      !isNonEmptyString(value["commandCursorAnchor"]["providerEventId"])
    ) {
      return false;
    }
    if (
      value["commandCursorAnchor"]["timestamp"] !== undefined &&
      !isNonEmptyString(value["commandCursorAnchor"]["timestamp"])
    ) {
      return false;
    }
  }
  if (
    value["outputMetadataDefaults"] !== undefined &&
    !isSessionOutputMetadataV1(value["outputMetadataDefaults"])
  ) {
    return false;
  }
  if (
    value["workspaceOutputs"] !== undefined &&
    (!Array.isArray(value["workspaceOutputs"]) ||
      !value["workspaceOutputs"].every((entry) =>
        isWorkspaceOutputState(entry)
      ))
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
