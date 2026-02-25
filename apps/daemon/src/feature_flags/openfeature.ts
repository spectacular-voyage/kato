import type { RuntimeFeatureFlags } from "@kato/shared";
import type { MarkdownRenderOptions } from "../writer/mod.ts";

const DEFAULT_RUNTIME_FEATURE_FLAGS: RuntimeFeatureFlags = {
  writerIncludeCommentary: true,
  writerIncludeThinking: false,
  writerIncludeToolCalls: false,
  writerItalicizeUserMessages: false,
  daemonExportEnabled: true,
  captureIncludeSystemEvents: false,
};

export type RuntimeFeatureFlagKey = keyof RuntimeFeatureFlags;

export interface OpenFeatureEvaluationContext {
  provider?: string;
  sessionId?: string;
  command?: string;
}

export interface OpenFeatureBooleanProviderLike {
  resolveBooleanValue(
    flagKey: RuntimeFeatureFlagKey,
    defaultValue: boolean,
    context?: OpenFeatureEvaluationContext,
  ): boolean;
}

function cloneRuntimeFeatureFlags(
  value: RuntimeFeatureFlags,
): RuntimeFeatureFlags {
  return {
    writerIncludeCommentary: value.writerIncludeCommentary,
    writerIncludeThinking: value.writerIncludeThinking,
    writerIncludeToolCalls: value.writerIncludeToolCalls,
    writerItalicizeUserMessages: value.writerItalicizeUserMessages,
    daemonExportEnabled: value.daemonExportEnabled,
    captureIncludeSystemEvents: value.captureIncludeSystemEvents,
  };
}

export function createDefaultRuntimeFeatureFlags(): RuntimeFeatureFlags {
  return cloneRuntimeFeatureFlags(DEFAULT_RUNTIME_FEATURE_FLAGS);
}

export function mergeRuntimeFeatureFlags(
  overrides: Partial<RuntimeFeatureFlags> = {},
): RuntimeFeatureFlags {
  return {
    ...createDefaultRuntimeFeatureFlags(),
    ...overrides,
  };
}

export class InMemoryOpenFeatureProvider
  implements OpenFeatureBooleanProviderLike {
  private readonly values: RuntimeFeatureFlags;

  constructor(values: RuntimeFeatureFlags) {
    this.values = cloneRuntimeFeatureFlags(values);
  }

  resolveBooleanValue(
    flagKey: RuntimeFeatureFlagKey,
    defaultValue: boolean,
    _context?: OpenFeatureEvaluationContext,
  ): boolean {
    const value = this.values[flagKey];
    return typeof value === "boolean" ? value : defaultValue;
  }
}

export class OpenFeatureClient {
  constructor(private readonly provider: OpenFeatureBooleanProviderLike) {}

  getBooleanValue(
    flagKey: RuntimeFeatureFlagKey,
    defaultValue: boolean,
    context?: OpenFeatureEvaluationContext,
  ): boolean {
    return this.provider.resolveBooleanValue(flagKey, defaultValue, context);
  }
}

export interface DaemonFeatureSettings {
  exportEnabled: boolean;
  captureIncludeSystemEvents: boolean;
  writerRenderOptions:
    & Pick<
      MarkdownRenderOptions,
      | "includeCommentary"
      | "includeThinking"
      | "includeToolCalls"
      | "italicizeUserMessages"
    >
    & { includeSystemEvents: boolean };
}

export function bootstrapOpenFeature(
  overrides: Partial<RuntimeFeatureFlags> = {},
): OpenFeatureClient {
  const values = mergeRuntimeFeatureFlags(overrides);
  return new OpenFeatureClient(new InMemoryOpenFeatureProvider(values));
}

export function evaluateDaemonFeatureSettings(
  client: OpenFeatureClient,
  context: OpenFeatureEvaluationContext = {},
): DaemonFeatureSettings {
  const defaults = createDefaultRuntimeFeatureFlags();
  const captureIncludeSystemEvents = client.getBooleanValue(
    "captureIncludeSystemEvents",
    defaults.captureIncludeSystemEvents,
    context,
  );
  return {
    exportEnabled: client.getBooleanValue(
      "daemonExportEnabled",
      defaults.daemonExportEnabled,
      { ...context, command: "export" },
    ),
    captureIncludeSystemEvents,
    writerRenderOptions: {
      includeCommentary: client.getBooleanValue(
        "writerIncludeCommentary",
        defaults.writerIncludeCommentary,
        context,
      ),
      includeThinking: client.getBooleanValue(
        "writerIncludeThinking",
        defaults.writerIncludeThinking,
        context,
      ),
      includeToolCalls: client.getBooleanValue(
        "writerIncludeToolCalls",
        defaults.writerIncludeToolCalls,
        context,
      ),
      italicizeUserMessages: client.getBooleanValue(
        "writerItalicizeUserMessages",
        defaults.writerItalicizeUserMessages,
        context,
      ),
      includeSystemEvents: captureIncludeSystemEvents,
    },
  };
}
