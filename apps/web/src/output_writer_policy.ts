import type {
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
  SessionWorkspaceOutputWriterFeatureFlagOverridesV1,
} from "@kato/shared";
import { resolveEffectiveWriterFeatureFlags } from "@kato/shared";

export type WriterPolicyTriState = "inherit" | "include" | "exclude";

export interface WriterPolicyFlagProjection {
  defaultValue: boolean;
  override?: boolean;
  effective: boolean;
}

export interface OutputWriterPolicyProjection {
  commentary: WriterPolicyFlagProjection;
  thinking: WriterPolicyFlagProjection;
}

export function projectOutputWriterPolicy(
  defaults: SessionWorkspaceAttachmentWriterFeatureFlagsV1,
  overrides: SessionWorkspaceOutputWriterFeatureFlagOverridesV1 | undefined,
): OutputWriterPolicyProjection {
  const effective = resolveEffectiveWriterFeatureFlags(defaults, overrides);
  return {
    commentary: {
      defaultValue: defaults.writerIncludeCommentary,
      ...(overrides?.writerIncludeCommentary !== undefined
        ? { override: overrides.writerIncludeCommentary }
        : {}),
      effective: effective.writerIncludeCommentary,
    },
    thinking: {
      defaultValue: defaults.writerIncludeThinking,
      ...(overrides?.writerIncludeThinking !== undefined
        ? { override: overrides.writerIncludeThinking }
        : {}),
      effective: effective.writerIncludeThinking,
    },
  };
}

export function writerPolicyTriState(
  flag: Pick<WriterPolicyFlagProjection, "override">,
): WriterPolicyTriState {
  if (flag.override === undefined) {
    return "inherit";
  }
  return flag.override ? "include" : "exclude";
}

export function parseWriterFlagChoice(
  value: string | undefined,
): WriterPolicyTriState | undefined {
  return value === "inherit" || value === "include" || value === "exclude"
    ? value
    : undefined;
}
