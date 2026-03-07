import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import { JsonlConversationWriter } from "../apps/daemon/src/writer/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

function makeEvent(
  id: string,
  kind: "message.user" | "message.assistant",
  content: string,
): ConversationEvent {
  if (kind === "message.user") {
    return {
      eventId: id,
      provider: "test",
      sessionId: "sess-test",
      timestamp: `2026-03-06T10:00:0${id.endsWith("2") ? "1" : "0"}.000Z`,
      kind: "message.user",
      role: "user",
      content,
      source: {
        providerEventType: "user",
        providerEventId: id,
      },
    };
  }
  return {
    eventId: id,
    provider: "test",
    sessionId: "sess-test",
    timestamp: `2026-03-06T10:00:0${id.endsWith("2") ? "1" : "0"}.000Z`,
    kind: "message.assistant",
    role: "assistant",
    content,
    source: {
      providerEventType: "assistant",
      providerEventId: id,
    },
  };
}

function renderExpectedJsonl(events: ConversationEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

Deno.test("JsonlConversationWriter overwrite writes newline-delimited events", async () => {
  await withTestTempDir("writer-jsonl-overwrite-", async (root) => {
    const outputPath = join(root, "nested", "conversation.jsonl");
    const writer = new JsonlConversationWriter();
    const events = [
      makeEvent("evt-1", "message.user", "hello"),
      makeEvent("evt-2", "message.assistant", "captured"),
    ];

    const result = await writer.writeEvents(outputPath, events, {
      mode: "overwrite",
    });

    assertEquals(result, {
      mode: "overwrite",
      outputPath,
      wrote: true,
      deduped: false,
    });
    assertEquals(
      await Deno.readTextFile(outputPath),
      renderExpectedJsonl(events),
    );
  });
});

Deno.test(
  "JsonlConversationWriter overwrite with no events does not create a file",
  async () => {
    await withTestTempDir("writer-jsonl-empty-overwrite-", async (root) => {
      const outputPath = join(root, "nested", "conversation.jsonl");
      const writer = new JsonlConversationWriter();

      const result = await writer.writeEvents(outputPath, [], {
        mode: "overwrite",
      });

      assertEquals(result, {
        mode: "overwrite",
        outputPath,
        wrote: false,
        deduped: false,
      });
      assertEquals((await Deno.stat(join(root, "nested"))).isDirectory, true);
      await assertRejects(() => Deno.stat(outputPath), Deno.errors.NotFound);
    });
  },
);

Deno.test("JsonlConversationWriter append creates and extends JSONL output", async () => {
  await withTestTempDir("writer-jsonl-append-", async (root) => {
    const outputPath = join(root, "conversation.jsonl");
    const writer = new JsonlConversationWriter();
    const firstBatch = [makeEvent("evt-1", "message.user", "hello")];
    const secondBatch = [makeEvent("evt-2", "message.assistant", "captured")];

    const first = await writer.writeEvents(outputPath, firstBatch, {
      mode: "append",
    });
    const second = await writer.writeEvents(outputPath, secondBatch, {
      mode: "append",
    });

    assertEquals(first, {
      mode: "append",
      outputPath,
      wrote: true,
      deduped: false,
    });
    assertEquals(second, {
      mode: "append",
      outputPath,
      wrote: true,
      deduped: false,
    });
    assertEquals(
      await Deno.readTextFile(outputPath),
      renderExpectedJsonl([...firstBatch, ...secondBatch]),
    );
  });
});

Deno.test(
  "JsonlConversationWriter append with no events leaves the destination absent",
  async () => {
    await withTestTempDir("writer-jsonl-empty-append-", async (root) => {
      const outputPath = join(root, "nested", "conversation.jsonl");
      const writer = new JsonlConversationWriter();

      const result = await writer.writeEvents(outputPath, [], {
        mode: "append",
      });

      assertEquals(result, {
        mode: "append",
        outputPath,
        wrote: false,
        deduped: false,
      });
      assertEquals((await Deno.stat(join(root, "nested"))).isDirectory, true);
      await assertRejects(() => Deno.stat(outputPath), Deno.errors.NotFound);
    });
  },
);

Deno.test(
  "JsonlConversationWriter requireCreateNew rejects existing destinations",
  async () => {
    await withTestTempDir("writer-jsonl-createnew-", async (root) => {
      const outputPath = join(root, "conversation.jsonl");
      const writer = new JsonlConversationWriter();

      const created = await writer.writeEvents(outputPath, [
        makeEvent("evt-1", "message.user", "hello"),
      ], {
        mode: "append",
        requireCreateNew: true,
      });

      assertEquals(created.wrote, true);
      await assertRejects(
        () =>
          writer.writeEvents(outputPath, [
            makeEvent("evt-2", "message.assistant", "captured"),
          ], {
            mode: "append",
            requireCreateNew: true,
          }),
        Deno.errors.AlreadyExists,
        "Capture destination already exists",
      );
      await assertRejects(
        () =>
          writer.writeEvents(outputPath, [
            makeEvent("evt-2", "message.assistant", "captured"),
          ], {
            mode: "overwrite",
            requireCreateNew: true,
          }),
        Deno.errors.AlreadyExists,
        "Capture destination already exists",
      );
      assertEquals(
        await Deno.readTextFile(outputPath),
        renderExpectedJsonl([makeEvent("evt-1", "message.user", "hello")]),
      );
    });
  },
);
