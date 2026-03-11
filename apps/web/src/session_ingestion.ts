import {
  type ConversationEvent,
  extractSnippet,
  type ProviderCursor,
} from "@kato/shared";
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
  const fromPosition = resolveCursorPosition(metadata.ingestCursor);
  const fileStat = await Deno.stat(metadata.sourceFilePath);
  const incomingEvents: ConversationEvent[] = [];
  let latestCursor = metadata.ingestCursor;

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

  const snippet = refreshed.snippet ?? extractSnippet(incomingEvents);
  if (snippet && refreshed.snippet !== snippet) {
    refreshed.snippet = snippet;
  }
  refreshed.ingestCursor = latestCursor;
  refreshed.lastObservedMtimeMs = fileStat.mtime?.getTime();
  refreshed.sourceFilePath = metadata.sourceFilePath;
  await sessionStore.saveSessionMetadata(refreshed);

  const logAttributes = {
    sessionId: refreshed.sessionId,
    sessionShortId: refreshed.sessionId.slice(0, 8),
    provider: refreshed.provider,
    providerSessionId: refreshed.providerSessionId,
    sourceFilePath: refreshed.sourceFilePath,
    parsedEvents: incomingEvents.length,
    appendedTwinEvents,
    droppedAsDuplicate,
  };
  await options.operationalLogger?.info(
    "web.sessions.ingestion.completed",
    "Manual session ingestion completed",
    logAttributes,
  );
  await options.auditLogger?.record(
    "web.sessions.ingestion.completed",
    "Manual session ingestion completed",
    logAttributes,
  );

  return {
    sessionId: refreshed.sessionId,
    sessionShortId: refreshed.sessionId.slice(0, 8),
    provider: refreshed.provider,
    providerSessionId: refreshed.providerSessionId,
    parsedEvents: incomingEvents.length,
    appendedTwinEvents,
    droppedAsDuplicate,
  };
}
