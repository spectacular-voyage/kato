import type { ConversationEvent } from "@kato/shared";
import { dirname } from "@std/path";
import type {
  ConversationWriteMode,
  MarkdownWriteResult,
} from "./markdown_writer.ts";

export interface JsonlWriteOptions {
  mode: "overwrite" | "append";
  requireCreateNew?: boolean;
}

export class JsonlConversationWriter {
  private async assertOutputDoesNotExist(outputPath: string): Promise<void> {
    try {
      await Deno.stat(outputPath);
      throw new Deno.errors.AlreadyExists(
        `Capture destination already exists: ${outputPath}`,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  async writeEvents(
    outputPath: string,
    events: ConversationEvent[],
    options: JsonlWriteOptions,
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });
    const mode = options.mode;
    const requireCreateNew = options.requireCreateNew === true;
    if (requireCreateNew) {
      await this.assertOutputDoesNotExist(outputPath);
    }

    const lines = events.map((event) => JSON.stringify(event)).join("\n");
    const content = lines.length > 0 ? `${lines}\n` : "";

    if (mode === "overwrite") {
      if (content.length === 0) {
        return {
          mode: "overwrite" as ConversationWriteMode,
          outputPath,
          wrote: false,
          deduped: false,
        };
      }
      if (requireCreateNew) {
        await Deno.writeTextFile(outputPath, content, { createNew: true });
      } else {
        await Deno.writeTextFile(outputPath, content);
      }
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

    if (requireCreateNew) {
      await Deno.writeTextFile(outputPath, content, {
        append: true,
        createNew: true,
      });
    } else {
      await Deno.writeTextFile(outputPath, content, {
        append: true,
        create: true,
      });
    }

    return {
      mode: "append" as ConversationWriteMode,
      outputPath,
      wrote: true,
      deduped: false,
    };
  }
}
