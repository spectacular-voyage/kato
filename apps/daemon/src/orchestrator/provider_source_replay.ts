import type {
  ConversationEvent,
  ProviderCursor,
  SessionMetadataV1,
} from "@kato/shared";
import { parseClaudeEvents } from "../providers/claude/mod.ts";
import { parseCodexEvents } from "../providers/codex/mod.ts";
import { parseGeminiEvents } from "../providers/gemini/mod.ts";
import type { PersistentSessionStateStore } from "./session_state_store.ts";
import { mapTwinEventsToConversation } from "./session_twin_mapper.ts";

interface ProviderReplayResult {
  events: ConversationEvent[];
  cursor: ProviderCursor;
}

type ProviderReplayParser = (
  filePath: string,
  fromOffset: number,
  ctx: { provider: string; sessionId: string },
) => AsyncIterable<{ event: ConversationEvent; cursor: ProviderCursor }>;

function resolveProviderReplayParser(provider: string): ProviderReplayParser {
  switch (provider) {
    case "claude":
      return parseClaudeEvents;
    case "codex":
      return parseCodexEvents;
    case "gemini":
      return parseGeminiEvents;
    default:
      throw new Error(`Unsupported provider source replay: ${provider}`);
  }
}

function defaultCursorForProvider(provider: string): ProviderCursor {
  if (provider === "gemini") {
    return { kind: "item-index", value: 0 };
  }
  return { kind: "byte-offset", value: 0 };
}

export async function replayProviderSourceEvents(
  metadata: Pick<
    SessionMetadataV1,
    "provider" | "providerSessionId" | "sourceFilePath"
  >,
): Promise<ProviderReplayResult> {
  const parseEvents = resolveProviderReplayParser(metadata.provider);
  const events: ConversationEvent[] = [];
  let latestCursor = defaultCursorForProvider(metadata.provider);

  for await (
    const { event, cursor } of parseEvents(
      metadata.sourceFilePath,
      0,
      {
        provider: metadata.provider,
        sessionId: metadata.providerSessionId,
      },
    )
  ) {
    events.push(event);
    latestCursor = cursor;
  }

  return {
    events,
    cursor: latestCursor,
  };
}

export async function loadPersistedSessionHistoryEvents(
  metadata: SessionMetadataV1,
  sessionStateStore: PersistentSessionStateStore,
): Promise<{ events: ConversationEvent[]; source: "twin" | "source" }> {
  const twinEvents = await sessionStateStore.readTwinEvents(metadata, 1);
  const twinConversation = mapTwinEventsToConversation(twinEvents);
  if (twinConversation.length > 0) {
    return {
      events: twinConversation,
      source: "twin",
    };
  }

  const replay = await replayProviderSourceEvents(metadata);
  return {
    events: replay.events,
    source: "source",
  };
}
