import type { ConversationEvent } from "@kato/shared";
import { dirname } from "@std/path";
import type {
  ConversationWriteMode,
  MarkdownWriteResult,
} from "./markdown_writer.ts";

export class JsonlConversationWriter {
  async writeEvents(
    outputPath: string,
    events: ConversationEvent[],
    mode: "overwrite" | "append",
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });

    const lines = events.map((event) => JSON.stringify(event)).join("\n");
    const content = lines.length > 0 ? `${lines}\n` : "";

    if (mode === "overwrite") {
      await Deno.writeTextFile(outputPath, content);
      return {
        mode: "overwrite" as ConversationWriteMode,
        outputPath,
        wrote: true,
        deduped: false,
      };
    }

    // append mode
    if (content.length === 0) {
      return {
        mode: "append" as ConversationWriteMode,
        outputPath,
        wrote: false,
        deduped: false,
      };
    }

    await Deno.writeTextFile(outputPath, content, {
      append: true,
      create: true,
    });

    return {
      mode: "append" as ConversationWriteMode,
      outputPath,
      wrote: true,
      deduped: false,
    };
  }
}
