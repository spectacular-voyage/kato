import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  makeCompactFrontmatterId,
  MarkdownConversationWriter,
  renderEventsToMarkdown,
} from "../apps/daemon/src/mod.ts";
import type { ConversationEvent } from "@kato/shared";
import { makeTestTempPath, removePathIfPresent } from "./test_temp.ts";

function makeSandboxRoot(): string {
  return makeTestTempPath("test-writer-markdown-");
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
    await removePathIfPresent(root);
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
    await removePathIfPresent(root);
  }
});

Deno.test(
  "MarkdownConversationWriter create can render rich frontmatter and omit updated",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation.md");
    const writer = new MarkdownConversationWriter();

    try {
      await writer.appendEvents(outputPath, [
        makeEvent(
          "e1",
          "message.user",
          "hello",
          "2026-02-22T10:00:00.000Z",
        ),
      ], {
        title: "Conversation Session",
        includeUpdatedInFrontmatter: false,
        frontmatterSessionIds: ["12345678-abcdef"],
        frontmatterRecordingCycleIds: ["rec-seed"],
        frontmatterParticipants: ["djradon", "codex.gpt-5.3-codex"],
        frontmatterTags: ["provider.codex"],
        frontmatterConversationEventKinds: ["message.user"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(content, "id: conversation-session-recseed");
      assertStringIncludes(content, "kato-sessionIds: [12345678-abcdef]");
      assertStringIncludes(content, "kato-recordingIds: [rec-seed]");
      assertStringIncludes(
        content,
        "participants: [djradon, codex.gpt-5.3-codex]",
      );
      assertStringIncludes(
        content,
        "tags: [provider.codex]",
      );
      assertStringIncludes(
        content,
        "conversationEventKinds: [message.user]",
      );
      assertEquals(content.includes("\nupdated:"), false);
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test(
  "MarkdownConversationWriter default id falls back to session id when recording id is absent",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation-session-fallback.md");
    const writer = new MarkdownConversationWriter();

    try {
      await writer.appendEvents(outputPath, [
        makeEvent(
          "e-session-fallback",
          "message.user",
          "hello",
          "2026-02-22T10:00:00.000Z",
        ),
      ], {
        title: "Conversation Session",
        includeUpdatedInFrontmatter: false,
        frontmatterSessionIds: ["12345678-abcdef"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(content, "id: conversation-session-12345678");
      assertStringIncludes(content, "kato-sessionIds: [12345678-abcdef]");
      assertEquals(content.includes("kato-recordingIds:"), false);
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test(
  "MarkdownConversationWriter quotes ambiguous scalar-like frontmatter strings",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation.md");
    const writer = new MarkdownConversationWriter();

    try {
      await writer.appendEvents(outputPath, [
        makeEvent(
          "e1",
          "message.user",
          "hello",
          "2026-02-22T10:00:00.000Z",
        ),
      ], {
        includeFrontmatter: true,
        frontmatterRecordingCycleIds: ["123", "true", "null", "~", "rec-safe"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(
        content,
        "kato-recordingIds: ['123', 'true', 'null', '~', rec-safe]",
      );
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test(
  "MarkdownConversationWriter append accretively updates recordingCycleIds, tags, and conversationEventKinds in existing frontmatter",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation.md");
    const writer = new MarkdownConversationWriter();

    try {
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        outputPath,
        [
          "---",
          "id: seed-frontmatter",
          "title: 'Seed Conversation'",
          "desc: ''",
          "created: 1",
          "updated: 1",
          "kato-recordingIds: [rec-old]",
          "tags: [provider.codex]",
          "conversationEventKinds: [message.user]",
          "---",
          "",
          "# User_2026-02-22_1000_00",
          "",
          "seed body",
          "",
        ].join("\n"),
      );

      await writer.appendEvents(outputPath, [
        makeEvent(
          "e2",
          "message.assistant",
          "assistant reply",
          "2026-02-22T10:00:01.000Z",
        ),
      ], {
        includeFrontmatter: true,
        frontmatterRecordingCycleIds: ["rec-new"],
        frontmatterTags: ["topic.frontmatter"],
        frontmatterConversationEventKinds: ["message.assistant"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(content, "kato-recordingIds: [rec-old, rec-new]");
      assertStringIncludes(
        content,
        "tags: [provider.codex, topic.frontmatter]",
      );
      assertStringIncludes(
        content,
        "conversationEventKinds: [message.user, message.assistant]",
      );
      assertEquals(content.includes("\nparticipants:"), false);
      assertStringIncludes(content, "assistant reply");
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test(
  "MarkdownConversationWriter keeps existing tags untouched and only merges canonical fields",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation.md");
    const writer = new MarkdownConversationWriter();

    try {
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        outputPath,
        [
          "---",
          "id: seed-frontmatter",
          "title: 'Seed Conversation'",
          "desc: ''",
          "created: 1",
          "updated: 1",
          "participants: [djradon]",
          "tags: [provider.codex, kind.message.user, topic.keep]",
          "conversationEventKinds: [message.assistant]",
          "---",
          "",
          "# User_2026-02-22_1000_00",
          "",
          "seed body",
          "",
        ].join("\n"),
      );

      await writer.appendEvents(outputPath, [
        makeEvent(
          "e2",
          "message.assistant",
          "assistant reply",
          "2026-02-22T10:00:01.000Z",
        ),
      ], {
        includeFrontmatter: true,
        frontmatterParticipants: ["codex.gpt-5.3-codex"],
        frontmatterConversationEventKinds: ["tool.call"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(
        content,
        "participants: [djradon, codex.gpt-5.3-codex]",
      );
      assertStringIncludes(
        content,
        "tags: [provider.codex, kind.message.user, topic.keep]",
      );
      assertStringIncludes(
        content,
        "conversationEventKinds: [message.assistant, tool.call]",
      );
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test(
  "MarkdownConversationWriter still updates accretive frontmatter fields when includeFrontmatter is false",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation.md");
    const writer = new MarkdownConversationWriter();

    try {
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        outputPath,
        [
          "---",
          "id: seed-frontmatter",
          "title: 'Seed Conversation'",
          "desc: ''",
          "created: 1",
          "updated: 1",
          "kato-recordingIds: [rec-old]",
          "tags: [provider.codex]",
          "conversationEventKinds: [message.user]",
          "---",
          "",
          "seed body",
          "",
        ].join("\n"),
      );

      await writer.appendEvents(outputPath, [
        makeEvent(
          "e2",
          "message.assistant",
          "assistant follow-up",
          "2026-02-22T10:00:01.000Z",
        ),
      ], {
        includeFrontmatter: false,
        frontmatterRecordingCycleIds: ["rec-new"],
        frontmatterTags: ["topic.extra"],
        frontmatterConversationEventKinds: ["message.assistant"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(content, "kato-recordingIds: [rec-old, rec-new]");
      assertStringIncludes(
        content,
        "tags: [provider.codex, topic.extra]",
      );
      assertStringIncludes(
        content,
        "conversationEventKinds: [message.user, message.assistant]",
      );
      assertEquals(content.includes("\nparticipants:"), false);
      assertStringIncludes(content, "assistant follow-up");
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test(
  "MarkdownConversationWriter preserves unknown frontmatter keys while merging canonical fields",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation.md");
    const writer = new MarkdownConversationWriter();

    try {
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        outputPath,
        [
          "---",
          "id: seed-frontmatter",
          "title: 'Seed Conversation'",
          "desc: ''",
          "created: 1",
          "updated: 1",
          "kato-recordingIds: [rec-old]",
          "messageEventKinds: [message.user]",
          "---",
          "",
          "seed body",
          "",
        ].join("\n"),
      );

      await writer.appendEvents(outputPath, [
        makeEvent(
          "e2",
          "message.assistant",
          "assistant follow-up",
          "2026-02-22T10:00:01.000Z",
        ),
      ], {
        includeFrontmatter: false,
        frontmatterConversationEventKinds: ["message.assistant"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(
        content,
        "conversationEventKinds: [message.assistant]",
      );
      assertStringIncludes(content, "messageEventKinds: [message.user]");
      assertStringIncludes(content, "assistant follow-up");
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test(
  "MarkdownConversationWriter preserves whitespace in unchanged frontmatter scalar fields",
  async () => {
    const root = makeSandboxRoot();
    const outputPath = join(root, "conversation.md");
    const writer = new MarkdownConversationWriter();

    try {
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        outputPath,
        [
          "---",
          "id: seed-frontmatter",
          "title: 'Seed Conversation'",
          "desc: ''",
          "created: 1",
          "updated: 1",
          "customPadded: '  keep me padded  '",
          "tags: [topic.seed]",
          "---",
          "",
          "seed body",
          "",
        ].join("\n"),
      );

      await writer.appendEvents(outputPath, [
        makeEvent(
          "e2",
          "message.assistant",
          "assistant follow-up",
          "2026-02-22T10:00:01.000Z",
        ),
      ], {
        includeFrontmatter: false,
        frontmatterRecordingCycleIds: ["rec-new"],
      });

      const content = await Deno.readTextFile(outputPath);
      assertStringIncludes(content, "customPadded: '  keep me padded  '");
      assertStringIncludes(content, "kato-recordingIds: [rec-new]");
      assertStringIncludes(content, "assistant follow-up");
    } finally {
      await removePathIfPresent(root);
    }
  },
);

Deno.test("MarkdownConversationWriter create respects includeFrontmatter false", async () => {
  const root = makeSandboxRoot();
  const outputPath = join(root, "conversation.md");
  const writer = new MarkdownConversationWriter();

  try {
    await writer.appendEvents(outputPath, [
      makeEvent(
        "e1",
        "message.user",
        "no frontmatter",
        "2026-02-22T10:00:00.000Z",
      ),
    ], {
      includeFrontmatter: false,
      title: "No Frontmatter",
    });

    const content = await Deno.readTextFile(outputPath);
    assertEquals(content.startsWith("---\n"), false);
    assertStringIncludes(content, "no frontmatter");
  } finally {
    await removePathIfPresent(root);
  }
});

Deno.test(
  "renderEventsToMarkdown rewrites local markdown note links to Dendron wikilinks",
  () => {
    const assistant = makeEvent(
      "assistant-dendron-links",
      "message.assistant",
      [
        "See [dev.general-guidance.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md).",
        "Also [task note](dev-docs/notes/task.2026.2026-04-04-dendron-style-links.md#Goal).",
        "Windows path: [todo](C:\\Users\\djradon\\notes\\dev.todo.md).",
        "Protocol-relative stays [cdn](//example.com/dev.todo.md).",
        "External link stays [OpenAI](https://openai.com).",
        "Anchor stays [section](#local-anchor).",
      ].join("\n"),
      "2026-04-04T10:00:00.000Z",
    );

    const rendered = renderEventsToMarkdown([assistant], {
      includeFrontmatter: false,
      markdownLinkStyle: "dendron-wikilink",
    });

    assertStringIncludes(rendered, "[[dev.general-guidance]]");
    assertStringIncludes(
      rendered,
      "[[task.2026.2026-04-04-dendron-style-links#Goal]]",
    );
    assertStringIncludes(rendered, "[[dev.todo]]");
    assertStringIncludes(rendered, "[cdn](//example.com/dev.todo.md)");
    assertStringIncludes(rendered, "[OpenAI](https://openai.com)");
    assertStringIncludes(rendered, "[section](#local-anchor)");
    assertEquals(
      rendered.includes(
        "/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md",
      ),
      false,
    );
  },
);

Deno.test(
  "renderEventsToMarkdown keeps local markdown links unchanged for standard link style",
  () => {
    const assistant = makeEvent(
      "assistant-standard-links",
      "message.assistant",
      [
        "See [dev.general-guidance.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md).",
        "Also [task note](dev-docs/notes/task.2026.2026-04-04-dendron-style-links.md#Goal).",
      ].join("\n"),
      "2026-04-04T10:05:00.000Z",
    );

    const rendered = renderEventsToMarkdown([assistant], {
      includeFrontmatter: false,
      markdownLinkStyle: "standard",
    });

    assertStringIncludes(
      rendered,
      "[dev.general-guidance.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md)",
    );
    assertStringIncludes(
      rendered,
      "[task note](dev-docs/notes/task.2026.2026-04-04-dendron-style-links.md#Goal)",
    );
    assertEquals(rendered.includes("[[dev.general-guidance]]"), false);
    assertEquals(
      rendered.includes(
        "[[task.2026.2026-04-04-dendron-style-links#Goal]]",
      ),
      false,
    );
  },
);

Deno.test(
  "renderEventsToMarkdown rewrites Dendron links across tool thinking decision and provider info sections",
  () => {
    const toolCall: ConversationEvent = {
      eventId: "tool-call-dendron-extra-surfaces",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-04-04T10:10:00.000Z",
      kind: "tool.call",
      toolCallId: "tool-dendron-extra-surfaces",
      name: "read_note",
      description:
        "Inspect [dev.general-guidance.md](/workspace/dev-docs/notes/dev.general-guidance.md) and keep ![diagram](diagram.png).",
      source: {
        providerEventType: "tool_call",
        providerEventId: "tool-call-dendron-extra-surfaces",
      },
    } as unknown as ConversationEvent;
    const thinking: ConversationEvent = {
      eventId: "thinking-dendron-extra-surfaces",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-04-04T10:10:01.000Z",
      kind: "thinking",
      content:
        "Need [dev.todo](dev-docs/notes/dev.todo.md#Next) but leave [query](dev-docs/notes/dev.todo.md?view=full) alone.",
      source: {
        providerEventType: "thinking",
        providerEventId: "thinking-dendron-extra-surfaces",
      },
    } as unknown as ConversationEvent;
    const questionnaireDecision: ConversationEvent = {
      eventId: "decision-questionnaire-dendron-extra-surfaces",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-04-04T10:10:02.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-dendron-extra-surfaces",
      decisionKey: "note-export-target",
      summary:
        "Review [task note](dev-docs/notes/task.2026.2026-04-04-dendron-style-links.md#Goal)",
      status: "proposed",
      decidedBy: "assistant",
      basisEventIds: ["tool-call-dendron-extra-surfaces"],
      metadata: {
        providerQuestionId: "note_export_target",
        options: [{
          label: "Decision log",
          description:
            "Cross-check [dev.decision-log.md](/workspace/dev-docs/notes/dev.decision-log.md).",
        }],
      },
      source: {
        providerEventType: "response_item.function_call.request_user_input",
        providerEventId: "decision-questionnaire-dendron-extra-surfaces",
      },
    } as unknown as ConversationEvent;
    const genericDecision: ConversationEvent = {
      eventId: "decision-generic-dendron-extra-surfaces",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-04-04T10:10:03.000Z",
      kind: "decision",
      decisionId: "decision-generic-dendron-extra-surfaces",
      decisionKey: "note-target",
      summary:
        "Use [completed note](/workspace/dev-docs/notes/completed.2026.2026-04-04-dendron-style-links.md)",
      status: "accepted",
      decidedBy: "assistant",
      basisEventIds: ["tool-call-dendron-extra-surfaces"],
      source: {
        providerEventType: "system",
        providerEventId: "decision-generic-dendron-extra-surfaces",
      },
    } as unknown as ConversationEvent;
    const providerInfo: ConversationEvent = {
      eventId: "provider-info-dendron-extra-surfaces",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-04-04T10:10:04.000Z",
      kind: "provider.info",
      subtype: "notice",
      content:
        "Indexed [product ideas](/workspace/dev-docs/notes/product-ideas.md) and kept ![diagram](diagram.png).",
      source: {
        providerEventType: "provider.info",
        providerEventId: "provider-info-dendron-extra-surfaces",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([
      toolCall,
      thinking,
      questionnaireDecision,
      genericDecision,
      providerInfo,
    ], {
      includeFrontmatter: false,
      includeToolCalls: true,
      includeThinking: true,
      includeSystemEvents: true,
      markdownLinkStyle: "dendron-wikilink",
    });

    assertStringIncludes(rendered, "[[dev.general-guidance]]");
    assertStringIncludes(rendered, "![diagram](diagram.png)");
    assertStringIncludes(rendered, "[[dev.todo#Next]]");
    assertStringIncludes(
      rendered,
      "[query](dev-docs/notes/dev.todo.md?view=full)",
    );
    assertStringIncludes(
      rendered,
      "[[task.2026.2026-04-04-dendron-style-links#Goal]]",
    );
    assertStringIncludes(rendered, "[[dev.decision-log]]");
    assertStringIncludes(
      rendered,
      "[[completed.2026.2026-04-04-dendron-style-links]]",
    );
    assertStringIncludes(rendered, "[[product-ideas]]");
  },
);

Deno.test(
  "renderEventsToMarkdown skips fenced code inline code and escaped link syntax",
  () => {
    const assistant = makeEvent(
      "assistant-dendron-code-spans",
      "message.assistant",
      [
        "Visible [note](/tmp/dev.todo.md).",
        "",
        "```md",
        "[fenced](/tmp/dev.general-guidance.md)",
        "```",
        "",
        "Inline ` [inline](/tmp/product-ideas.md) ` stays literal.",
        String
          .raw`Escaped \[escaped](/tmp/completed.2026.2026-04-04-dendron-style-links.md) stays literal.`,
      ].join("\n"),
      "2026-04-04T10:06:00.000Z",
    );

    const rendered = renderEventsToMarkdown([assistant], {
      includeFrontmatter: false,
      markdownLinkStyle: "dendron-wikilink",
    });

    assertStringIncludes(rendered, "Visible [[dev.todo]].");
    assertStringIncludes(
      rendered,
      "```md\n[fenced](/tmp/dev.general-guidance.md)\n```",
    );
    assertStringIncludes(
      rendered,
      "` [inline](/tmp/product-ideas.md) `",
    );
    assertStringIncludes(
      rendered,
      String
        .raw`\[escaped](/tmp/completed.2026.2026-04-04-dendron-style-links.md)`,
    );
    assertEquals(rendered.includes("[[dev.general-guidance]]"), false);
    assertEquals(rendered.includes("[[product-ideas]]"), false);
    assertEquals(
      rendered.includes(
        "[[completed.2026.2026-04-04-dendron-style-links]]",
      ),
      false,
    );
  },
);

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
  "renderEventsToMarkdown can show tool calls without tool results",
  () => {
    const assistant = makeEvent(
      "assistant-tool-no-results",
      "message.assistant",
      "Done.",
      "2026-02-22T10:00:00.000Z",
    );
    const toolCall: ConversationEvent = {
      eventId: "tc-no-results",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "tool.call",
      toolCallId: "tool-no-results",
      name: "search",
      description: "search internet for weather",
      input: { q: "weather sf" },
      source: {
        providerEventType: "tool_call",
        providerEventId: "tc-no-results",
      },
    } as unknown as ConversationEvent;
    const toolResult: ConversationEvent = {
      eventId: "tr-no-results",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "tool.result",
      toolCallId: "tool-no-results",
      result: "result-content",
      source: {
        providerEventType: "tool_result",
        providerEventId: "tr-no-results",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([assistant, toolCall, toolResult], {
      includeFrontmatter: false,
      includeToolCalls: true,
      includeToolResults: false,
      includeThinking: false,
    });

    assertMatch(
      rendered,
      /^# Assistant_\d{4}-\d{2}-\d{2}_\d{4}_\d{2}_Tool-search$/m,
    );
    assertStringIncludes(rendered, "search internet for weather");
    assertEquals(rendered.includes('"q": "weather sf"'), false);
    assertEquals(rendered.includes("result-content"), false);
  },
);

Deno.test("renderEventsToMarkdown respects headingTimestampTimezone", () => {
  const assistant = makeEvent(
    "assistant-heading-tz",
    "message.assistant",
    "Done.",
    "2026-02-22T10:00:00.000Z",
  );

  const renderedUtc = renderEventsToMarkdown([assistant], {
    includeFrontmatter: false,
    headingTimestampTimezone: "UTC",
  });
  const renderedLosAngeles = renderEventsToMarkdown([assistant], {
    includeFrontmatter: false,
    headingTimestampTimezone: "America/Los_Angeles",
  });

  assertStringIncludes(renderedUtc, "# Assistant_2026-02-22_1000_00");
  assertStringIncludes(
    renderedLosAngeles,
    "# Assistant_2026-02-22_0200_00",
  );
});

Deno.test(
  "renderEventsToMarkdown uses latest assistant model for tool call headings",
  () => {
    const assistant: ConversationEvent = {
      eventId: "assistant-tool-heading-model",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-03-02T10:22:08.000Z",
      kind: "message.assistant",
      role: "assistant",
      model: "gpt-5.3-codex",
      content: "Preparing command.",
      source: {
        providerEventType: "assistant",
        providerEventId: "assistant-tool-heading-model",
      },
    } as unknown as ConversationEvent;
    const toolCall: ConversationEvent = {
      eventId: "tc-heading-model",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-03-02T10:22:09.000Z",
      kind: "tool.call",
      toolCallId: "tool-heading-model",
      name: "exec_command",
      description:
        "sed -n '1680,1775p' apps/daemon/src/orchestrator/daemon_runtime.ts",
      source: {
        providerEventType: "tool_call",
        providerEventId: "tc-heading-model",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([assistant, toolCall], {
      includeFrontmatter: false,
      includeToolCalls: true,
      includeToolResults: false,
      includeThinking: false,
    });

    assertMatch(
      rendered,
      /^# gpt-5\.3-codex_\d{4}-\d{2}-\d{2}_\d{4}_\d{2}_Tool-exec_command$/m,
    );
    assertStringIncludes(
      rendered,
      "sed -n '1680,1775p' apps/daemon/src/orchestrator/daemon_runtime.ts",
    );
  },
);

Deno.test(
  "renderEventsToMarkdown keeps latest model heading for tool calls when assistant events omit model",
  () => {
    const assistantWithModel: ConversationEvent = {
      eventId: "assistant-tool-heading-with-model",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-03-02T10:22:08.000Z",
      kind: "message.assistant",
      role: "assistant",
      model: "gpt-5.3-codex",
      content: "Preparing command.",
      source: {
        providerEventType: "assistant",
        providerEventId: "assistant-tool-heading-with-model",
      },
    } as unknown as ConversationEvent;
    const assistantWithoutModel: ConversationEvent = {
      eventId: "assistant-tool-heading-without-model",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-03-02T10:22:09.000Z",
      kind: "message.assistant",
      role: "assistant",
      content: "Continuing plan.",
      source: {
        providerEventType: "assistant",
        providerEventId: "assistant-tool-heading-without-model",
      },
    } as unknown as ConversationEvent;
    const toolCall: ConversationEvent = {
      eventId: "tc-heading-stable-model",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-03-02T10:22:10.000Z",
      kind: "tool.call",
      toolCallId: "tool-heading-stable-model",
      name: "exec_command",
      description: 'rg -n "Tool-exec_command" -S',
      source: {
        providerEventType: "tool_call",
        providerEventId: "tc-heading-stable-model",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown(
      [assistantWithModel, assistantWithoutModel, toolCall],
      {
        includeFrontmatter: false,
        includeToolCalls: true,
        includeToolResults: false,
        includeThinking: false,
      },
    );

    assertMatch(
      rendered,
      /^# gpt-5\.3-codex_\d{4}-\d{2}-\d{2}_\d{4}_\d{2}_Tool-exec_command$/m,
    );
    assertEquals(
      /# Assistant_\d{4}-\d{2}-\d{2}_\d{4}_\d{2}_Tool-exec_command/.test(
        rendered,
      ),
      false,
    );
  },
);

Deno.test(
  "renderEventsToMarkdown infers tool call heading model when tool calls precede assistant messages",
  () => {
    const toolCallBeforeAssistant: ConversationEvent = {
      eventId: "tc-heading-before-assistant",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-03-02T10:22:07.000Z",
      kind: "tool.call",
      toolCallId: "tool-heading-before-assistant",
      name: "exec_command",
      description: "sed -n '1,120p' apps/daemon/src/writer/markdown_writer.ts",
      source: {
        providerEventType: "tool_call",
        providerEventId: "tc-heading-before-assistant",
      },
    } as unknown as ConversationEvent;
    const assistantWithModel: ConversationEvent = {
      eventId: "assistant-heading-after-tool",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-03-02T10:22:08.000Z",
      kind: "message.assistant",
      role: "assistant",
      model: "gpt-5.3-codex",
      content: "Inspecting file now.",
      source: {
        providerEventType: "assistant",
        providerEventId: "assistant-heading-after-tool",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown(
      [toolCallBeforeAssistant, assistantWithModel],
      {
        includeFrontmatter: false,
        includeToolCalls: true,
        includeToolResults: false,
        includeThinking: false,
      },
    );

    assertMatch(
      rendered,
      /^# gpt-5\.3-codex_\d{4}-\d{2}-\d{2}_\d{4}_\d{2}_Tool-exec_command$/m,
    );
    assertEquals(
      /# Assistant_\d{4}-\d{2}-\d{2}_\d{4}_\d{2}_Tool-exec_command/.test(
        rendered,
      ),
      false,
    );
  },
);

Deno.test(
  "renderEventsToMarkdown can show standalone tool results when tool calls are hidden",
  () => {
    const assistant = makeEvent(
      "assistant-tool-results-only",
      "message.assistant",
      "Done.",
      "2026-02-22T10:00:00.000Z",
    );
    const toolCall: ConversationEvent = {
      eventId: "tc-results-only",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "tool.call",
      toolCallId: "tool-results-only",
      name: "search",
      source: {
        providerEventType: "tool_call",
        providerEventId: "tc-results-only",
      },
    } as unknown as ConversationEvent;
    const toolResult: ConversationEvent = {
      eventId: "tr-results-only",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "tool.result",
      toolCallId: "tool-results-only",
      result: "result-content",
      source: {
        providerEventType: "tool_result",
        providerEventId: "tr-results-only",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([assistant, toolCall, toolResult], {
      includeFrontmatter: false,
      includeToolCalls: false,
      includeToolResults: true,
      includeThinking: false,
    });

    assertStringIncludes(
      rendered,
      "<summary>Tool result: tool-results-only</summary>",
    );
    assertStringIncludes(rendered, "result-content");
    assertEquals(rendered.includes("<summary>Tool: search</summary>"), false);
  },
);

Deno.test(
  "renderEventsToMarkdown resets duplicate suppression after standalone tool result blocks",
  () => {
    const assistant: ConversationEvent = {
      eventId: "assistant-dup-reset",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "message.assistant",
      role: "assistant",
      content: "Repeated message around tool result.",
      source: {
        providerEventType: "assistant",
        providerEventId: "assistant-dup-reset",
      },
    } as unknown as ConversationEvent;
    const toolResult: ConversationEvent = {
      eventId: "tr-dup-reset",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      kind: "tool.result",
      toolCallId: "tool-dup-reset",
      result: "tool result payload",
      source: {
        providerEventType: "tool_result",
        providerEventId: "tr-dup-reset",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown(
      [assistant, toolResult, assistant],
      {
        includeFrontmatter: false,
        includeToolCalls: false,
        includeToolResults: true,
        includeThinking: false,
      },
    );

    assertEquals(
      rendered.split("Repeated message around tool result.").length - 1,
      2,
    );
    assertStringIncludes(
      rendered,
      "<summary>Tool result: tool-dup-reset</summary>",
    );
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
    assertEquals(rendered.includes("<details>"), false);
    assertEquals(rendered.includes("<summary>Thinking</summary>"), false);
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
  "renderEventsToMarkdown renders questionnaire proposed decisions with options list",
  () => {
    const questionnairePrompt: ConversationEvent = {
      eventId: "decision-questionnaire-proposed-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-proposed-1",
      decisionKey: "plan-mode-capture-round",
      summary: "Which capture behavior should we validate?",
      status: "proposed",
      decidedBy: "assistant",
      basisEventIds: ["tool-call-1"],
      metadata: {
        providerQuestionId: "plan_mode_capture_round",
        options: [
          {
            label: "Prompt + options + answer (Recommended)",
            description: "Capture question text, options, and selected answer.",
          },
          {
            label: "Prompt + options only",
            description: "Capture only question text and options.",
          },
        ],
      },
      source: {
        providerEventType: "response_item.function_call.request_user_input",
        providerEventId: "decision-questionnaire-proposed-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([questionnairePrompt], {
      includeFrontmatter: false,
      headingTimestampTimezone: "UTC",
    });

    assertStringIncludes(
      rendered,
      "# Assistant_2026-02-22_1000_00_Tool-decision-plan-mode-capture-round",
    );
    assertStringIncludes(
      rendered,
      "## Prompt",
    );
    assertStringIncludes(
      rendered,
      "Which capture behavior should we validate?",
    );
    assertStringIncludes(
      rendered,
      "## Options",
    );
    assertStringIncludes(
      rendered,
      "- Prompt + options + answer (Recommended): Capture question text, options, and selected answer.",
    );
    assertStringIncludes(
      rendered,
      "- Prompt + options only: Capture only question text and options.",
    );
    assertEquals(rendered.includes("*Status: proposed"), false);
  },
);

Deno.test(
  "renderEventsToMarkdown renders questionnaire accepted decisions with prompt options and selection",
  () => {
    const questionnaireDecision: ConversationEvent = {
      eventId: "decision-questionnaire-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-1",
      decisionKey: "decision-line-policy",
      summary: "Which output format should we use? -> Show both (Recommended)",
      status: "accepted",
      decidedBy: "user",
      basisEventIds: ["tool-result-1"],
      metadata: {
        providerQuestionId: "decision_line_policy",
        options: [{
          label: "Show both (Recommended)",
          description: "Display both formats together.",
        }],
      },
      source: {
        providerEventType:
          "response_item.function_call_output.request_user_input",
        providerEventId: "decision-questionnaire-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([questionnaireDecision], {
      includeFrontmatter: false,
      headingTimestampTimezone: "UTC",
    });

    assertStringIncludes(
      rendered,
      "# Assistant_2026-02-22_1000_00_Tool-decision-decision-line-policy",
    );
    assertStringIncludes(rendered, "## Prompt");
    assertStringIncludes(
      rendered,
      "Which output format should we use?",
    );
    assertStringIncludes(rendered, "## Options");
    assertStringIncludes(
      rendered,
      "- Show both (Recommended): Display both formats together.",
    );
    assertStringIncludes(rendered, "## User Selection");
    assertStringIncludes(
      rendered,
      "Show both (Recommended)",
    );
    assertEquals(rendered.includes("*Status: accepted"), false);
  },
);

Deno.test(
  "renderEventsToMarkdown reuses questionnaire context across dash/underscore key variants",
  () => {
    const proposedDecision: ConversationEvent = {
      eventId: "decision-questionnaire-proposed-separator-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-proposed-separator-1",
      decisionKey: "decision-line-policy",
      summary: "Which output format should we use?",
      status: "proposed",
      decidedBy: "assistant",
      basisEventIds: ["tool-call-1"],
      metadata: {
        options: [{
          label: "Markdown",
          description: "Use markdown output.",
        }],
      },
      source: {
        providerEventType: "response_item.function_call.request_user_input",
        providerEventId: "decision-questionnaire-proposed-separator-1",
      },
    } as unknown as ConversationEvent;
    const acceptedDecision: ConversationEvent = {
      eventId: "decision-questionnaire-accepted-separator-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:01:00.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-accepted-separator-1",
      decisionKey: "decision_line_policy",
      summary: "Markdown",
      status: "accepted",
      decidedBy: "user",
      basisEventIds: ["tool-result-1"],
      metadata: {
        providerQuestionId: "decision_line_policy",
      },
      source: {
        providerEventType:
          "response_item.function_call_output.request_user_input",
        providerEventId: "decision-questionnaire-accepted-separator-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown(
      [proposedDecision, acceptedDecision],
      { includeFrontmatter: false },
    );

    assertStringIncludes(rendered, "## Prompt");
    assertStringIncludes(rendered, "Which output format should we use?");
    assertStringIncludes(rendered, "## Options");
    assertStringIncludes(rendered, "- Markdown: Use markdown output.");
    assertStringIncludes(rendered, "## User Selection");
    assertStringIncludes(rendered, "Markdown");
  },
);

Deno.test(
  "renderEventsToMarkdown can hide questionnaire decision options while keeping prompt",
  () => {
    const questionnairePrompt: ConversationEvent = {
      eventId: "decision-questionnaire-proposed-options-hidden-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-proposed-options-hidden-1",
      decisionKey: "decision-options-visibility",
      summary: "Which output format should we use?",
      status: "proposed",
      decidedBy: "assistant",
      basisEventIds: ["tool-call-1"],
      metadata: {
        providerQuestionId: "decision_options_visibility",
        options: [{
          label: "Markdown",
          description: "Use markdown output.",
        }],
      },
      source: {
        providerEventType: "response_item.function_call.request_user_input",
        providerEventId: "decision-questionnaire-proposed-options-hidden-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([questionnairePrompt], {
      includeFrontmatter: false,
      includeDecisionPrompt: true,
      includeDecisionOptions: false,
      headingTimestampTimezone: "UTC",
    });

    assertStringIncludes(
      rendered,
      "# Assistant_2026-02-22_1000_00_Tool-decision-decision-options-visibility",
    );
    assertStringIncludes(rendered, "## Prompt");
    assertStringIncludes(rendered, "Which output format should we use?");
    assertEquals(rendered.includes("## Options"), false);
    assertEquals(rendered.includes("- Markdown: Use markdown output."), false);
  },
);

Deno.test(
  "renderEventsToMarkdown can hide accepted questionnaire decision selections",
  () => {
    const questionnaireDecision: ConversationEvent = {
      eventId: "decision-questionnaire-selection-hidden-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      kind: "decision",
      decisionId: "decision-questionnaire-selection-hidden-1",
      decisionKey: "decision-selection-visibility",
      summary: "decision_selection_visibility -> Markdown",
      status: "accepted",
      decidedBy: "user",
      basisEventIds: ["tool-result-1"],
      metadata: {
        providerQuestionId: "decision_selection_visibility",
      },
      source: {
        providerEventType:
          "response_item.function_call_output.request_user_input",
        providerEventId: "decision-questionnaire-selection-hidden-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([questionnaireDecision], {
      includeFrontmatter: false,
      includeDecisionSelection: false,
    });

    assertEquals(rendered.includes("decision_selection_visibility"), false);
  },
);

Deno.test(
  "renderEventsToMarkdown suppresses identical commentary when same-turn final repeats it",
  () => {
    const commentary: ConversationEvent = {
      eventId: "assistant-commentary-dup-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      turnId: "turn-dup-1",
      kind: "message.assistant",
      role: "assistant",
      content: "Done. Your selected answer was: `Alpha`.",
      phase: "commentary",
      source: {
        providerEventType: "event_msg.agent_message",
        providerEventId: "assistant-commentary-dup-1",
      },
    } as unknown as ConversationEvent;
    const finalAnswer: ConversationEvent = {
      eventId: "assistant-final-dup-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      turnId: "turn-dup-1",
      kind: "message.assistant",
      role: "assistant",
      content: "Done. Your selected answer was: `Alpha`.",
      phase: "final",
      source: {
        providerEventType: "response_item.message.final_answer",
        providerEventId: "assistant-final-dup-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([commentary, finalAnswer], {
      includeFrontmatter: false,
      includeCommentary: true,
    });

    assertEquals(
      rendered.split("Done. Your selected answer was: `Alpha`.").length - 1,
      1,
    );
  },
);

Deno.test(
  "renderEventsToMarkdown suppresses commentary duplicates after Dendron link normalization",
  () => {
    const commentary: ConversationEvent = {
      eventId: "assistant-commentary-link-normalized-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      turnId: "turn-link-normalized-1",
      kind: "message.assistant",
      role: "assistant",
      content: "See [first label](/tmp/dev.todo.md).",
      phase: "commentary",
      source: {
        providerEventType: "event_msg.agent_message",
        providerEventId: "assistant-commentary-link-normalized-1",
      },
    } as unknown as ConversationEvent;
    const finalAnswer: ConversationEvent = {
      eventId: "assistant-final-link-normalized-1",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      turnId: "turn-link-normalized-1",
      kind: "message.assistant",
      role: "assistant",
      content: "See [second label](/tmp/dev.todo.md).",
      phase: "final",
      source: {
        providerEventType: "response_item.message.final_answer",
        providerEventId: "assistant-final-link-normalized-1",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([commentary, finalAnswer], {
      includeFrontmatter: false,
      includeCommentary: true,
      markdownLinkStyle: "dendron-wikilink",
    });

    assertEquals(rendered.split("See [[dev.todo]].").length - 1, 1);
  },
);

Deno.test(
  "renderEventsToMarkdown suppresses immediate duplicate assistant messages with same turn and content",
  () => {
    const first: ConversationEvent = {
      eventId: "assistant-dup-a",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:00.000Z",
      turnId: "turn-dup-2",
      kind: "message.assistant",
      role: "assistant",
      content: "Repeated assistant text.",
      phase: "final",
      source: {
        providerEventType: "response_item.message.final_answer",
        providerEventId: "assistant-dup-a",
      },
    } as unknown as ConversationEvent;
    const second: ConversationEvent = {
      eventId: "assistant-dup-b",
      provider: "test",
      sessionId: "sess-test",
      timestamp: "2026-02-22T10:00:01.000Z",
      turnId: "turn-dup-2",
      kind: "message.assistant",
      role: "assistant",
      content: "Repeated assistant text.",
      phase: "final",
      source: {
        providerEventType: "event_msg.task_complete",
        providerEventId: "assistant-dup-b",
      },
    } as unknown as ConversationEvent;

    const rendered = renderEventsToMarkdown([first, second], {
      includeFrontmatter: false,
      includeCommentary: true,
    });

    assertEquals(rendered.split("Repeated assistant text.").length - 1, 1);
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
