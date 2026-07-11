import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import { parseClaudeEvents } from "../apps/daemon/src/providers/claude/mod.ts";
import { makeTestTempPath, removePathIfPresent } from "./test_temp.ts";

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const FIXTURE = join(THIS_DIR, "fixtures", "claude-session.jsonl");
const STRING_CONTENT_FIXTURE = join(
  THIS_DIR,
  "fixtures",
  "claude-session-user-string-content.jsonl",
);
const ASK_USER_QUESTION_FIXTURE = join(
  THIS_DIR,
  "fixtures",
  "claude-session-ask-user-question.jsonl",
);

const TEST_CTX = { provider: "claude", sessionId: "sess-001" };

type ParseItem = {
  event: ConversationEvent;
  cursor: { kind: string; value: number };
};

async function collectEvents(
  filePath: string,
  fromOffset?: number,
): Promise<ParseItem[]> {
  const items: ParseItem[] = [];
  for await (const item of parseClaudeEvents(filePath, fromOffset, TEST_CTX)) {
    items.push(item as ParseItem);
  }
  return items;
}

Deno.test("claude parser emits events with correct kinds", async () => {
  const results = await collectEvents(FIXTURE);
  const kinds = results.map((r) => r.event.kind);
  assertEquals(kinds, [
    "message.user",
    "thinking",
    "message.assistant",
    "tool.call",
    "tool.result",
    "tool.call",
    "tool.result",
    "message.assistant",
    "message.user",
    "message.assistant",
  ]);
});

Deno.test("claude parser skips sidechains", async () => {
  const results = await collectEvents(FIXTURE);
  for (const { event } of results) {
    if ("content" in event) {
      assert(
        !(event.content as string).includes("sidechain message"),
      );
    }
  }
});

Deno.test("claude parser can include sidechains for subagent source files", async () => {
  const tempPath = makeTestTempPath("claude-subagent-sidechain-") + ".jsonl";
  await Deno.writeTextFile(
    tempPath,
    [
      JSON.stringify({
        type: "user",
        uuid: "subagent-u1",
        isSidechain: true,
        sessionId: "parent-session",
        timestamp: "2026-07-09T18:00:00.000Z",
        message: {
          role: "user",
          content: "investigate the rendering issue",
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "subagent-a1",
        parentUuid: "subagent-u1",
        isSidechain: true,
        sessionId: "parent-session",
        timestamp: "2026-07-09T18:00:05.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "I found the issue." }],
        },
      }),
    ].join("\n") + "\n",
  );
  try {
    const defaultResults = await collectEvents(tempPath);
    assertEquals(defaultResults, []);

    const includedResults: ParseItem[] = [];
    for await (
      const item of parseClaudeEvents(tempPath, 0, {
        ...TEST_CTX,
        includeSidechainEvents: true,
      })
    ) {
      includedResults.push(item as ParseItem);
    }

    assertEquals(
      includedResults.map((item) => item.event.kind),
      ["message.user", "message.assistant"],
    );
    const first = includedResults[0]?.event;
    assertEquals(first?.sessionId, TEST_CTX.sessionId);
    if (first?.kind === "message.user") {
      assertEquals(first.content, "investigate the rendering issue");
    }
  } finally {
    await removePathIfPresent(tempPath);
  }
});

Deno.test("claude parser emits user message correctly", async () => {
  const results = await collectEvents(FIXTURE);
  const userEvent = results[0]!.event;
  assertEquals(userEvent.kind, "message.user");
  if (userEvent.kind === "message.user") {
    assertEquals(
      userEvent.content,
      "I want to add authentication to my app. Can you help?",
    );
    assertEquals(userEvent.turnId, "msg-u1");
    assertEquals(userEvent.timestamp, "2026-02-10T23:36:18.000Z");
    assertEquals(userEvent.source.workingDirectory, "/home/user/project");
  }
});

Deno.test("claude parser emits thinking and tool.call events", async () => {
  const results = await collectEvents(FIXTURE);

  const thinkingEvent = results[1]!.event;
  assertEquals(thinkingEvent.kind, "thinking");
  if (thinkingEvent.kind === "thinking") {
    assertStringIncludes(
      thinkingEvent.content,
      "The user wants auth.",
    );
  }

  const toolCallRead = results[3]!.event;
  assertEquals(toolCallRead.kind, "tool.call");
  if (toolCallRead.kind === "tool.call") {
    assertEquals(toolCallRead.name, "Read");
    assertEquals(toolCallRead.toolCallId, "toolu_read1");
    assertEquals(toolCallRead.description, "/home/user/project/package.json");
  }

  const toolCallGrep = results[5]!.event;
  assertEquals(toolCallGrep.kind, "tool.call");
  if (toolCallGrep.kind === "tool.call") {
    assertEquals(toolCallGrep.name, "Grep");
    assertEquals(toolCallGrep.toolCallId, "toolu_grep1");
    assertEquals(toolCallGrep.description, "auth|login|session");
  }
});

Deno.test("claude parser emits tool.result events linked to tool.call", async () => {
  const results = await collectEvents(FIXTURE);

  const resultRead = results[4]!.event;
  assertEquals(resultRead.kind, "tool.result");
  if (resultRead.kind === "tool.result") {
    assertEquals(resultRead.toolCallId, "toolu_read1");
    assertStringIncludes(resultRead.result, '"name": "my-app"');
  }

  const resultGrep = results[6]!.event;
  assertEquals(resultGrep.kind, "tool.result");
  if (resultGrep.kind === "tool.result") {
    assertEquals(resultGrep.toolCallId, "toolu_grep1");
    assertEquals(resultGrep.result, "No matches found.");
  }
});

Deno.test("claude parser emits assistant messages with model", async () => {
  const results = await collectEvents(FIXTURE);

  const assistant1 = results[2]!.event;
  assertEquals(assistant1.kind, "message.assistant");
  if (assistant1.kind === "message.assistant") {
    assertEquals(assistant1.model, "claude-opus-4-6");
    assertStringIncludes(assistant1.content, "I'd be happy to help");
  }

  const assistant2 = results[7]!.event;
  assertEquals(assistant2.kind, "message.assistant");
  if (assistant2.kind === "message.assistant") {
    assertStringIncludes(assistant2.content, "Passport.js");
  }
});

Deno.test("claude parser cursor is monotonically non-decreasing and supports resume", async () => {
  const results = await collectEvents(FIXTURE);

  for (let i = 1; i < results.length; i++) {
    assert(results[i]!.cursor.value >= results[i - 1]!.cursor.value);
  }

  // Resume from the cursor of event 8 (second message.user).
  const user2Idx = results.findIndex(
    (r) => r.event.kind === "message.user" && r.event.turnId === "msg-u2",
  );
  assert(user2Idx >= 0);
  const resumeOffset = results[user2Idx]!.cursor.value;

  const resumed = await collectEvents(FIXTURE, resumeOffset);
  assert(resumed.length > 0);
  const firstResumed = resumed[0]!.event;
  assertEquals(firstResumed.kind, "message.assistant");
  if (firstResumed.kind === "message.assistant") {
    assertStringIncludes(
      firstResumed.content,
      "I'll set up Passport.js with JWT authentication",
    );
  }
});

Deno.test("claude parser populates source fields", async () => {
  const results = await collectEvents(FIXTURE);
  const first = results[0]!.event;
  assertEquals(first.source.providerEventType, "user");
  assertEquals(first.source.providerEventId, "msg-u1");
  assert(first.source.rawCursor !== undefined);
});

Deno.test("claude parser accepts string user content and preserves command lines", async () => {
  const results = await collectEvents(STRING_CONTENT_FIXTURE);
  assertEquals(results.length, 2);

  const userEvent = results[0]!.event;
  assertEquals(userEvent.kind, "message.user");
  if (userEvent.kind === "message.user") {
    assertEquals(userEvent.turnId, "u-string-1");
    assertStringIncludes(userEvent.content, "::capture notes/out-of-turn.md");
  }

  const assistantEvent = results[1]!.event;
  assertEquals(assistantEvent.kind, "message.assistant");
  if (assistantEvent.kind === "message.assistant") {
    assertEquals(assistantEvent.content, "Acknowledged.");
  }
});

Deno.test("claude parser synthesizes decision events for AskUserQuestion prompts and answers", async () => {
  const results = await collectEvents(ASK_USER_QUESTION_FIXTURE);

  const toolCall = results.find((result) =>
    result.event.kind === "tool.call" && result.event.name === "AskUserQuestion"
  );
  assert(toolCall !== undefined);

  const proposedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.status === "proposed"
  );
  assert(proposedDecision !== undefined);
  if (proposedDecision.event.kind === "decision") {
    assertStringIncludes(
      proposedDecision.event.summary,
      "Which file should we start implementation with?",
    );
    const metadata = proposedDecision.event.metadata as Record<string, unknown>;
    const options = metadata["options"];
    assert(Array.isArray(options));
    const hasSharedContracts = (options as Array<Record<string, unknown>>).some(
      (option) =>
        String(option["label"] ?? "") === "shared contracts" &&
        String(option["description"] ?? "") ===
          "shared/src/contracts/status.ts",
    );
    assertEquals(hasSharedContracts, true);
  }

  const synthesizedUser = results.find((result) =>
    result.event.kind === "message.user" &&
    result.event.content.includes("shared contracts")
  );
  assertEquals(synthesizedUser, undefined);

  const acceptedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.status === "accepted"
  );
  assert(acceptedDecision !== undefined);
  if (acceptedDecision.event.kind === "decision") {
    assertStringIncludes(
      acceptedDecision.event.summary,
      "shared contracts",
    );
  }
});

Deno.test(
  "claude parser uses matched question text as providerQuestionId when answer key is a normalized variant",
  async () => {
    const tempPath = makeTestTempPath("claude-ask-user-question-") + ".jsonl";
    const questionText = "Which output format should we use?";
    const questionHeader = "Output format";
    try {
      const assistantEntry = {
        type: "assistant",
        uuid: "ask-a-variant",
        parentUuid: "ask-u-variant",
        isSidechain: false,
        sessionId: "sess-ask-variant",
        timestamp: "2026-02-25T06:08:12.597Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{
            type: "tool_use",
            id: "toolu_ask_variant",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: questionText,
                header: questionHeader,
                options: [{
                  label: "Markdown",
                  description: "Write markdown.",
                }],
              }],
            },
          }],
        },
      };
      const userEntry = {
        type: "user",
        uuid: "ask-u-variant",
        parentUuid: "ask-a-variant",
        isSidechain: false,
        sessionId: "sess-ask-variant",
        timestamp: "2026-02-25T06:08:32.075Z",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_ask_variant",
            content: "User has answered your questions.",
          }],
        },
        toolUseResult: {
          questions: [{
            question: questionText,
            header: questionHeader,
            options: [{ label: "Markdown", description: "Write markdown." }],
          }],
          answers: {
            "which output format should we use": "Markdown",
          },
        },
      };
      await Deno.writeTextFile(
        tempPath,
        `${JSON.stringify(assistantEntry)}\n${JSON.stringify(userEntry)}\n`,
      );
      const results = await collectEvents(tempPath);
      const acceptedDecision = results.find((result) =>
        result.event.kind === "decision" &&
        result.event.status === "accepted"
      );
      assert(acceptedDecision !== undefined);
      if (acceptedDecision.event.kind !== "decision") {
        throw new Error("expected accepted decision event");
      }
      const metadata = acceptedDecision.event.metadata as Record<
        string,
        unknown
      >;
      assertEquals(metadata["providerQuestionId"], questionText);
      assertEquals(metadata["header"], questionHeader);
    } finally {
      await removePathIfPresent(tempPath);
    }
  },
);
