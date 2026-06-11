import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  MarkdownConversationWriter,
  mergeFrontmatterWriterPolicySnapshot,
  updateFrontmatterMetadataFields,
  updateMarkdownFrontmatterMetadata,
} from "../apps/daemon/src/writer/mod.ts";
import { renderFrontmatter } from "../apps/daemon/src/writer/frontmatter.ts";
import type { ConversationEvent } from "@kato/shared";
import { withTestTempDir } from "./test_temp.ts";

const SAMPLE_CONTENT = [
  "---",
  "id: sample-abc123",
  "title: 'Original Title'",
  "desc: ''",
  "created: 1700000000000",
  "tags: [existing]",
  "---",
  "",
  "# User_2026-06-11_1000_00",
  "",
  "Original body content stays untouched.",
  "",
].join("\n");

function makeAssistantEvent(
  id: string,
  content: string,
  kind: "message.assistant" | "thinking" = "message.assistant",
): ConversationEvent {
  return {
    eventId: id,
    provider: "codex",
    sessionId: "session-1",
    timestamp: "2026-06-11T10:00:00.000Z",
    kind,
    ...(kind === "message.assistant" ? { role: "assistant" } : {}),
    content,
    source: {
      providerEventType: "assistant",
      providerEventId: id,
    },
  } as unknown as ConversationEvent;
}

Deno.test("renderFrontmatter includes the writer policy snapshot when provided", () => {
  const frontmatter = renderFrontmatter({
    title: "Policy Note",
    now: new Date("2026-06-11T10:00:00.000Z"),
    writerPolicy: {
      writerIncludeCommentary: false,
      writerIncludeThinking: true,
    },
  });

  assertStringIncludes(frontmatter, "kato-writerFeatureFlags:");
  assertStringIncludes(frontmatter, "  writerIncludeCommentary: false");
  assertStringIncludes(frontmatter, "  writerIncludeThinking: true");
});

Deno.test("updateFrontmatterMetadataFields updates title, merges tags, and sets policy without touching the body", () => {
  const result = updateFrontmatterMetadataFields(SAMPLE_CONTENT, {
    title: "Renamed Title",
    tags: ["existing", "added"],
    writerPolicy: {
      writerIncludeCommentary: true,
      writerIncludeThinking: false,
    },
  });

  assertEquals(result.changed, true);
  assertEquals(result.hadFrontmatter, true);
  assertStringIncludes(result.content, "title: 'Renamed Title'");
  assertStringIncludes(result.content, "tags: [existing, added]");
  assertStringIncludes(result.content, "writerIncludeThinking: false");
  assertStringIncludes(
    result.content,
    "Original body content stays untouched.",
  );
  assertEquals(
    result.content.split("\n---\n")[1],
    SAMPLE_CONTENT.split("\n---\n")[1],
  );
});

Deno.test("updateFrontmatterMetadataFields reports unchanged content and missing frontmatter", () => {
  const unchanged = updateFrontmatterMetadataFields(SAMPLE_CONTENT, {
    title: "Original Title",
    tags: ["existing"],
  });
  assertEquals(unchanged.changed, false);
  assertEquals(unchanged.hadFrontmatter, true);
  assertEquals(unchanged.content, SAMPLE_CONTENT);

  const noFrontmatter = updateFrontmatterMetadataFields("plain body\n", {
    title: "Renamed",
  });
  assertEquals(noFrontmatter.changed, false);
  assertEquals(noFrontmatter.hadFrontmatter, false);
});

Deno.test("mergeFrontmatterWriterPolicySnapshot replaces the snapshot only when it differs", () => {
  const frontmatter = [
    "---",
    "id: sample-abc123",
    "title: 'Original Title'",
    "kato-writerFeatureFlags:",
    "  writerIncludeCommentary: true",
    "  writerIncludeThinking: true",
    "---",
  ].join("\n");

  const unchanged = mergeFrontmatterWriterPolicySnapshot({
    frontmatter,
    writerPolicy: {
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
    },
  });
  assertEquals(unchanged, frontmatter);

  const updated = mergeFrontmatterWriterPolicySnapshot({
    frontmatter,
    writerPolicy: {
      writerIncludeCommentary: true,
      writerIncludeThinking: false,
    },
  });
  assertStringIncludes(updated, "writerIncludeThinking: false");
});

Deno.test("updateMarkdownFrontmatterMetadata is a best-effort metadata-only file update", async () => {
  await withTestTempDir("writer-frontmatter-metadata-", async (dir) => {
    const outputPath = join(dir, "note.md");
    await Deno.writeTextFile(outputPath, SAMPLE_CONTENT);

    const updated = await updateMarkdownFrontmatterMetadata(outputPath, {
      title: "Renamed Title",
    });
    assertEquals(updated.status, "updated");
    const content = await Deno.readTextFile(outputPath);
    assertStringIncludes(content, "title: 'Renamed Title'");
    assertStringIncludes(content, "Original body content stays untouched.");

    const unchanged = await updateMarkdownFrontmatterMetadata(outputPath, {
      title: "Renamed Title",
    });
    assertEquals(unchanged.status, "unchanged");

    const missing = await updateMarkdownFrontmatterMetadata(
      join(dir, "missing.md"),
      { title: "Renamed" },
    );
    assertEquals(missing.status, "missing-file");

    const jsonlPath = join(dir, "note.jsonl");
    await Deno.writeTextFile(jsonlPath, "{}\n");
    const notMarkdown = await updateMarkdownFrontmatterMetadata(jsonlPath, {
      title: "Renamed",
    });
    assertEquals(notMarkdown.status, "not-markdown");

    const bodyOnlyPath = join(dir, "body-only.md");
    await Deno.writeTextFile(bodyOnlyPath, "plain body\n");
    const noFrontmatter = await updateMarkdownFrontmatterMetadata(
      bodyOnlyPath,
      { title: "Renamed" },
    );
    assertEquals(noFrontmatter.status, "no-frontmatter");
  });
});

Deno.test("markdown append records the effective writer policy snapshot in existing frontmatter", async () => {
  await withTestTempDir("writer-frontmatter-policy-append-", async (dir) => {
    const outputPath = join(dir, "note.md");
    await Deno.writeTextFile(outputPath, SAMPLE_CONTENT);
    const writer = new MarkdownConversationWriter();

    const result = await writer.appendEvents(outputPath, [
      makeAssistantEvent("evt-1", "Visible assistant message."),
      makeAssistantEvent("evt-2", "Hidden thinking content.", "thinking"),
    ], {
      includeThinking: false,
      frontmatterWriterPolicy: {
        writerIncludeCommentary: true,
        writerIncludeThinking: false,
      },
    });

    assertEquals(result.wrote, true);
    const content = await Deno.readTextFile(outputPath);
    assertStringIncludes(content, "kato-writerFeatureFlags:");
    assertStringIncludes(content, "writerIncludeThinking: false");
    assertStringIncludes(content, "Visible assistant message.");
    assertEquals(content.includes("Hidden thinking content."), false);
  });
});
