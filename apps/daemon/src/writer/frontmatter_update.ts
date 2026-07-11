import {
  type FrontmatterMetadataUpdate,
  updateFrontmatterMetadataFields,
} from "./frontmatter.ts";

export type MarkdownFrontmatterMetadataUpdateStatus =
  | "updated"
  | "unchanged"
  | "not-markdown"
  | "missing-file"
  | "no-frontmatter";

export interface MarkdownFrontmatterMetadataUpdateResult {
  status: MarkdownFrontmatterMetadataUpdateStatus;
}

// Best-effort metadata-only frontmatter update for a markdown output file.
// Persisted session metadata stays the source of truth: missing files,
// non-markdown outputs, and absent frontmatter are reported, not errors, and
// the body is never rewritten.
export async function updateMarkdownFrontmatterMetadata(
  outputPath: string,
  update: FrontmatterMetadataUpdate,
): Promise<MarkdownFrontmatterMetadataUpdateResult> {
  if (!/\.md$/i.test(outputPath)) {
    return { status: "not-markdown" };
  }
  let content: string;
  try {
    content = await Deno.readTextFile(outputPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { status: "missing-file" };
    }
    throw error;
  }
  const result = updateFrontmatterMetadataFields(content, update);
  if (!result.hadFrontmatter) {
    return { status: "no-frontmatter" };
  }
  if (!result.changed) {
    return { status: "unchanged" };
  }
  await Deno.writeTextFile(outputPath, result.content);
  return { status: "updated" };
}
