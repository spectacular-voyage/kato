import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import { parseGeminiEvents } from "../apps/daemon/src/providers/gemini/mod.ts";

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const FIXTURE = join(THIS_DIR, "fixtures", "gemini-session.json");
const COMMAND_FIXTURE = join(
  THIS_DIR,
  "fixtures",
  "gemini-session-command-display-mismatch.json",
);
const TEST_CTX = { provider: "gemini", sessionId: "sess-gemini-001" };

type ParseItem = {
  event: ConversationEvent;
  cursor: { kind: string; value: number };
};

async function collectEvents(
  filePath: string,
  fromIndex?: number,
): Promise<ParseItem[]> {
  const items: ParseItem[] = [];
  for await (const item of parseGeminiEvents(filePath, fromIndex, TEST_CTX)) {
    items.push(item as ParseItem);
  }
  return items;
}

Deno.test("gemini parser emits normalized user, assistant, thinking, and tool events", async () => {
  const results = await collectEvents(FIXTURE);
  const kinds = results.map((result) => result.event.kind);
  assertEquals(kinds, [
    "message.user",
    "message.assistant",
    "thinking",
    "tool.call",
    "tool.result",
    "tool.call",
    "tool.result",
    "message.user",
    "message.assistant",
  ]);
});

Deno.test("gemini parser prefers displayContent over content for user messages", async () => {
  const results = await collectEvents(FIXTURE);
  const firstUser = results.find((result) =>
    result.event.kind === "message.user"
  );
  assert(firstUser !== undefined);
  if (firstUser.event.kind === "message.user") {
    assertStringIncludes(firstUser.event.content, "please analyze auth flow");
    assert(
      !firstUser.event.content.includes(
        "raw user text that should be ignored",
      ),
    );
  }
});

Deno.test("gemini parser preserves control-command lines from raw user content", async () => {
  const results = await collectEvents(COMMAND_FIXTURE);
  const firstUser = results.find((result) =>
    result.event.kind === "message.user"
  );
  assert(firstUser !== undefined);
  if (firstUser.event.kind === "message.user") {
    assertStringIncludes(firstUser.event.content, "::capture notes/gemini.md");
    assertStringIncludes(
      firstUser.event.content,
      "Please help with this project.",
    );
    assert(
      !firstUser.event.content.includes("raw-only body text"),
    );
  }
});

Deno.test("gemini parser skips info entries", async () => {
  const results = await collectEvents(FIXTURE);
  assertEquals(
    results.some((result) => result.event.kind === "provider.info"),
    false,
  );
});

Deno.test("gemini parser emits tool metadata and tool results", async () => {
  const results = await collectEvents(FIXTURE);
  const toolCall = results.find((result) => result.event.kind === "tool.call");
  assert(toolCall !== undefined);
  if (toolCall.event.kind === "tool.call") {
    assertEquals(toolCall.event.toolCallId, "tool-read-1");
    assertEquals(toolCall.event.name, "read_file");
    assertEquals(toolCall.event.description, "src/middleware/auth.ts");
  }

  const toolResult = results.find((result) =>
    result.event.kind === "tool.result" &&
    result.event.toolCallId === "tool-shell-1"
  );
  assert(toolResult !== undefined);
  if (toolResult.event.kind === "tool.result") {
    assertStringIncludes(toolResult.event.result, "users.ts");
  }
});

Deno.test("gemini parser cursor is item-index and supports resume", async () => {
  const results = await collectEvents(FIXTURE);
  for (let i = 1; i < results.length; i++) {
    assert(results[i]!.cursor.kind === "item-index");
    assert(results[i]!.cursor.value >= results[i - 1]!.cursor.value);
  }

  const secondUser = results.find((result) =>
    result.event.kind === "message.user" && result.event.turnId === "u2"
  );
  assert(secondUser !== undefined);
  const resumed = await collectEvents(FIXTURE, secondUser.cursor.value);
  assertEquals(resumed.length, 1);
  assertEquals(resumed[0]!.event.kind, "message.assistant");
});

Deno.test("gemini parser populates model and source metadata", async () => {
  const results = await collectEvents(FIXTURE);
  const assistant = results.find((result) =>
    result.event.kind === "message.assistant"
  );
  assert(assistant !== undefined);
  if (assistant.event.kind === "message.assistant") {
    assertEquals(assistant.event.model, "gemini-2.0-pro");
    assertEquals(assistant.event.source.providerEventType, "gemini");
    assertEquals(assistant.event.source.providerEventId, "a1");
    assert(assistant.event.source.rawCursor !== undefined);
    assertEquals(assistant.event.source.rawCursor?.kind, "item-index");
  }
});
