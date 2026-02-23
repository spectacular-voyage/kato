import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  makeCompactFrontmatterId,
  MarkdownConversationWriter,
  renderMessagesToMarkdown,
} from "../apps/daemon/src/mod.ts";
import type { Message } from "@kato/shared";

function makeSandboxRoot(): string {
  return join(".kato", "test-writer-markdown", crypto.randomUUID());
}

function makeMessage(
  role: Message["role"],
  content: string,
  timestamp: string,
): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp,
    model: role === "assistant" ? "claude-opus-4-6" : undefined,
  };
}

Deno.test("makeCompactFrontmatterId creates slug-plus-suffix ids", () => {
  const id = makeCompactFrontmatterId("My Session: Hello World!");
  assertMatch(id, /^my-session-hello-world-[a-z0-9]{6}$/);
});

Deno.test("MarkdownConversationWriter dedupes append tail writes", async () => {
  const root = makeSandboxRoot();
  const outputPath = join(root, "conversation.md");
  const writer = new MarkdownConversationWriter();
  const messages = [
    makeMessage("user", "Please capture this.", "2026-02-22T10:00:00.000Z"),
    makeMessage(
      "assistant",
      "Captured. Writing to destination.",
      "2026-02-22T10:00:02.000Z",
    ),
  ];

  try {
    const first = await writer.appendMessages(outputPath, messages, {
      title: "Conversation Session",
      makeFrontmatterId: () => "conversation-session-abc123",
    });
    const second = await writer.appendMessages(outputPath, messages, {
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
    await writer.appendMessages(outputPath, [
      makeMessage("user", "First content", "2026-02-22T10:00:00.000Z"),
    ], {
      title: "Persistent Session",
      makeFrontmatterId: () => "persistent-session-seed01",
    });

    await writer.overwriteMessages(outputPath, [
      makeMessage(
        "assistant",
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
  "renderMessagesToMarkdown keeps tool call revisions when includeToolCalls is enabled",
  () => {
    const base: Message = {
      id: "assistant-tool-revision",
      role: "assistant",
      content: "Done.",
      timestamp: "2026-02-22T10:00:00.000Z",
      model: "claude-opus-4-6",
    };
    const messages: Message[] = [
      {
        ...base,
        toolCalls: [{
          id: "tool-1",
          name: "search",
          result: "first-result",
        }],
      },
      {
        ...base,
        toolCalls: [{
          id: "tool-1",
          name: "search",
          result: "second-result",
        }],
      },
    ];

    const rendered = renderMessagesToMarkdown(messages, {
      includeFrontmatter: false,
      includeToolCalls: true,
      includeThinking: false,
    });

    assertStringIncludes(rendered, "first-result");
    assertStringIncludes(rendered, "second-result");
  },
);

Deno.test(
  "renderMessagesToMarkdown dedupes tool call revisions when includeToolCalls is disabled",
  () => {
    const base: Message = {
      id: "assistant-tool-hidden",
      role: "assistant",
      content: "Done.",
      timestamp: "2026-02-22T10:00:00.000Z",
      model: "claude-opus-4-6",
    };
    const messages: Message[] = [
      {
        ...base,
        toolCalls: [{
          id: "tool-1",
          name: "search",
          result: "first-result",
        }],
      },
      {
        ...base,
        toolCalls: [{
          id: "tool-1",
          name: "search",
          result: "second-result",
        }],
      },
    ];

    const rendered = renderMessagesToMarkdown(messages, {
      includeFrontmatter: false,
      includeToolCalls: false,
      includeThinking: false,
    });

    assertEquals(rendered.split("Done.").length - 1, 1);
    assertEquals(rendered.includes("first-result"), false);
    assertEquals(rendered.includes("second-result"), false);
  },
);

Deno.test(
  "renderMessagesToMarkdown keeps thinking revisions when includeThinking is enabled",
  () => {
    const base: Message = {
      id: "assistant-thinking-revision",
      role: "assistant",
      content: "Answer ready.",
      timestamp: "2026-02-22T10:00:00.000Z",
      model: "claude-opus-4-6",
    };
    const messages: Message[] = [
      {
        ...base,
        thinkingBlocks: [{ content: "first-thought" }],
      },
      {
        ...base,
        thinkingBlocks: [{ content: "second-thought" }],
      },
    ];

    const rendered = renderMessagesToMarkdown(messages, {
      includeFrontmatter: false,
      includeToolCalls: false,
      includeThinking: true,
    });

    assertStringIncludes(rendered, "first-thought");
    assertStringIncludes(rendered, "second-thought");
  },
);

Deno.test(
  "renderMessagesToMarkdown dedupes thinking revisions when includeThinking is disabled",
  () => {
    const base: Message = {
      id: "assistant-thinking-hidden",
      role: "assistant",
      content: "Answer ready.",
      timestamp: "2026-02-22T10:00:00.000Z",
      model: "claude-opus-4-6",
    };
    const messages: Message[] = [
      {
        ...base,
        thinkingBlocks: [{ content: "first-thought" }],
      },
      {
        ...base,
        thinkingBlocks: [{ content: "second-thought" }],
      },
    ];

    const rendered = renderMessagesToMarkdown(messages, {
      includeFrontmatter: false,
      includeToolCalls: false,
      includeThinking: false,
    });

    assertEquals(rendered.split("Answer ready.").length - 1, 1);
    assertEquals(rendered.includes("first-thought"), false);
    assertEquals(rendered.includes("second-thought"), false);
  },
);
