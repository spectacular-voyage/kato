import type { DaemonFeatureFlags } from "@kato/shared";

const DEFAULT_DAEMON_FEATURE_FLAGS: DaemonFeatureFlags = {
  daemonExportEnabled: true,
  captureIncludeSystemEvents: false,
};

export type DaemonFeatureFlagKey = keyof DaemonFeatureFlags;

export interface OpenFeatureEvaluationContext {
  provider?: string;
  sessionId?: string;
  command?: string;
}

export interface OpenFeatureBooleanProviderLike {
  resolveBooleanValue(
    flagKey: DaemonFeatureFlagKey,
    defaultValue: boolean,
    context?: OpenFeatureEvaluationContext,
  ): boolean;
}

function cloneRuntimeFeatureFlags(
  value: DaemonFeatureFlags,
): DaemonFeatureFlags {
  return {
    daemonExportEnabled: value.daemonExportEnabled,
    captureIncludeSystemEvents: value.captureIncludeSystemEvents,
  };
}

export function createDefaultDaemonFeatureFlags(): DaemonFeatureFlags {
  return cloneRuntimeFeatureFlags(DEFAULT_DAEMON_FEATURE_FLAGS);
}

export function mergeDaemonFeatureFlags(
  overrides: Partial<DaemonFeatureFlags> = {},
): DaemonFeatureFlags {
  return {
    ...createDefaultDaemonFeatureFlags(),
    ...overrides,
  };
}

export class InMemoryOpenFeatureProvider
  implements OpenFeatureBooleanProviderLike {
  private readonly values: DaemonFeatureFlags;

  constructor(values: DaemonFeatureFlags) {
    this.values = cloneRuntimeFeatureFlags(values);
  }

  resolveBooleanValue(
    flagKey: DaemonFeatureFlagKey,
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
    flagKey: DaemonFeatureFlagKey,
    defaultValue: boolean,
    context?: OpenFeatureEvaluationContext,
  ): boolean {
    return this.provider.resolveBooleanValue(flagKey, defaultValue, context);
  }
}

export interface DaemonFeatureSettings {
  exportEnabled: boolean;
  captureIncludeSystemEvents: boolean;
}

export function bootstrapOpenFeature(
  overrides: Partial<DaemonFeatureFlags> = {},
): OpenFeatureClient {
  const values = mergeDaemonFeatureFlags(overrides);
  return new OpenFeatureClient(new InMemoryOpenFeatureProvider(values));
}

export function evaluateDaemonFeatureSettings(
  client: OpenFeatureClient,
  context: OpenFeatureEvaluationContext = {},
): DaemonFeatureSettings {
  const defaults = createDefaultDaemonFeatureFlags();
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
  };
}
