import { assertEquals } from "@std/assert";
import {
  hasWriterFeatureFlagOverrides,
  resolveEffectiveOutputMetadata,
  resolveEffectiveWriterFeatureFlags,
  type SessionWorkspaceAttachmentWriterFeatureFlagsV1,
} from "@kato/shared";

function makeWriterFlags(
  overrides: Partial<SessionWorkspaceAttachmentWriterFeatureFlagsV1> = {},
): SessionWorkspaceAttachmentWriterFeatureFlagsV1 {
  return {
    writerIncludeCommentary: true,
    writerIncludeThinking: true,
    writerIncludeToolCalls: true,
    writerItalicizeUserMessages: false,
    ...overrides,
  };
}

Deno.test(
  "resolveEffectiveOutputMetadata lets output scalar values win over session defaults",
  () => {
    const effective = resolveEffectiveOutputMetadata(
      {
        displayTitle: "Session Title",
        filenameSlug: "session-title",
        personaName: "Session Persona",
        participantUsername: "session-user",
      },
      {
        displayTitle: "Output Title",
        filenameSlug: "output-title",
        participantUsername: "output-user",
      },
    );

    assertEquals(effective, {
      displayTitle: "Output Title",
      filenameSlug: "output-title",
      personaName: "Session Persona",
      participantUsername: "output-user",
    });
  },
);

Deno.test(
  "resolveEffectiveOutputMetadata merges tags additively with stable dedupe",
  () => {
    const effective = resolveEffectiveOutputMetadata(
      { tags: ["alpha", "beta", "  gamma "] },
      { tags: ["beta", "delta", "", "gamma"] },
    );

    assertEquals(effective.tags, ["alpha", "beta", "gamma", "delta"]);
  },
);

Deno.test(
  "resolveEffectiveOutputMetadata handles missing inputs",
  () => {
    assertEquals(resolveEffectiveOutputMetadata(undefined, undefined), {});
    assertEquals(
      resolveEffectiveOutputMetadata({ tags: ["alpha"] }, undefined),
      { tags: ["alpha"] },
    );
    assertEquals(
      resolveEffectiveOutputMetadata(undefined, {
        displayTitle: "Output Title",
      }),
      { displayTitle: "Output Title" },
    );
  },
);

Deno.test(
  "resolveEffectiveWriterFeatureFlags applies overrides over base flags",
  () => {
    const base = makeWriterFlags({
      writerIncludeCommentary: true,
      writerIncludeThinking: true,
    });

    const effective = resolveEffectiveWriterFeatureFlags(base, {
      writerIncludeThinking: false,
    });

    assertEquals(effective.writerIncludeCommentary, true);
    assertEquals(effective.writerIncludeThinking, false);
    assertEquals(effective.writerIncludeToolCalls, true);
  },
);

Deno.test(
  "resolveEffectiveWriterFeatureFlags inherits base flags when overrides are missing or empty",
  () => {
    const base = makeWriterFlags({ writerIncludeCommentary: false });

    assertEquals(
      resolveEffectiveWriterFeatureFlags(base, undefined),
      base,
    );
    assertEquals(
      resolveEffectiveWriterFeatureFlags(base, {}),
      base,
    );
    assertEquals(hasWriterFeatureFlagOverrides(undefined), false);
    assertEquals(hasWriterFeatureFlagOverrides({}), false);
    assertEquals(
      hasWriterFeatureFlagOverrides({ writerIncludeCommentary: true }),
      true,
    );
  },
);
