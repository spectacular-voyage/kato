import type {
  SessionOutputMetadataV1,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
  SessionWorkspaceOutputWriterFeatureFlagOverridesV1,
} from "./contracts/session_state.ts";

function normalizeTags(values: ReadonlyArray<string> | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }
    deduped.add(normalized);
  }
  return Array.from(deduped);
}

// Merges session-level defaults with per-output metadata. Scalar fields on the
// output win over session defaults; tags are additive and stable-deduped with
// session tags first.
export function resolveEffectiveOutputMetadata(
  sessionDefaults: SessionOutputMetadataV1 | undefined,
  outputMetadata: SessionOutputMetadataV1 | undefined,
): SessionOutputMetadataV1 {
  const displayTitle = outputMetadata?.displayTitle ??
    sessionDefaults?.displayTitle;
  const filenameSlug = outputMetadata?.filenameSlug ??
    sessionDefaults?.filenameSlug;
  const personaName = outputMetadata?.personaName ??
    sessionDefaults?.personaName;
  const participantUsername = outputMetadata?.participantUsername ??
    sessionDefaults?.participantUsername;
  const tags = normalizeTags([
    ...(sessionDefaults?.tags ?? []),
    ...(outputMetadata?.tags ?? []),
  ]);
  return {
    ...(displayTitle !== undefined ? { displayTitle } : {}),
    ...(filenameSlug !== undefined ? { filenameSlug } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(personaName !== undefined ? { personaName } : {}),
    ...(participantUsername !== undefined ? { participantUsername } : {}),
  };
}

export function hasWriterFeatureFlagOverrides(
  overrides: SessionWorkspaceOutputWriterFeatureFlagOverridesV1 | undefined,
): boolean {
  return overrides !== undefined &&
    (overrides.writerIncludeCommentary !== undefined ||
      overrides.writerIncludeThinking !== undefined);
}

// Applies per-output render-policy overrides over base workspace-default
// writer flags. Missing override keys inherit the base value.
export function resolveEffectiveWriterFeatureFlags(
  base: SessionWorkspaceAttachmentWriterFeatureFlagsV1,
  overrides: SessionWorkspaceOutputWriterFeatureFlagOverridesV1 | undefined,
): SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  if (!hasWriterFeatureFlagOverrides(overrides)) {
    return { ...base };
  }
  return {
    ...base,
    ...(overrides?.writerIncludeCommentary !== undefined
      ? { writerIncludeCommentary: overrides.writerIncludeCommentary }
      : {}),
    ...(overrides?.writerIncludeThinking !== undefined
      ? { writerIncludeThinking: overrides.writerIncludeThinking }
      : {}),
  };
}
