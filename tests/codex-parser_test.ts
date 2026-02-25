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

const FIXTURE_ABORTED = join(
  THIS_DIR,
  "fixtures",
  "codex-session-aborted.jsonl",
);

const FIXTURE_REQUEST_USER_INPUT = join(
  THIS_DIR,
  "fixtures",
  "codex-session-request-user-input.jsonl",
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

Deno.test("codex parser preserves agent progress commentary and final answers", async () => {
  const results = await collectEvents(FIXTURE_VSCODE);
  const assistantEvents = results.filter(
    (r) => r.event.kind === "message.assistant",
  );
  // Two progress updates + one final answer in turn 1 + one final in turn 2.
  assert(assistantEvents.length >= 2);
  const commentaryEvents = assistantEvents.filter((item) =>
    item.event.kind === "message.assistant" &&
    item.event.phase === "commentary"
  );
  assert(commentaryEvents.length >= 2);
  const commentaryTexts = commentaryEvents
    .map((item) =>
      item.event.kind === "message.assistant" ? item.event.content : ""
    )
    .join("\n");
  assertStringIncludes(commentaryTexts, "I'm analyzing your project");
  assertStringIncludes(commentaryTexts, "Let me check the existing code");

  const finalEvents = assistantEvents.filter((item) =>
    item.event.kind === "message.assistant" &&
    item.event.phase === "final"
  );
  assert(finalEvents.length >= 2);
  const firstFinal = finalEvents[0]!.event;
  if (firstFinal.kind === "message.assistant") {
    assertStringIncludes(firstFinal.content, "JWT tokens");
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

Deno.test("codex parser synthesizes selected request_user_input answers", async () => {
  const results = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    undefined,
    { provider: "codex", sessionId: "sess-rui-001" },
  );

  const synthesizedUser = results.find((result) =>
    result.event.kind === "message.user" &&
    result.event.content.includes("Choose deploy mode.") &&
    result.event.content.includes("Blue (Recommended)")
  );
  assert(synthesizedUser !== undefined);

  const acceptedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.summary.includes("Choose deploy mode.")
  );
  assert(acceptedDecision !== undefined);
  if (acceptedDecision.event.kind === "decision") {
    assertStringIncludes(acceptedDecision.event.summary, "Blue (Recommended)");
    assertEquals(acceptedDecision.event.status, "accepted");
    assertEquals(acceptedDecision.event.decidedBy, "user");
  }
});

Deno.test("codex parser supports free-form request_user_input answers", async () => {
  const results = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    undefined,
    { provider: "codex", sessionId: "sess-rui-001" },
  );

  const synthesizedUser = results.find((result) =>
    result.event.kind === "message.user" &&
    result.event.content.includes("How should migration run?") &&
    result.event.content.includes("Run it only on staging first.")
  );
  assert(synthesizedUser !== undefined);

  const acceptedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.summary.includes("How should migration run?")
  );
  assert(acceptedDecision !== undefined);
  if (acceptedDecision.event.kind === "decision") {
    assertStringIncludes(
      acceptedDecision.event.summary,
      "Run it only on staging first.",
    );
  }
});

Deno.test("codex parser maps multiple question answers by question id", async () => {
  const results = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    undefined,
    { provider: "codex", sessionId: "sess-rui-001" },
  );

  const apiDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.summary.includes("API mode?")
  );
  assert(apiDecision !== undefined);
  if (apiDecision.event.kind === "decision") {
    assertStringIncludes(apiDecision.event.summary, "Public");
  }

  const logDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.summary.includes("Log mode?")
  );
  assert(logDecision !== undefined);
  if (logDecision.event.kind === "decision") {
    assertStringIncludes(logDecision.event.summary, "Verbose (Recommended)");
  }

  const combinedUserMessage = results.find((result) =>
    result.event.kind === "message.user" &&
    result.event.content.includes("API mode?") &&
    result.event.content.includes("Log mode?")
  );
  assert(combinedUserMessage !== undefined);
});

Deno.test("codex parser falls back to readable message.user on malformed request_user_input output", async () => {
  const results = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    undefined,
    { provider: "codex", sessionId: "sess-rui-001" },
  );

  const fallbackMessage = results.find((result) =>
    result.event.kind === "message.user" &&
    result.event.content.includes("Malformed output question?") &&
    result.event.content.includes("not-json-response-payload")
  );
  assert(fallbackMessage !== undefined);

  const malformedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.summary.includes("Malformed output question?")
  );
  assertEquals(malformedDecision, undefined);
});

Deno.test("codex parser keeps non request_user_input tool events unchanged", async () => {
  const results = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    undefined,
    { provider: "codex", sessionId: "sess-rui-001" },
  );

  const execToolCall = results.find((result) =>
    result.event.kind === "tool.call" &&
    result.event.name === "exec_command"
  );
  assert(execToolCall !== undefined);
  if (execToolCall.event.kind === "tool.call") {
    assertStringIncludes(execToolCall.event.description ?? "", "echo ok");
  }

  const execToolResult = results.find((result) =>
    result.event.kind === "tool.result" &&
    result.event.toolCallId === "call-rui-005"
  );
  assert(execToolResult !== undefined);
  if (execToolResult.event.kind === "tool.result") {
    assertStringIncludes(execToolResult.event.result, "ok");
  }
});
