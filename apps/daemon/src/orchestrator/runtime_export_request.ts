import type { ConversationEvent, SessionMetadataV1 } from "@kato/shared";
import type { AuditLogger, StructuredLogger } from "../observability/mod.ts";
import { appendExportsLogEntry } from "../utils/exports_log.ts";
import type {
  RecordingOutputOverrides,
  RecordingPipelineLike,
} from "../writer/mod.ts";
import { isRecord } from "../../../runtime/src/config/file_store_utils.ts";
import type { DaemonControlRequest } from "./control_plane.ts";
import type { PersistentSessionStateStore } from "./session_state_store.ts";

const KNOWN_EXPORT_PROVIDER_PREFIXES = new Set(["claude", "codex", "gemini"]);

export interface SessionExportSnapshot {
  provider: string;
  events: ConversationEvent[];
}

type ExportSessionResolutionMatch =
  | "passthrough"
  | "provider_session_id"
  | "session_id"
  | "session_id_prefix";

export interface ExportSessionResolution {
  lookupSessionId: string;
  matchedBy: ExportSessionResolutionMatch;
  ambiguousMatches?: SessionMetadataV1[];
}

export interface HandleExportControlRequestOptions {
  request: DaemonControlRequest;
  recordingPipeline: RecordingPipelineLike;
  sessionStateStore?: PersistentSessionStateStore;
  loadSessionSnapshot?: (
    sessionId: string,
  ) => Promise<SessionExportSnapshot | undefined>;
  exportEnabled: boolean;
  defaultCliExportOutputOverrides?: RecordingOutputOverrides;
  exportsLogPath?: string;
  now: () => Date;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  resolveTitle: (
    events: ConversationEvent[],
    requestedSessionId: string,
  ) => string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function cloneOutputOverrides(
  value: RecordingOutputOverrides | undefined,
): RecordingOutputOverrides | undefined {
  if (!value) {
    return undefined;
  }
  return {
    ...(value.includeFrontmatter !== undefined
      ? { includeFrontmatter: value.includeFrontmatter }
      : {}),
    ...(value.includeUpdatedInFrontmatter !== undefined
      ? { includeUpdatedInFrontmatter: value.includeUpdatedInFrontmatter }
      : {}),
    ...(value.includeSessionIds !== undefined
      ? { includeSessionIds: value.includeSessionIds }
      : {}),
    ...(value.includeWorkspaceIds !== undefined
      ? { includeWorkspaceIds: value.includeWorkspaceIds }
      : {}),
    ...(value.includeRecordingIds !== undefined
      ? { includeRecordingIds: value.includeRecordingIds }
      : {}),
    ...(value.includeConversationEventKinds !== undefined
      ? { includeConversationEventKinds: value.includeConversationEventKinds }
      : {}),
    ...(value.participantUsername
      ? { participantUsername: value.participantUsername }
      : {}),
    ...(value.frontmatterTags
      ? { frontmatterTags: [...value.frontmatterTags] }
      : {}),
    ...(value.frontmatterWriterPolicy
      ? { frontmatterWriterPolicy: { ...value.frontmatterWriterPolicy } }
      : {}),
    ...(value.renderOptions
      ? { renderOptions: { ...value.renderOptions } }
      : {}),
  };
}

export function resolveExportOutputOverrides(
  payload: unknown,
  fallback: RecordingOutputOverrides | undefined,
): RecordingOutputOverrides | undefined {
  const resolved = cloneOutputOverrides(fallback) ?? {};
  if (!isRecord(payload)) {
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }

  const frontmatter = payload["resolvedExportMarkdownFrontmatter"];
  if (isRecord(frontmatter)) {
    const includeFrontmatter = readBoolean(
      frontmatter["includeFrontmatterInMarkdownRecordings"],
    );
    if (includeFrontmatter !== undefined) {
      resolved.includeFrontmatter = includeFrontmatter;
    }
    const includeUpdated = readBoolean(
      frontmatter["includeUpdatedInFrontmatter"],
    );
    if (includeUpdated !== undefined) {
      resolved.includeUpdatedInFrontmatter = includeUpdated;
    }
    const includeSessionIds = readBoolean(frontmatter["includeSessionIds"]);
    if (includeSessionIds !== undefined) {
      resolved.includeSessionIds = includeSessionIds;
    }
    const includeWorkspaceIds = readBoolean(frontmatter["includeWorkspaceIds"]);
    if (includeWorkspaceIds !== undefined) {
      resolved.includeWorkspaceIds = includeWorkspaceIds;
    }
    const includeRecordingIds = readBoolean(frontmatter["includeRecordingIds"]);
    if (includeRecordingIds !== undefined) {
      resolved.includeRecordingIds = includeRecordingIds;
    }
    const includeKinds = readBoolean(
      frontmatter["includeConversationEventKinds"],
    );
    if (includeKinds !== undefined) {
      resolved.includeConversationEventKinds = includeKinds;
    }
  }

  const featureFlags = payload["resolvedExportFeatureFlags"];
  if (isRecord(featureFlags)) {
    const renderOptions = { ...(resolved.renderOptions ?? {}) };
    let changed = false;
    const includeCommentary = readBoolean(
      featureFlags["writerIncludeCommentary"],
    );
    if (includeCommentary !== undefined) {
      changed = true;
      renderOptions.includeCommentary = includeCommentary;
    }
    const includeThinking = readBoolean(featureFlags["writerIncludeThinking"]);
    if (includeThinking !== undefined) {
      changed = true;
      renderOptions.includeThinking = includeThinking;
    }
    const includeToolCalls = readBoolean(
      featureFlags["writerIncludeToolCalls"],
    );
    if (includeToolCalls !== undefined) {
      changed = true;
      renderOptions.includeToolCalls = includeToolCalls;
    }
    const includeToolResults = readBoolean(
      featureFlags["writerIncludeToolResults"],
    );
    if (includeToolResults !== undefined) {
      changed = true;
      renderOptions.includeToolResults = includeToolResults;
    }
    const includeDecisionPrompt = readBoolean(
      featureFlags["writerIncludeDecisionPrompt"],
    );
    if (includeDecisionPrompt !== undefined) {
      changed = true;
      renderOptions.includeDecisionPrompt = includeDecisionPrompt;
    }
    const includeDecisionOptions = readBoolean(
      featureFlags["writerIncludeDecisionOptions"],
    );
    if (includeDecisionOptions !== undefined) {
      changed = true;
      renderOptions.includeDecisionOptions = includeDecisionOptions;
    }
    const includeDecisionSelection = readBoolean(
      featureFlags["writerIncludeDecisionSelection"],
    );
    if (includeDecisionSelection !== undefined) {
      changed = true;
      renderOptions.includeDecisionSelection = includeDecisionSelection;
    }
    const italicizeUserMessages = readBoolean(
      featureFlags["writerItalicizeUserMessages"],
    );
    if (italicizeUserMessages !== undefined) {
      changed = true;
      renderOptions.italicizeUserMessages = italicizeUserMessages;
    }
    if (changed) {
      resolved.renderOptions = renderOptions;
    }
  }

  const resolvedExportTimezone = readString(payload["resolvedExportTimezone"]);
  if (resolvedExportTimezone) {
    resolved.renderOptions = {
      ...(resolved.renderOptions ?? {}),
      headingTimestampTimezone: resolvedExportTimezone,
    };
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function parseExportSessionSelector(
  requestedSessionId: string,
): { provider?: string; selector: string } {
  const trimmed = requestedSessionId.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return { selector: trimmed };
  }

  const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
  const selector = trimmed.slice(slashIndex + 1).trim();
  if (
    selector.length === 0 || !KNOWN_EXPORT_PROVIDER_PREFIXES.has(provider)
  ) {
    return { selector: trimmed };
  }

  return { provider, selector };
}

function passthroughExportSessionResolution(
  requestedSessionId: string,
): ExportSessionResolution {
  const trimmed = requestedSessionId.trim();
  return {
    lookupSessionId: trimmed.length > 0 ? trimmed : requestedSessionId,
    matchedBy: "passthrough",
  };
}

export async function resolveExportSessionLookup(
  requestedSessionId: string,
  sessionStateStore?: PersistentSessionStateStore,
): Promise<ExportSessionResolution> {
  const passthrough = passthroughExportSessionResolution(requestedSessionId);
  if (!sessionStateStore) {
    return passthrough;
  }

  const metadataList = await sessionStateStore.listSessionMetadata();
  if (metadataList.length === 0) {
    return passthrough;
  }

  const parsed = parseExportSessionSelector(passthrough.lookupSessionId);
  const scopedEntries = parsed.provider
    ? metadataList.filter((entry) =>
      entry.provider.toLowerCase() === parsed.provider
    )
    : metadataList;
  if (scopedEntries.length === 0 || parsed.selector.length === 0) {
    return passthrough;
  }

  const matchers: Array<{
    kind: ExportSessionResolutionMatch;
    matches: SessionMetadataV1[];
  }> = [{
    kind: "provider_session_id",
    matches: scopedEntries.filter((entry) =>
      entry.providerSessionId === parsed.selector
    ),
  }, {
    kind: "session_id",
    matches: scopedEntries.filter((entry) =>
      entry.sessionId === parsed.selector
    ),
  }, {
    kind: "session_id_prefix",
    matches: scopedEntries.filter((entry) =>
      entry.sessionId.startsWith(parsed.selector)
    ),
  }];

  for (const matcher of matchers) {
    if (matcher.matches.length === 1) {
      return {
        lookupSessionId: matcher.matches[0]!.providerSessionId,
        matchedBy: matcher.kind,
      };
    }
    if (matcher.matches.length > 1) {
      return {
        ...passthrough,
        matchedBy: matcher.kind,
        ambiguousMatches: matcher.matches,
      };
    }
  }

  return passthrough;
}

function formatExportSessionAmbiguousLabel(
  metadata: SessionMetadataV1,
): string {
  return `${metadata.provider}/${
    metadata.sessionId.slice(0, 8)
  } (${metadata.providerSessionId})`;
}

async function warnExportSkipped(
  event: string,
  message: string,
  details: {
    requestId: string;
    sessionId?: string;
    outputPath?: string;
    [key: string]: unknown;
  },
  operationalLogger: StructuredLogger,
  auditLogger: AuditLogger,
): Promise<void> {
  await operationalLogger.warn(event, message, details);
  await auditLogger.record(event, message, details);
}

async function appendExportHistoryEntrySafely(
  exportsLogPath: string | undefined,
  entry: Parameters<typeof appendExportsLogEntry>[1],
  operationalLogger: StructuredLogger,
): Promise<void> {
  if (!exportsLogPath) {
    return;
  }
  try {
    await appendExportsLogEntry(exportsLogPath, entry);
  } catch (error) {
    await operationalLogger.warn(
      "daemon.control.export.history_write_failed",
      "Failed to append export history event",
      {
        requestId: entry.requestId,
        status: entry.status,
        exportsLogPath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function handleExportControlRequest(
  options: HandleExportControlRequestOptions,
): Promise<void> {
  const {
    request,
    recordingPipeline,
    sessionStateStore,
    loadSessionSnapshot,
    exportEnabled,
    defaultCliExportOutputOverrides,
    exportsLogPath,
    now,
    operationalLogger,
    auditLogger,
    resolveTitle,
  } = options;

  const payload = request.payload;
  const outputOverrides = resolveExportOutputOverrides(
    payload,
    defaultCliExportOutputOverrides,
  );
  const sessionId = isRecord(payload)
    ? readString(payload["sessionId"])
    : undefined;
  const outputPath = isRecord(payload)
    ? readString(payload["resolvedOutputPath"]) ??
      readString(payload["outputPath"])
    : undefined;
  const formatRaw = isRecord(payload)
    ? readString(payload["format"])
    : undefined;
  const format: "markdown" | "jsonl" | undefined =
    formatRaw === "markdown" || formatRaw === "jsonl" ? formatRaw : undefined;
  const baseHistoryEntry = {
    recordedAt: now().toISOString(),
    requestId: request.requestId,
    requestedAt: request.requestedAt,
    ...(sessionId ? { sessionId } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(format ? { format } : {}),
  } as const;
  const recordExportFailed = async (
    reason: string,
    extra?: {
      error?: string;
      matchedBy?: string;
    },
  ): Promise<void> => {
    await appendExportHistoryEntrySafely(
      exportsLogPath,
      {
        ...baseHistoryEntry,
        status: "failed",
        reason,
        ...(extra?.error ? { error: extra.error } : {}),
        ...(extra?.matchedBy ? { matchedBy: extra.matchedBy } : {}),
      },
      operationalLogger,
    );
  };
  const recordExportSucceeded = async (
    provider: string,
    matchedBy?: string,
  ): Promise<void> => {
    await appendExportHistoryEntrySafely(
      exportsLogPath,
      {
        ...baseHistoryEntry,
        status: "succeeded",
        provider,
        ...(matchedBy ? { matchedBy } : {}),
      },
      operationalLogger,
    );
  };

  if (!exportEnabled) {
    await operationalLogger.warn(
      "daemon.control.export.disabled",
      "Export request skipped because feature flag is disabled",
      { requestId: request.requestId },
    );
    await recordExportFailed("export_disabled");
    return;
  }

  if (!sessionId || !outputPath) {
    await operationalLogger.warn(
      "daemon.control.export.invalid",
      "Export request payload is missing required fields",
      { requestId: request.requestId, payload },
    );
    await recordExportFailed("invalid_payload");
    return;
  }

  if (!loadSessionSnapshot) {
    await warnExportSkipped(
      "daemon.control.export.unhandled",
      "Export request skipped because session snapshot loader is unavailable",
      { requestId: request.requestId, sessionId, outputPath },
      operationalLogger,
      auditLogger,
    );
    await recordExportFailed("snapshot_loader_unavailable");
    return;
  }

  try {
    const sessionResolution = await resolveExportSessionLookup(
      sessionId,
      sessionStateStore,
    );
    if (sessionResolution.ambiguousMatches) {
      await warnExportSkipped(
        "daemon.control.export.session_ambiguous",
        "Export request skipped because session selector matched multiple sessions",
        {
          requestId: request.requestId,
          sessionId,
          outputPath,
          matchedBy: sessionResolution.matchedBy,
          candidates: sessionResolution.ambiguousMatches.map((entry) =>
            formatExportSessionAmbiguousLabel(entry)
          ),
        },
        operationalLogger,
        auditLogger,
      );
      await recordExportFailed("session_selector_ambiguous", {
        matchedBy: sessionResolution.matchedBy,
      });
      return;
    }

    const lookupSessionId = sessionResolution.lookupSessionId;
    const snapshotData = await loadSessionSnapshot(lookupSessionId);
    if (!snapshotData) {
      await warnExportSkipped(
        "daemon.control.export.session_missing",
        "Export request skipped because session snapshot was not found",
        {
          requestId: request.requestId,
          sessionId,
          outputPath,
          ...(lookupSessionId !== sessionId ? { lookupSessionId } : {}),
          ...(sessionResolution.matchedBy !== "passthrough"
            ? { matchedBy: sessionResolution.matchedBy }
            : {}),
        },
        operationalLogger,
        auditLogger,
      );
      await recordExportFailed("session_snapshot_not_found", {
        ...(sessionResolution.matchedBy !== "passthrough"
          ? { matchedBy: sessionResolution.matchedBy }
          : {}),
      });
      return;
    }

    const snapshotProvider = readString(snapshotData.provider);
    if (!snapshotProvider) {
      await warnExportSkipped(
        "daemon.control.export.invalid_snapshot",
        "Export request skipped because session snapshot provider is invalid",
        { requestId: request.requestId, sessionId, outputPath },
        operationalLogger,
        auditLogger,
      );
      await recordExportFailed("invalid_snapshot_provider");
      return;
    }

    if (snapshotData.events.length === 0) {
      await warnExportSkipped(
        "daemon.control.export.empty",
        "Export request skipped because session snapshot had no events",
        {
          requestId: request.requestId,
          sessionId,
          outputPath,
          provider: snapshotProvider,
        },
        operationalLogger,
        auditLogger,
      );
      await recordExportFailed("session_snapshot_empty");
      return;
    }

    await recordingPipeline.exportSnapshot({
      provider: snapshotProvider,
      sessionId,
      targetPath: outputPath,
      events: snapshotData.events,
      title: resolveTitle(snapshotData.events, sessionId),
      ...(format ? { format } : {}),
      ...(outputOverrides ? { outputOverrides } : {}),
    });
    await recordExportSucceeded(
      snapshotProvider,
      sessionResolution.matchedBy !== "passthrough"
        ? sessionResolution.matchedBy
        : undefined,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await operationalLogger.error(
      "daemon.control.export.failed",
      "Export request failed in daemon runtime",
      {
        requestId: request.requestId,
        sessionId,
        outputPath,
        error: errorMessage,
      },
    );
    await recordExportFailed("export_snapshot_failed", {
      error: errorMessage,
    });
  }
}
