import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parseClaudeMessages } from "../apps/daemon/src/providers/claude/mod.ts";

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const FIXTURE = join(THIS_DIR, "fixtures", "claude-session.jsonl");

type ClaudeParseResult = Awaited<ReturnType<typeof parseClaudeMessages>> extends
  AsyncIterable<infer Item> ? Item : never;

async function collectMessages(
  filePath: string,
  fromOffset?: number,
): Promise<ClaudeParseResult[]> {
  const items: ClaudeParseResult[] = [];
  for await (const item of parseClaudeMessages(filePath, fromOffset)) {
    items.push(item);
  }
  return items;
}

Deno.test("claude parser aggregates fixture turns", async () => {
  const results = await collectMessages(FIXTURE);
  assertEquals(results.length, 4);
  assertEquals(
    results.map((item) => item.message.role),
    ["user", "assistant", "user", "assistant"],
  );
});

Deno.test("claude parser skips non-message types and sidechains", async () => {
  const results = await collectMessages(FIXTURE);
  assertEquals(results.length, 4);
  for (const { message } of results) {
    assert(
      !message.content.includes("sidechain message that should be skipped"),
    );
  }
});

Deno.test("claude parser extracts user text correctly", async () => {
  const results = await collectMessages(FIXTURE);
  const user1 = results[0]!.message;
  assertEquals(user1.role, "user");
  assertEquals(
    user1.content,
    "I want to add authentication to my app. Can you help?",
  );
  assertEquals(user1.id, "msg-u1");
  assertEquals(user1.timestamp, "2026-02-10T23:36:18.000Z");
});

Deno.test("claude parser merges multi-entry assistant turns", async () => {
  const results = await collectMessages(FIXTURE);
  const assistant1 = results[1]!.message;
  assertEquals(assistant1.role, "assistant");
  assertEquals(assistant1.id, "msg-a1a");
  assertStringIncludes(
    assistant1.content,
    "I'd be happy to help with authentication!",
  );
  assertStringIncludes(assistant1.content, "I'd recommend using Passport.js");
  assertMatch(
    assistant1.content,
    /Let me check your project structure first\.\n\n.*Passport\.js/s,
  );
});

Deno.test("claude parser captures thinking and tool calls/results", async () => {
  const results = await collectMessages(FIXTURE);
  const assistant1 = results[1]!.message;

  assertEquals(assistant1.thinkingBlocks?.length, 1);
  assertEquals(
    assistant1.thinkingBlocks?.[0]?.content,
    "The user wants auth. Let me check what framework they're using.",
  );

  assertEquals(assistant1.toolCalls?.length, 2);
  const readCall = assistant1.toolCalls?.[0];
  const grepCall = assistant1.toolCalls?.[1];
  assertEquals(readCall?.id, "toolu_read1");
  assertEquals(readCall?.name, "Read");
  assertEquals(readCall?.description, "/home/user/project/package.json");
  assertStringIncludes(readCall?.result ?? "", '"name": "my-app"');

  assertEquals(grepCall?.id, "toolu_grep1");
  assertEquals(grepCall?.name, "Grep");
  assertEquals(grepCall?.description, "auth|login|session");
  assertEquals(grepCall?.result, "No matches found.");
});

Deno.test("claude parser keeps model and supports resume offsets", async () => {
  const results = await collectMessages(FIXTURE);
  const assistant1 = results[1]!.message;
  assertEquals(assistant1.model, "claude-opus-4-6");
  assertEquals(results[0]!.message.model, undefined);

  for (let i = 1; i < results.length; i++) {
    assert(results[i]!.offset > results[i - 1]!.offset);
  }

  const resumed = await collectMessages(FIXTURE, results[1]!.offset);
  assertEquals(resumed.length, 2);
  assertStringIncludes(
    resumed[0]!.message.content,
    "Passport.js. Can you set it up?",
  );
  assertStringIncludes(
    resumed[1]!.message.content,
    "I'll set up Passport.js with JWT authentication",
  );
});
