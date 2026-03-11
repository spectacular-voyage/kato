import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import {
  type AuditLogger,
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
  type StructuredLogger,
} from "@kato/runtime";
import { parseClaudeEvents } from "../../daemon/src/providers/claude/mod.ts";
import { parseCodexEvents } from "../../daemon/src/providers/codex/mod.ts";
import { parseGeminiEvents } from "../../daemon/src/providers/gemini/mod.ts";
import { mapConversationEventsToTwin } from "../../daemon/src/orchestrator/session_twin_mapper.ts";

export interface IngestPersistedSessionOptions {
  sessionId: string;
  katoDir?: string;
  now?: () => Date;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface IngestPersistedSessionResult {
  sessionId: string;
  sessionShortId: string;
  provider: string;
  providerSessionId: string;
  twinAction: "create" | "update";
  parsedEvents: number;
  appendedTwinEvents: number;
  droppedAsDuplicate: number;
}

function resolveCursorPosition(cursor: ProviderCursor): number {
  switch (cursor.kind) {
    case "byte-offset":
    case "item-index":
      return cursor.value;
    case "opaque":
      throw new Error("Opaque ingestion cursors cannot be resumed manually");
  }
}

function resolveParser(provider: string) {
  switch (provider) {
    case "claude":
      return parseClaudeEvents;
    case "codex":
      return parseCodexEvents;
    case "gemini":
      return parseGeminiEvents;
    default:
      throw new Error(`Unsupported provider for manual ingestion: ${provider}`);
  }
}

async function twinFileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
}

export async function ingestPersistedSession(
  options: IngestPersistedSessionOptions,
): Promise<IngestPersistedSessionResult> {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sessionStore = new PersistentSessionStateStore({
    katoDir,
    now,
  });
  const metadata = (await sessionStore.listSessionMetadata()).find((entry) =>
    entry.sessionId === options.sessionId
  );
  if (!metadata) {
    throw new Error(`Session not found: ${options.sessionId}`);
  }

  const parser = resolveParser(metadata.provider);
  const fileStat = await Deno.stat(metadata.sourceFilePath);
  const resumeCursor = metadata.ingestCursor.kind === "byte-offset" &&
      metadata.ingestCursor.value > fileStat.size
    ? { ...metadata.ingestCursor, value: fileStat.size }
    : metadata.ingestCursor;
  const hasTwinFile = await twinFileExists(metadata.twinPath);
  const shouldCreateTwin = !hasTwinFile || metadata.nextTwinSeq <= 1;
  const twinAction: "create" | "update" = shouldCreateTwin
    ? "create"
    : "update";

  if (shouldCreateTwin) {
    await removeFileIfExists(metadata.twinPath);
    metadata.nextTwinSeq = 1;
    metadata.recentFingerprints = [];
    await sessionStore.saveSessionMetadata(metadata);
  }

  const fromPosition = shouldCreateTwin
    ? 0
    : resolveCursorPosition(resumeCursor);
  const incomingEvents: ConversationEvent[] = [];
  let latestCursor = shouldCreateTwin
    ? (
      metadata.provider === "gemini"
        ? { kind: "item-index" as const, value: 0 }
        : { kind: "byte-offset" as const, value: 0 }
    )
    : resumeCursor;

  for await (
    const { event, cursor } of parser(
      metadata.sourceFilePath,
      fromPosition,
      {
        provider: metadata.provider,
        sessionId: metadata.providerSessionId,
      },
    )
  ) {
    incomingEvents.push(event);
    latestCursor = cursor;
  }

  let refreshed = metadata;
  let appendedTwinEvents = 0;
  let droppedAsDuplicate = 0;

  if (incomingEvents.length > 0) {
    const appendResult = await sessionStore.appendTwinEvents(
      metadata,
      mapConversationEventsToTwin({
        provider: metadata.provider,
        providerSessionId: metadata.providerSessionId,
        sessionId: metadata.sessionId,
        events: incomingEvents,
        mode: fromPosition === 0 ? "backfill" : "live",
        ...(metadata.provider === "codex" && fromPosition === 0
          ? {}
          : { capturedAt: nowIso }),
      }),
      { touchUpdatedAt: true },
    );
    appendedTwinEvents = appendResult.appended.length;
    droppedAsDuplicate = appendResult.droppedAsDuplicate;
    refreshed = await sessionStore.getOrCreateSessionMetadata({
      provider: metadata.provider,
      providerSessionId: metadata.providerSessionId,
      sourceFilePath: metadata.sourceFilePath,
      initialCursor: latestCursor,
    });
  }

  if (!refreshed.ingestionActivatedAt) {
    refreshed.ingestionActivatedAt = nowIso;
  }
  refreshed.ingestCursor = latestCursor;
  refreshed.lastObservedMtimeMs = fileStat.mtime?.getTime();
  refreshed.sourceFilePath = metadata.sourceFilePath;
  await sessionStore.saveSessionMetadata(refreshed, { touchUpdatedAt: true });

  const logAttributes = {
    sessionId: refreshed.sessionId,
    sessionShortId: refreshed.sessionId.slice(0, 8),
    provider: refreshed.provider,
    providerSessionId: refreshed.providerSessionId,
    twinAction,
    sourceFilePath: refreshed.sourceFilePath,
    parsedEvents: incomingEvents.length,
    appendedTwinEvents,
    droppedAsDuplicate,
  };
  await options.operationalLogger?.info(
    "web.sessions.twin.completed",
    "Manual session twin action completed",
    logAttributes,
  );
  await options.auditLogger?.record(
    "web.sessions.twin.completed",
    "Manual session twin action completed",
    logAttributes,
  );

  return {
    sessionId: refreshed.sessionId,
    sessionShortId: refreshed.sessionId.slice(0, 8),
    provider: refreshed.provider,
    providerSessionId: refreshed.providerSessionId,
    twinAction,
    parsedEvents: incomingEvents.length,
    appendedTwinEvents,
    droppedAsDuplicate,
  };
}
