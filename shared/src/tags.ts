function containsAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1F || code === 0x7F) {
      return true;
    }
  }
  return false;
}

export function validateAndNormalizeOutputTag(
  value: string,
  context = "tag",
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  if (containsAsciiControlCharacters(normalized)) {
    throw new Error(
      `${context} must not contain ASCII control characters (U+0000..U+001F, U+007F)`,
    );
  }
  return normalized;
}

export function normalizeOutputTags(
  values: ReadonlyArray<string>,
  context = "tags",
): string[] {
  const deduped = new Set<string>();
  for (const [index, value] of values.entries()) {
    deduped.add(
      validateAndNormalizeOutputTag(value, `${context}[${index}]`),
    );
  }
  return Array.from(deduped);
}

export function resolveOutputTagSuggestions(options: {
  workspaceTagSuggestions?: ReadonlyArray<string>;
  userGlobalTagSuggestions?: ReadonlyArray<string>;
  userWorkspaceTagSuggestions?: ReadonlyArray<string>;
  existingTags?: ReadonlyArray<string>;
}): string[] {
  return normalizeOutputTags([
    ...(options.workspaceTagSuggestions ?? []),
    ...(options.userGlobalTagSuggestions ?? []),
    ...(options.userWorkspaceTagSuggestions ?? []),
    ...(options.existingTags ?? []),
  ], "tagSuggestions");
}
