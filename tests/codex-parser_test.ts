import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import { parseCodexEvents } from "../apps/daemon/src/providers/codex/mod.ts";

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const FIXTURE_VSCODE = join(
  THIS_DIR,
  "fixtures",
  "codex-session-vscode-new.jsonl",
);
const _FIXTURE_LEGACY = join(
  THIS_DIR,
  "fixtures",
  "codex-session-legacy.jsonl",
);
const FIXTURE_ABORTED = join(
  THIS_DIR,
  "fixtures",
  "codex-session-aborted.jsonl",
);

const TEST_CTX = { provider: "codex", sessionId: "sess-vscode-001" };

type ParseItem = {
  event: ConversationEvent;
  cursor: { kind: string; value: number };
};

async function collectEvents(
  filePath: string,
  fromOffset?: number,
  ctx = TEST_CTX,
): Promise<ParseItem[]> {
  const items: ParseItem[] = [];
  for await (
    const item of parseCodexEvents(filePath, fromOffset, ctx)
  ) {
    items.push(item as ParseItem);
  }
  return items;
}

Deno.test("codex parser strips IDE preamble from user message", async () => {
  const results = await collectEvents(FIXTURE_VSCODE);
  const userEvent = results.find((r) => r.event.kind === "message.user");
  assert(userEvent !== undefined);
  if (userEvent.event.kind === "message.user") {
    assertStringIncludes(
      userEvent.event.content,
      "::record @documentation/notes/test.md",
    );
    assertStringIncludes(
      userEvent.event.content,
      "Help me set up authentication",
    );
    assert(!userEvent.event.content.includes("## Active file:"));
    assert(!userEvent.event.content.includes("# Context from my IDE setup"));
  }
});

Deno.test("codex parser prefers final_answer over intermediate agent messages", async () => {
  const results = await collectEvents(FIXTURE_VSCODE);
  const assistantEvents = results.filter(
    (r) => r.event.kind === "message.assistant",
  );
  // At least 2 assistant messages for 2 turns.
  assert(assistantEvents.length >= 2);
  const firstAssistant = assistantEvents[0]!.event;
  if (firstAssistant.kind === "message.assistant") {
    assertStringIncludes(firstAssistant.content, "JWT tokens");
    assert(!firstAssistant.content.includes("I'm analyzing your project"));
    assert(!firstAssistant.content.includes("Let me check the existing code"));
  }
});

Deno.test("codex parser emits tool.call, tool.result, and thinking events", async () => {
  const results = await collectEvents(FIXTURE_VSCODE);

  const toolCallEvent = results.find((r) => r.event.kind === "tool.call");
  assert(toolCallEvent !== undefined);
  if (toolCallEvent.event.kind === "tool.call") {
    assertEquals(toolCallEvent.event.name, "exec_command");
    assertStringIncludes(toolCallEvent.event.description ?? "", "ls src/");
  }

  const toolResultEvent = results.find((r) => r.event.kind === "tool.result");
  assert(toolResultEvent !== undefined);
  if (toolResultEvent.event.kind === "tool.result") {
    assertStringIncludes(toolResultEvent.event.result, "auth.ts");
  }

  const thinkingEvent = results.find((r) => r.event.kind === "thinking");
  assert(thinkingEvent !== undefined);
  if (thinkingEvent.event.kind === "thinking") {
    assertStringIncludes(
      thinkingEvent.event.content,
      "set up authentication",
    );
  }
});

Deno.test("codex parser emits message.user with correct turn id", async () => {
  const results = await collectEvents(FIXTURE_VSCODE);
  const userEvents = results.filter((r) => r.event.kind === "message.user");
  assert(userEvents.length >= 2);
  // First user message should have turnId from task_started turn-001.
  const firstUser = userEvents[0]!.event;
  assertEquals(firstUser.turnId, "turn-001");
  // Second user message should have turn-002.
  const secondUser = userEvents[1]!.event;
  assertEquals(secondUser.turnId, "turn-002");
  if (secondUser.kind === "message.user") {
    assertEquals(secondUser.content, "Can you also add OAuth?");
  }
});

Deno.test("codex parser cursor increases monotonically and supports resume", async () => {
  const results = await collectEvents(FIXTURE_VSCODE);
  for (let i = 1; i < results.length; i++) {
    assert(results[i]!.cursor.value >= results[i - 1]!.cursor.value);
  }

  const firstUserIdx = results.findIndex((r) =>
    r.event.kind === "message.user"
  );
  assert(firstUserIdx >= 0);
  const resumeOffset = results[firstUserIdx]!.cursor.value;

  const resumed = await collectEvents(FIXTURE_VSCODE, resumeOffset);
  assert(resumed.length > 0);
  // After the first user message, should get tool events and then assistant.
  const firstResumedKind = resumed[0]!.event.kind;
  assert(
    firstResumedKind === "tool.call" ||
      firstResumedKind === "thinking" ||
      firstResumedKind === "message.assistant",
  );
});

Deno.test("codex parser handles aborted session without errors", async () => {
  const results = await collectEvents(
    FIXTURE_ABORTED,
    undefined,
    { provider: "codex", sessionId: "sess-aborted" },
  );
  // Should not throw; may produce some events or be empty.
  assert(Array.isArray(results));
});

Deno.test("codex parser populates source fields", async () => {
  const results = await collectEvents(FIXTURE_VSCODE);
  assert(results.length > 0);
  const first = results[0]!.event;
  assert(first.source.providerEventType.length > 0);
  assert(first.source.rawCursor !== undefined);
});
