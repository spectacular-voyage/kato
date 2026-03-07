import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import { parseCodexEvents } from "../apps/daemon/src/providers/codex/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

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

async function withCodexFixture(
  lines: string[],
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  await withTestTempDir("codex-parser-", async (dir) => {
    const filePath = join(dir, "session.jsonl");
    await Deno.writeTextFile(filePath, lines.join("\n"));
    await run(filePath);
  });
}

function getProviderQuestionId(event: ConversationEvent): string | undefined {
  if (event.kind !== "decision") {
    return undefined;
  }
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)["providerQuestionId"];
  return typeof value === "string" ? value : undefined;
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

Deno.test("codex parser omits synthetic timestamps for retrospective parses", async () => {
  const results = await collectEvents(FIXTURE_VSCODE, 0);
  assert(results.length > 0);
  assertEquals(
    results.every((result) => result.event.timestamp === undefined),
    true,
  );
});

Deno.test("codex parser adds synthetic timestamps for incremental parses", async () => {
  const baseline = await collectEvents(FIXTURE_VSCODE, 0);
  assert(baseline.length > 1);

  const resumed = await collectEvents(
    FIXTURE_VSCODE,
    baseline[0]!.cursor.value,
  );
  assert(resumed.length > 0);
  assertEquals(
    resumed.every((result) =>
      typeof result.event.timestamp === "string" &&
      result.event.timestamp.length > 0
    ),
    true,
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

  const proposedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.status === "proposed" &&
    getProviderQuestionId(result.event) === "deploy_mode"
  );
  assert(proposedDecision !== undefined);
  if (proposedDecision.event.kind === "decision") {
    assertStringIncludes(proposedDecision.event.summary, "Choose deploy mode.");
    const metadata = proposedDecision.event.metadata as Record<string, unknown>;
    const options = metadata["options"];
    assert(Array.isArray(options));
    const hasBlueOption = (options as Array<Record<string, unknown>>).some((
      option,
    ) =>
      String(option["label"] ?? "") === "Blue (Recommended)" &&
      String(option["description"] ?? "") === "Primary rollout lane."
    );
    assertEquals(hasBlueOption, true);
  }

  const synthesizedUser = results.find((result) =>
    result.event.kind === "message.user" &&
    result.event.content.includes("Choose deploy mode.") &&
    result.event.content.includes("Blue (Recommended)")
  );
  assertEquals(synthesizedUser, undefined);

  const acceptedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.status === "accepted" &&
    getProviderQuestionId(result.event) === "deploy_mode"
  );
  assert(acceptedDecision !== undefined);
  if (acceptedDecision.event.kind === "decision") {
    assertStringIncludes(acceptedDecision.event.summary, "Choose deploy mode.");
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
  assertEquals(synthesizedUser, undefined);

  const acceptedDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.status === "accepted" &&
    getProviderQuestionId(result.event) === "migration_scope"
  );
  assert(acceptedDecision !== undefined);
  if (acceptedDecision.event.kind === "decision") {
    assertStringIncludes(
      acceptedDecision.event.summary,
      "How should migration run?",
    );
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
    result.event.status === "accepted" &&
    getProviderQuestionId(result.event) === "api_mode"
  );
  assert(apiDecision !== undefined);
  if (apiDecision.event.kind === "decision") {
    assertStringIncludes(apiDecision.event.summary, "API mode?");
    assertStringIncludes(apiDecision.event.summary, "Public");
  }

  const logDecision = results.find((result) =>
    result.event.kind === "decision" &&
    result.event.status === "accepted" &&
    getProviderQuestionId(result.event) === "log_mode"
  );
  assert(logDecision !== undefined);
  if (logDecision.event.kind === "decision") {
    assertStringIncludes(logDecision.event.summary, "Log mode?");
    assertStringIncludes(logDecision.event.summary, "Verbose (Recommended)");
  }

  const combinedUserMessage = results.find((result) =>
    result.event.kind === "message.user" &&
    result.event.content.includes("API mode?") &&
    result.event.content.includes("Log mode?")
  );
  assertEquals(combinedUserMessage, undefined);
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
    result.event.status === "accepted" &&
    result.event.summary.includes("Malformed output question?")
  );
  assertEquals(malformedDecision, undefined);
});

Deno.test("codex parser preserves request_user_input question metadata across resume offsets", async () => {
  const allResults = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    undefined,
    { provider: "codex", sessionId: "sess-rui-001" },
  );
  const deployCall = allResults.find((result) =>
    result.event.kind === "tool.call" &&
    result.event.name === "request_user_input" &&
    result.event.toolCallId === "call-rui-001"
  );
  assert(deployCall !== undefined);

  const resumed = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    deployCall.cursor.value,
    { provider: "codex", sessionId: "sess-rui-001" },
  );

  const resumedDeployDecision = resumed.find((result) =>
    result.event.kind === "decision" &&
    result.event.status === "accepted" &&
    getProviderQuestionId(result.event) === "deploy_mode"
  );
  assert(resumedDeployDecision !== undefined);
  if (resumedDeployDecision.event.kind === "decision") {
    assertStringIncludes(
      resumedDeployDecision.event.summary,
      "Choose deploy mode.",
    );
    const metadata = resumedDeployDecision.event.metadata as Record<
      string,
      unknown
    >;
    const options = metadata["options"];
    assert(Array.isArray(options));
    const hasGreenOption = (options as Array<Record<string, unknown>>).some((
      option,
    ) =>
      String(option["label"] ?? "") === "Green" &&
      String(option["description"] ?? "") === "Secondary rollout lane."
    );
    assertEquals(hasGreenOption, true);
  }
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

Deno.test("codex parser emits granular provider event types for tool calls and results", async () => {
  const results = await collectEvents(
    FIXTURE_REQUEST_USER_INPUT,
    undefined,
    { provider: "codex", sessionId: "sess-rui-001" },
  );

  const eventTypes = new Set(
    results.map((result) => result.event.source.providerEventType),
  );

  assert(eventTypes.has("response_item.function_call.request_user_input"));
  assert(eventTypes.has("response_item.function_call.exec_command"));
  assert(
    eventTypes.has("response_item.function_call_output.request_user_input"),
  );
  assert(eventTypes.has("response_item.function_call_output.exec_command"));
});

Deno.test("codex parser covers synthetic response_item helper branches", async () => {
  await withCodexFixture([
    "{not-json",
    JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-synth-1" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        phase: "commentary",
        content: "not-an-array",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        phase: "commentary",
        content: [
          { type: "image", text: "ignored" },
          { type: "text", text: "Status update" },
          { type: "text", text: "More context" },
        ],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "search",
        arguments: JSON.stringify({ query: "status dashboard" }),
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "tool-1",
        name: "custom_tool",
        arguments: JSON.stringify({
          count: 3,
          note: "picked-value",
          tags: ["alpha"],
        }),
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "tool-1",
        output: { ok: true },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: "loose-result",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "rui-1",
        name: "request_user_input",
        arguments: JSON.stringify({
          questions: [
            {
              question: "Deploy mode?",
              header: "Mode",
              multiSelect: true,
              options: [{ label: "Blue", description: "Use blue" }],
            },
            {
              question: "!!!",
            },
          ],
        }),
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "rui-1",
        output: JSON.stringify({
          answers: {
            "Deploy mode?": {
              answers: [" Blue "],
              note: "noted",
            },
            "!!!": {
              answers: [],
              alt: ["Manual", ""],
            },
            skipped: {
              note: "ignored",
            },
          },
        }),
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "rui-2",
        name: "request_user_input",
        arguments: "not-json",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "rui-2",
        output: "free-form answer",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "Need to compare options" },
          { type: "other", text: "ignore" },
        ],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        phase: "final_answer",
        content: [{ type: "text", text: "All done." }],
      },
    }),
  ], async (filePath) => {
    const results = await collectEvents(filePath, undefined, {
      provider: "codex",
      sessionId: "sess-synth-001",
    });

    const commentaryEvent = results.find((result) =>
      result.event.kind === "message.assistant" &&
      result.event.phase === "commentary"
    );
    assert(commentaryEvent !== undefined);
    if (commentaryEvent.event.kind === "message.assistant") {
      assertStringIncludes(commentaryEvent.event.content, "Status update");
      assertStringIncludes(commentaryEvent.event.content, "More context");
      assertEquals(commentaryEvent.event.model, "gpt-5-codex");
    }

    const searchToolCall = results.find((result) =>
      result.event.kind === "tool.call" &&
      result.event.name === "search"
    );
    assert(searchToolCall !== undefined);
    if (searchToolCall.event.kind === "tool.call") {
      assertEquals(searchToolCall.event.description, "status dashboard");
    }

    const customToolCall = results.find((result) =>
      result.event.kind === "tool.call" &&
      result.event.toolCallId === "tool-1"
    );
    assert(customToolCall !== undefined);
    if (customToolCall.event.kind === "tool.call") {
      assertEquals(customToolCall.event.description, "picked-value");
    }

    const customToolResult = results.find((result) =>
      result.event.kind === "tool.result" &&
      result.event.toolCallId === "tool-1"
    );
    assert(customToolResult !== undefined);
    if (customToolResult.event.kind === "tool.result") {
      assertEquals(customToolResult.event.result, JSON.stringify({ ok: true }));
      assertEquals(
        customToolResult.event.source.providerEventType,
        "response_item.function_call_output.custom_tool",
      );
    }

    const looseToolResult = results.find((result) =>
      result.event.kind === "tool.result" &&
      result.event.result === "loose-result"
    );
    assert(looseToolResult !== undefined);
    if (looseToolResult.event.kind === "tool.result") {
      assertEquals(
        looseToolResult.event.source.providerEventType,
        "response_item.function_call_output",
      );
    }

    const deployDecision = results.find((result) =>
      result.event.kind === "decision" &&
      result.event.status === "accepted" &&
      result.event.summary.includes("Deploy mode?")
    );
    assert(deployDecision !== undefined);
    if (deployDecision.event.kind === "decision") {
      assertStringIncludes(deployDecision.event.summary, "Blue");
      assertStringIncludes(deployDecision.event.summary, "noted");
      assertEquals(deployDecision.event.decisionKey, "deploy-mode");
      const metadata = deployDecision.event.metadata as Record<string, unknown>;
      assertEquals(metadata["providerQuestionId"], "Deploy mode?");
      assertEquals(metadata["multiSelect"], true);
    }

    const fallbackDecision = results.find((result) =>
      result.event.kind === "decision" &&
      result.event.status === "accepted" &&
      result.event.summary.includes("!!!")
    );
    assert(fallbackDecision !== undefined);
    if (fallbackDecision.event.kind === "decision") {
      assertStringIncludes(fallbackDecision.event.decisionKey, "decision-");
      assertStringIncludes(fallbackDecision.event.summary, "Manual");
    }

    const fallbackUserMessage = results.find((result) =>
      result.event.kind === "message.user" &&
      result.event.content === "free-form answer"
    );
    assert(fallbackUserMessage !== undefined);

    const reasoningEvent = results.find((result) =>
      result.event.kind === "thinking"
    );
    assert(reasoningEvent !== undefined);
    if (reasoningEvent.event.kind === "thinking") {
      assertEquals(reasoningEvent.event.content, "Need to compare options");
    }

    const finalAssistant = results.find((result) =>
      result.event.kind === "message.assistant" &&
      result.event.phase === "final"
    );
    assert(finalAssistant !== undefined);
    if (finalAssistant.event.kind === "message.assistant") {
      assertEquals(finalAssistant.event.content, "All done.");
    }
  });
});

Deno.test("codex parser covers legacy request_user_input entries with accepted decisions", async () => {
  await withCodexFixture([
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-legacy-rui" },
    }),
    JSON.stringify({
      type: "request_user_input",
      payload: {
        questions: [
          {
            id: "deploy_mode",
            question: "Deploy mode?",
            header: "Mode",
            multiSelect: false,
            options: [{ label: "Blue", description: "Primary rollout lane." }],
          },
          {
            question: "Follow-up question?",
          },
        ],
        answers: {
          deploy_mode: "Blue",
          custom_followup: "Staging first",
        },
      },
    }),
  ], async (filePath) => {
    const results = await collectEvents(filePath, undefined, {
      provider: "codex",
      sessionId: "sess-legacy-rui-001",
    });

    const toolCall = results.find((result) =>
      result.event.kind === "tool.call" &&
      result.event.name === "request_user_input"
    );
    assert(toolCall !== undefined);
    if (toolCall.event.kind === "tool.call") {
      assertEquals(
        toolCall.event.source.providerEventType,
        "request_user_input",
      );
    }

    const rawToolResult = results.find((result) =>
      result.event.kind === "tool.result" &&
      result.event.source.providerEventType === "request_user_input"
    );
    assert(rawToolResult !== undefined);
    if (rawToolResult.event.kind === "tool.result") {
      assertStringIncludes(rawToolResult.event.result, '"deploy_mode":"Blue"');
      assertStringIncludes(
        rawToolResult.event.result,
        '"custom_followup":"Staging first"',
      );
    }

    const proposedDecision = results.find((result) =>
      result.event.kind === "decision" &&
      result.event.status === "proposed" &&
      getProviderQuestionId(result.event) === "deploy_mode"
    );
    assert(proposedDecision !== undefined);
    if (proposedDecision.event.kind === "decision") {
      const metadata = proposedDecision.event.metadata as Record<
        string,
        unknown
      >;
      assertEquals(metadata["providerQuestionId"], "deploy_mode");
      assertEquals(metadata["multiSelect"], false);
    }

    const acceptedDeployDecision = results.find((result) =>
      result.event.kind === "decision" &&
      result.event.status === "accepted" &&
      getProviderQuestionId(result.event) === "deploy_mode"
    );
    assert(acceptedDeployDecision !== undefined);
    if (acceptedDeployDecision.event.kind === "decision") {
      assertStringIncludes(
        acceptedDeployDecision.event.summary,
        "Deploy mode?",
      );
      assertStringIncludes(acceptedDeployDecision.event.summary, "Blue");
      assertEquals(acceptedDeployDecision.event.decisionKey, "deploy-mode");
      assertEquals(acceptedDeployDecision.event.basisEventIds.length, 2);
      const metadata = acceptedDeployDecision.event.metadata as Record<
        string,
        unknown
      >;
      assertEquals(metadata["providerQuestionId"], "deploy_mode");
    }

    const acceptedFallbackDecision = results.find((result) =>
      result.event.kind === "decision" &&
      result.event.status === "accepted" &&
      getProviderQuestionId(result.event) === "custom_followup"
    );
    assert(acceptedFallbackDecision !== undefined);
    if (acceptedFallbackDecision.event.kind === "decision") {
      assertStringIncludes(
        acceptedFallbackDecision.event.summary,
        "custom_followup",
      );
      assertStringIncludes(
        acceptedFallbackDecision.event.summary,
        "Staging first",
      );
      assertEquals(
        acceptedFallbackDecision.event.decisionKey,
        "custom-followup",
      );
    }
  });
});

Deno.test("codex parser legacy request_user_input with non-record answers emits no accepted decisions", async () => {
  await withCodexFixture([
    JSON.stringify({
      type: "request_user_input",
      payload: {
        questions: [
          {
            question: "Deploy mode?",
          },
        ],
        answers: ["Blue"],
      },
    }),
  ], async (filePath) => {
    const results = await collectEvents(filePath, undefined, {
      provider: "codex",
      sessionId: "sess-legacy-rui-002",
    });

    const proposedDecisions = results.filter((result) =>
      result.event.kind === "decision" &&
      result.event.status === "proposed"
    );
    assertEquals(proposedDecisions.length, 1);

    const acceptedDecisions = results.filter((result) =>
      result.event.kind === "decision" &&
      result.event.status === "accepted"
    );
    assertEquals(acceptedDecisions.length, 0);

    const rawToolResult = results.find((result) =>
      result.event.kind === "tool.result" &&
      result.event.source.providerEventType === "request_user_input"
    );
    assert(rawToolResult !== undefined);
    if (rawToolResult.event.kind === "tool.result") {
      assertEquals(rawToolResult.event.result, JSON.stringify(["Blue"]));
    }
  });
});

Deno.test("codex parser uses task_complete last_agent_message when no final answer exists", async () => {
  await withCodexFixture([
    JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-task-complete" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "Need backup" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Working on it" },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "Completed from task_complete",
      },
    }),
  ], async (filePath) => {
    const results = await collectEvents(filePath, undefined, {
      provider: "codex",
      sessionId: "sess-task-complete-001",
    });

    const commentary = results.find((result) =>
      result.event.kind === "message.assistant" &&
      result.event.phase === "commentary"
    );
    assert(commentary !== undefined);

    const finalAssistant = results.find((result) =>
      result.event.kind === "message.assistant" &&
      result.event.phase === "final"
    );
    assert(finalAssistant !== undefined);
    if (finalAssistant.event.kind === "message.assistant") {
      assertEquals(
        finalAssistant.event.content,
        "Completed from task_complete",
      );
      assertEquals(
        finalAssistant.event.source.providerEventType,
        "event_msg.task_complete",
      );
    }
  });
});
