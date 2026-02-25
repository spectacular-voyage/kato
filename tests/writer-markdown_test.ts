import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  makeCompactFrontmatterId,
  MarkdownConversationWriter,
  renderEventsToMarkdown,
} from "../apps/daemon/src/mod.ts";
import type { ConversationEvent } from "@kato/shared";

function makeSandboxRoot(): string {
  return join(".kato", "test-writer-markdown", crypto.randomUUID());
}

function makeEvent(
  id: string,
  kind: "message.user" | "message.assistant",
  content: string,
  timestamp: string,
): ConversationEvent {
  return {
    eventId: id,
    provider: "test",
    sessionId: "sess-test",
    timestamp,
    kind,
    role: kind === "message.user" ? "user" : "assistant",
    content,
    source: {
      providerEventType: kind === "message.user" ? "user" : "assistant",
      providerEventId: id,
    },
  } as unknown as ConversationEvent;
}

Deno.test("makeCompactFrontmatterId creates slug-plus-suffix ids", () => {
  const id = makeCompactFrontmatterId("My Session: Hello World!");
  assertMatch(id, /^my-session-hello-world-[a-z0-9]{6}$/);
});

Deno.test("MarkdownConversationWriter dedupes append tail writes", async () => {
  const root = makeSandboxRoot();
  const outputPath = join(root, "conversation.md");
  const writer = new MarkdownConversationWriter();
  const events = [
    makeEvent(
      "e1",
      "message.user",
      "Please capture this.",
      "2026-02-22T10:00:00.000Z",
    ),
    makeEvent(
      "e2",
      "message.assistant",
      "Captured. Writing to destination.",
      "2026-02-22T10:00:02.000Z",
    ),
  ];

  try {
    const first = await writer.appendEvents(outputPath, events, {
      title: "Conversation Session",
      makeFrontmatterId: () => "conversation-session-abc123",
    });
    const second = await writer.appendEvents(outputPath, events, {
      title: "Conversation Session",
    });

    assertEquals(first.wrote, true);
    assertEquals(first.mode, "create");
    assertEquals(second.wrote, false);
    assertEquals(second.deduped, true);

    const content = await Deno.readTextFile(outputPath);
    assertStringIncludes(content, "id: conversation-session-abc123");
    assertEquals(
      content.split("Captured. Writing to destination.").length - 1,
      1,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("MarkdownConversationWriter overwrite preserves existing frontmatter", async () => {
  const root = makeSandboxRoot();
  const outputPath = join(root, "conversation.md");
  const writer = new MarkdownConversationWriter();

  try {
    await writer.appendEvents(outputPath, [
      makeEvent(
        "e1",
        "message.user",
        "First content",
        "2026-02-22T10:00:00.000Z",
      ),
    ], {
      title: "Persistent Session",
      makeFrontmatterId: () => "persistent-session-seed01",
    });

    await writer.overwriteEvents(outputPath, [
      makeEvent(
        "e2",
        "message.assistant",
        "Replacement content",
        "2026-02-22T10:01:00.000Z",
      ),
    ], {
      title: "Different Title",
      makeFrontmatterId: () => "different-title-seed99",
    });

    const content = await Deno.readTextFile(outputPath);
    assertStringIncludes(content, "id: persistent-session-seed01");
    assertStringIncludes(content, "Replacement content");
    assertEquals(content.split("First content").length - 1, 0);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test(
  "renderEventsToMarkdown keeps tool call revisions when includeToolCalls is enabled",
  () => {
    const baseAssistant = makeEvent(
      "assistant-tool-revision",
      "message.assistant",
      "Done.",
      "2026-02-22T10:00:00.000Z",
    );
    const toolCall1: ConversationEvent = {
      eventId: "tc1a",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "tool.call",
      toolCallId: "tool-1",
      name: "search",
      source: { providerEventType: "tool_call", providerEventId: "tc1a" },
    } as unknown as ConversationEvent;
    const toolResult1: ConversationEvent = {
      eventId: "tr1a",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "tool.result",
      toolCallId: "tool-1",
      result: "first-result",
      source: { providerEventType: "tool_result", providerEventId: "tr1a" },
    } as unknown as ConversationEvent;
    const toolCall2: ConversationEvent = {
      eventId: "tc1b",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "tool.call",
      toolCallId: "tool-1",
      name: "search",
      source: { providerEventType: "tool_call", providerEventId: "tc1b" },
    } as unknown as ConversationEvent;
    const toolResult2: ConversationEvent = {
      eventId: "tr1b",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "tool.result",
      toolCallId: "tool-1",
      result: "second-result",
      source: { providerEventType: "tool_result", providerEventId: "tr1b" },
    } as unknown as ConversationEvent;

    const events: ConversationEvent[] = [
      baseAssistant,
      toolCall1,
      toolResult1,
      toolCall2,
      toolResult2,
    ];

    const rendered = renderEventsToMarkdown(events, {
      includeFrontmatter: false,
      includeToolCalls: true,
      includeThinking: false,
    });

    assertStringIncludes(rendered, "first-result");
    assertStringIncludes(rendered, "second-result");
  },
);

Deno.test(
  "renderEventsToMarkdown dedupes tool call revisions when includeToolCalls is disabled",
  () => {
    const baseAssistant = makeEvent(
      "assistant-tool-hidden",
      "message.assistant",
      "Done.",
      "2026-02-22T10:00:00.000Z",
    );
    const toolCall1: ConversationEvent = {
      eventId: "tc1a-hidden",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "tool.call",
      toolCallId: "tool-1",
      name: "search",
      source: {
        providerEventType: "tool_call",
        providerEventId: "tc1a-hidden",
      },
    } as unknown as ConversationEvent;
    const toolResult1: ConversationEvent = {
      eventId: "tr1a-hidden",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "tool.result",
      toolCallId: "tool-1",
      result: "first-result",
      source: {
        providerEventType: "tool_result",
        providerEventId: "tr1a-hidden",
      },
    } as unknown as ConversationEvent;
    const toolCall2: ConversationEvent = {
      eventId: "tc1b-hidden",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "tool.call",
      toolCallId: "tool-1",
      name: "search",
      source: {
        providerEventType: "tool_call",
        providerEventId: "tc1b-hidden",
      },
    } as unknown as ConversationEvent;
    const toolResult2: ConversationEvent = {
      eventId: "tr1b-hidden",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "tool.result",
      toolCallId: "tool-1",
      result: "second-result",
      source: {
        providerEventType: "tool_result",
        providerEventId: "tr1b-hidden",
      },
    } as unknown as ConversationEvent;

    const events: ConversationEvent[] = [
      baseAssistant,
      toolCall1,
      toolResult1,
      toolCall2,
      toolResult2,
    ];

    const rendered = renderEventsToMarkdown(events, {
      includeFrontmatter: false,
      includeToolCalls: false,
      includeThinking: false,
    });

    assertStringIncludes(rendered, "Done.");
    assertEquals(rendered.includes("first-result"), false);
    assertEquals(rendered.includes("second-result"), false);
  },
);

Deno.test(
  "renderEventsToMarkdown keeps thinking revisions when includeThinking is enabled",
  () => {
    const thinking1: ConversationEvent = {
      eventId: "think-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "thinking",
      content: "first-thought",
      source: { providerEventType: "thinking", providerEventId: "think-1" },
    } as unknown as ConversationEvent;
    const thinking2: ConversationEvent = {
      eventId: "think-2",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "thinking",
      content: "second-thought",
      source: { providerEventType: "thinking", providerEventId: "think-2" },
    } as unknown as ConversationEvent;
    const answer = makeEvent(
      "assistant-thinking-revision",
      "message.assistant",
      "Answer ready.",
      "2026-02-22T10:00:02.000Z",
    );

    const rendered = renderEventsToMarkdown([thinking1, thinking2, answer], {
      includeFrontmatter: false,
      includeToolCalls: false,
      includeThinking: true,
    });

    assertStringIncludes(rendered, "first-thought");
    assertStringIncludes(rendered, "second-thought");
  },
);

Deno.test(
  "renderEventsToMarkdown dedupes thinking revisions when includeThinking is disabled",
  () => {
    const thinking1: ConversationEvent = {
      eventId: "think-hidden-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "thinking",
      content: "first-thought",
      source: {
        providerEventType: "thinking",
        providerEventId: "think-hidden-1",
      },
    } as unknown as ConversationEvent;
    const thinking2: ConversationEvent = {
      eventId: "think-hidden-2",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "thinking",
      content: "second-thought",
      source: {
        providerEventType: "thinking",
        providerEventId: "think-hidden-2",
      },
    } as unknown as ConversationEvent;
    const answer = makeEvent(
      "assistant-thinking-hidden",
      "message.assistant",
      "Answer ready.",
      "2026-02-22T10:00:02.000Z",
    );

    const rendered = renderEventsToMarkdown([thinking1, thinking2, answer], {
      includeFrontmatter: false,
      includeToolCalls: false,
      includeThinking: false,
    });

    assertEquals(rendered.split("Answer ready.").length - 1, 1);
    assertEquals(rendered.includes("first-thought"), false);
    assertEquals(rendered.includes("second-thought"), false);
  },
);

Deno.test(
  "renderEventsToMarkdown can exclude assistant commentary independently of thinking",
  () => {
    const commentary: ConversationEvent = {
      eventId: "assistant-commentary-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "message.assistant",
      role: "assistant",
      content: "I am checking the parser implementation now.",
      phase: "commentary",
      source: {
        providerEventType: "response_item.message.commentary",
        providerEventId: "assistant-commentary-1",
      },
    } as unknown as ConversationEvent;
    const thinking: ConversationEvent = {
      eventId: "thinking-visible-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "thinking",
      content: "internal reasoning trace",
      source: { providerEventType: "thinking", providerEventId: "think-1" },
    } as unknown as ConversationEvent;
    const finalAnswer = makeEvent(
      "assistant-final-1",
      "message.assistant",
      "Final answer.",
      "2026-02-22T10:00:02.000Z",
    );

    const withoutCommentary = renderEventsToMarkdown(
      [commentary, thinking, finalAnswer],
      {
        includeFrontmatter: false,
        includeCommentary: false,
        includeThinking: true,
      },
    );
    assertEquals(
      withoutCommentary.includes(
        "I am checking the parser implementation now.",
      ),
      false,
    );
    assertStringIncludes(withoutCommentary, "internal reasoning trace");
    assertStringIncludes(withoutCommentary, "Final answer.");

    const withCommentary = renderEventsToMarkdown(
      [commentary, thinking, finalAnswer],
      {
        includeFrontmatter: false,
        includeCommentary: true,
        includeThinking: true,
      },
    );
    assertStringIncludes(
      withCommentary,
      "I am checking the parser implementation now.",
    );
  },
);

Deno.test(
  "renderEventsToMarkdown renders questionnaire accepted decisions as a single line",
  () => {
    const questionnaireDecision: ConversationEvent = {
      eventId: "decision-questionnaire-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-1",
      decisionKey: "decision-line-policy",
      summary: "decision_line_policy -> Show both (Recommended)",
      status: "accepted",
      decidedBy: "user",
      basisEventIds: ["tool-result-1"],
      metadata: {
        providerQuestionId: "decision_line_policy",
      },
      source: {
        providerEventType:
          "response_item.function_call_output.request_user_input",
        providerEventId: "decision-questionnaire-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([questionnaireDecision], {
      includeFrontmatter: false,
    });

    assertStringIncludes(
      rendered,
      "**Decision [decision-line-policy]:** decision_line_policy -> Show both (Recommended)",
    );
    assertEquals(rendered.includes("*Status: accepted"), false);
  },
);

Deno.test(
  "renderEventsToMarkdown keeps status line for non-questionnaire decisions",
  () => {
    const genericDecision: ConversationEvent = {
      eventId: "decision-generic-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "decision",
      decisionId: "decision-generic-1",
      decisionKey: "export-format",
      summary: "Use markdown export",
      status: "accepted",
      decidedBy: "assistant",
      basisEventIds: ["event-1"],
      source: {
        providerEventType: "system",
        providerEventId: "decision-generic-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([genericDecision], {
      includeFrontmatter: false,
    });

    assertStringIncludes(
      rendered,
      "**Decision [export-format]:** Use markdown export",
    );
    assertStringIncludes(
      rendered,
      "*Status: accepted — decided by: assistant*",
    );
  },
);
