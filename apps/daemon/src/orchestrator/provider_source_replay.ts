import type {
  ConversationEvent,
  ProviderCursor,
  SecretsPolicyConfig,
  SessionMetadataV1,
} from "@kato/shared";
import {
  createSecretsRedactor,
  redactConversationEvents,
  type SecretsRuleMatchSummary,
} from "../policy/mod.ts";
import {
  isClaudeSubagentSourcePath,
  parseClaudeEvents,
} from "../providers/claude/mod.ts";
import { parseCodexEvents } from "../providers/codex/mod.ts";
import { parseGeminiEvents } from "../providers/gemini/mod.ts";
import type { PersistentSessionStateStore } from "./session_state_store.ts";
import { mapTwinEventsToConversation } from "./session_twin_mapper.ts";

export interface ProviderReplayRedactionSummary {
  mode: "detect" | "redact";
  eventsAffected: number;
  matches: SecretsRuleMatchSummary[];
  droppedEventIds: string[];
}

interface ProviderReplayResult {
  events: ConversationEvent[];
  cursor: ProviderCursor;
  redaction?: ProviderReplayRedactionSummary;
}

export interface ProviderSourceReplayOptions {
  /** Defaults to fail-closed `redact` mode when omitted. */
  secretsPolicy?: SecretsPolicyConfig;
}

type ProviderReplayParser = (
  filePath: string,
  fromOffset: number,
  ctx: {
    provider: string;
    sessionId: string;
    includeSidechainEvents?: boolean;
  },
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

const FAIL_CLOSED_SECRETS_POLICY: SecretsPolicyConfig = {
  mode: "redact",
  disabledRules: [],
  allowlist: [],
};

function applyReplaySecretsPolicy(
  events: ConversationEvent[],
  secretsPolicy: SecretsPolicyConfig | undefined,
): { events: ConversationEvent[]; redaction?: ProviderReplayRedactionSummary } {
  const redactor = createSecretsRedactor(
    secretsPolicy ?? FAIL_CLOSED_SECRETS_POLICY,
  );
  if (redactor.mode === "off") {
    return { events };
  }
  const result = redactConversationEvents(events, redactor);
  if (
    result.redactedEvents.length === 0 && result.droppedEventIds.length === 0
  ) {
    return { events: result.events };
  }
  const countsByRule = new Map<string, number>();
  for (const outcome of result.redactedEvents) {
    for (const match of outcome.matches) {
      countsByRule.set(
        match.ruleId,
        (countsByRule.get(match.ruleId) ?? 0) + match.count,
      );
    }
  }
  return {
    events: result.events,
    redaction: {
      mode: redactor.mode,
      eventsAffected: result.redactedEvents.length,
      matches: Array.from(
        countsByRule,
        ([ruleId, count]) => ({ ruleId, count }),
      ),
      droppedEventIds: result.droppedEventIds,
    },
  };
}

export async function replayProviderSourceEvents(
  metadata: Pick<
    SessionMetadataV1,
    "provider" | "providerSessionId" | "sourceFilePath"
  >,
  options?: ProviderSourceReplayOptions,
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
        ...(metadata.provider === "claude" &&
            isClaudeSubagentSourcePath(metadata.sourceFilePath)
          ? { includeSidechainEvents: true }
          : {}),
      },
    )
  ) {
    events.push(event);
    latestCursor = cursor;
  }

  const processed = applyReplaySecretsPolicy(events, options?.secretsPolicy);
  return {
    events: processed.events,
    cursor: latestCursor,
    ...(processed.redaction ? { redaction: processed.redaction } : {}),
  };
}

export async function loadPersistedSessionHistoryEvents(
  metadata: SessionMetadataV1,
  sessionStateStore: PersistentSessionStateStore,
  options?: ProviderSourceReplayOptions,
): Promise<{
  events: ConversationEvent[];
  source: "twin" | "source";
  redaction?: ProviderReplayRedactionSummary;
}> {
  const twinEvents = await sessionStateStore.readTwinEvents(metadata, 1);
  const twinConversation = mapTwinEventsToConversation(twinEvents);
  if (twinConversation.length > 0) {
    const processed = applyReplaySecretsPolicy(
      twinConversation,
      options?.secretsPolicy,
    );
    return {
      events: processed.events,
      source: "twin",
      ...(processed.redaction ? { redaction: processed.redaction } : {}),
    };
  }

  const replay = await replayProviderSourceEvents(metadata, options);
  return {
    events: replay.events,
    source: "source",
    ...(replay.redaction ? { redaction: replay.redaction } : {}),
  };
}
