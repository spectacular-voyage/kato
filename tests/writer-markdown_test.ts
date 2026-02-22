import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  makeCompactFrontmatterId,
  MarkdownConversationWriter,
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
