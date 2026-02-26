import { assertEquals } from "@std/assert";
import type { ConversationEvent } from "@kato/shared";
import { parseClaudeEvents } from "../apps/daemon/src/providers/claude/mod.ts";
import { parseCodexEvents } from "../apps/daemon/src/providers/codex/mod.ts";
import { parseGeminiEvents } from "../apps/daemon/src/providers/gemini/mod.ts";
import { mapConversationEventsToTwin } from "../apps/daemon/src/orchestrator/mod.ts";

async function collectConversationEvents(
  iterable: AsyncIterable<{ event: ConversationEvent }>,
): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = [];
  for await (const item of iterable) {
    events.push(item.event);
  }
  return events;
}

Deno.test("SessionTwin golden mapping for Claude fixture", async () => {
  const events = await collectConversationEvents(
    parseClaudeEvents(
      "tests/fixtures/claude-session.jsonl",
      0,
      { provider: "claude", sessionId: "claude-golden" },
    ),
  );
  const twin = mapConversationEventsToTwin({
    provider: "claude",
    providerSessionId: "claude-golden",
    sessionId: "kato-claude-golden",
    events,
    mode: "backfill",
  });

  assertEquals(
    twin.map((event) => event.kind),
    [
      "user.message",
      "assistant.thinking",
      "assistant.message",
      "assistant.tool.call",
      "assistant.tool.result",
      "assistant.tool.call",
      "assistant.tool.result",
      "assistant.message",
      "user.message",
      "assistant.message",
    ],
  );
});

Deno.test("SessionTwin golden mapping for Codex fixture", async () => {
  const events = await collectConversationEvents(
    parseCodexEvents(
      "tests/fixtures/codex-session-vscode-new.jsonl",
      0,
      { provider: "codex", sessionId: "codex-golden" },
    ),
  );
  const twin = mapConversationEventsToTwin({
    provider: "codex",
    providerSessionId: "codex-golden",
    sessionId: "kato-codex-golden",
    events,
    mode: "backfill",
  });

  assertEquals(
    twin.map((event) => event.kind),
    [
      "user.message",
      "user.kato-command",
      "assistant.tool.call",
      "assistant.tool.result",
      "assistant.thinking",
      "assistant.message",
      "assistant.message",
      "assistant.message",
      "user.message",
      "assistant.message",
    ],
  );
});

Deno.test("SessionTwin golden mapping for Gemini fixture", async () => {
  const events = await collectConversationEvents(
    parseGeminiEvents(
      "tests/fixtures/gemini-session.json",
      0,
      { provider: "gemini", sessionId: "gemini-golden" },
    ),
  );
  const twin = mapConversationEventsToTwin({
    provider: "gemini",
    providerSessionId: "gemini-golden",
    sessionId: "kato-gemini-golden",
    events,
    mode: "backfill",
  });

  assertEquals(
    twin.map((event) => event.kind),
    [
      "user.message",
      "assistant.message",
      "assistant.thinking",
      "assistant.tool.call",
      "assistant.tool.result",
      "assistant.tool.call",
      "assistant.tool.result",
      "user.message",
      "assistant.message",
    ],
  );
});
