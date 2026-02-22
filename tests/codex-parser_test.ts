import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parseCodexMessages } from "../apps/daemon/src/providers/codex/mod.ts";

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const FIXTURE_VSCODE = join(
  THIS_DIR,
  "fixtures",
  "codex-session-vscode-new.jsonl",
);
const FIXTURE_LEGACY = join(THIS_DIR, "fixtures", "codex-session-legacy.jsonl");
const FIXTURE_ABORTED = join(
  THIS_DIR,
  "fixtures",
  "codex-session-aborted.jsonl",
);

type CodexParseResult = Awaited<ReturnType<typeof parseCodexMessages>> extends
  AsyncIterable<infer Item> ? Item : never;

async function collectMessages(
  filePath: string,
  fromOffset?: number,
): Promise<CodexParseResult[]> {
  const items: CodexParseResult[] = [];
  for await (const item of parseCodexMessages(filePath, fromOffset)) {
    items.push(item);
  }
  return items;
}

Deno.test("codex parser strips IDE preamble and preserves command text", async () => {
  const results = await collectMessages(FIXTURE_VSCODE);
  const user1 = results[0]!;
  assertEquals(user1.message.role, "user");
  assertStringIncludes(
    user1.message.content,
    "::record @documentation/notes/test.md",
  );
  assertStringIncludes(user1.message.content, "Help me set up authentication");
  assert(!user1.message.content.includes("## Active file:"));
  assert(!user1.message.content.includes("# Context from my IDE setup"));
});

Deno.test("codex parser prefers final_answer over intermediate agent messages", async () => {
  const results = await collectMessages(FIXTURE_VSCODE);
  const assistant1 = results[1]!;
  assertEquals(assistant1.message.role, "assistant");
  assertStringIncludes(
    assistant1.message.content,
    "JWT tokens with a middleware approach",
  );
  assert(
    !assistant1.message.content.includes(
      "I'm analyzing your project structure",
    ),
  );
  assert(
    !assistant1.message.content.includes("Let me check the existing code"),
  );
});

Deno.test("codex parser emits one assistant message per finalized turn", async () => {
  const results = await collectMessages(FIXTURE_VSCODE);
  const assistantMessages = results.filter((item) =>
    item.message.role === "assistant"
  );
  assertEquals(assistantMessages.length, 2);
  assertEquals(
    results.map((item) => item.message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assertEquals(results[2]!.message.content, "Can you also add OAuth?");
});

Deno.test("codex parser links turn ids, model, tools, and reasoning", async () => {
  const results = await collectMessages(FIXTURE_VSCODE);
  assertEquals(results[0]!.message.id, "turn-001");
  assertEquals(results[2]!.message.id, "turn-002");
  assertEquals(results[1]!.message.model, "gpt-5.3-codex");

  const toolCall = results[1]!.message.toolCalls?.[0];
  assert(toolCall);
  assertEquals(toolCall.name, "exec_command");
  assertEquals(toolCall.input, { cmd: "ls src/" });
  assertStringIncludes(toolCall.result ?? "", "auth.ts");

  const thinking = results[1]!.message.thinkingBlocks?.[0];
  assert(thinking);
  assertStringIncludes(thinking.content, "set up authentication");
});

Deno.test("codex parser keeps offset ordering and resume semantics", async () => {
  const full = await collectMessages(FIXTURE_VSCODE);
  for (let i = 1; i < full.length; i++) {
    assert(full[i]!.offset > full[i - 1]!.offset);
  }

  const resumedAfterUser1 = await collectMessages(
    FIXTURE_VSCODE,
    full[0]!.offset,
  );
  assertEquals(resumedAfterUser1[0]!.message.role, "assistant");
  assertStringIncludes(resumedAfterUser1[0]!.message.content, "JWT tokens");

  const resumedAfterAssistant1 = await collectMessages(
    FIXTURE_VSCODE,
    full[1]!.offset,
  );
  assertEquals(resumedAfterAssistant1.length, 2);
  assertEquals(resumedAfterAssistant1[0]!.message.role, "user");
  assertEquals(resumedAfterAssistant1[1]!.message.role, "assistant");
});

Deno.test("codex parser supports legacy EOF flush format", async () => {
  const results = await collectMessages(FIXTURE_LEGACY);
  assertEquals(results.length, 2);
  assertEquals(results[0]!.message.role, "user");
  assertEquals(
    results[0]!.message.content,
    "How do I use async/await in JavaScript?",
  );
  assertEquals(results[1]!.message.role, "assistant");
  assertStringIncludes(
    results[1]!.message.content,
    "Async/await is a modern JavaScript feature",
  );
  assertEquals(results[1]!.message.model, undefined);

  const toolCall = results[1]!.message.toolCalls?.[0];
  assert(toolCall);
  assertEquals(toolCall.name, "search");
  assertStringIncludes(toolCall.result ?? "", "async/await is a syntax");

  const thinking = results[1]!.message.thinkingBlocks?.[0];
  assert(thinking);
  assertStringIncludes(thinking.content, "async/await basics");
});

Deno.test("codex parser handles aborted turn without assistant payload", async () => {
  const results = await collectMessages(FIXTURE_ABORTED);
  assertEquals(results[0]!.message.role, "user");
  const assistantMessages = results.filter((item) =>
    item.message.role === "assistant"
  );
  assertEquals(assistantMessages.length, 0);
});

Deno.test("codex parser keeps stable EOF offset behavior", async () => {
  const results = await collectMessages(FIXTURE_LEGACY);
  const eofOffset = results[1]!.offset;
  const fileSize = (await Deno.stat(FIXTURE_LEGACY)).size;
  assert(eofOffset >= fileSize - 1);

  const resumed = await collectMessages(FIXTURE_LEGACY, eofOffset);
  assertEquals(resumed.length, 0);
});
