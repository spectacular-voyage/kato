import type { RuntimeFeatureFlags } from "@kato/shared";
import type { MarkdownRenderOptions } from "../writer/mod.ts";

const DEFAULT_RUNTIME_FEATURE_FLAGS: RuntimeFeatureFlags = {
  writerIncludeThinking: true,
  writerIncludeToolCalls: true,
  writerItalicizeUserMessages: false,
  daemonExportEnabled: true,
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
    writerIncludeThinking: value.writerIncludeThinking,
    writerIncludeToolCalls: value.writerIncludeToolCalls,
    writerItalicizeUserMessages: value.writerItalicizeUserMessages,
    daemonExportEnabled: value.daemonExportEnabled,
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
  writerRenderOptions: Pick<
    MarkdownRenderOptions,
    "includeThinking" | "includeToolCalls" | "italicizeUserMessages"
  >;
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
  return {
    exportEnabled: client.getBooleanValue(
      "daemonExportEnabled",
      defaults.daemonExportEnabled,
      { ...context, command: "export" },
    ),
    writerRenderOptions: {
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
    },
  };
}
