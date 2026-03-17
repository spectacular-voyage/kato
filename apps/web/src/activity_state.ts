import type { RuntimeConfig } from "@kato/shared";

export type ActivityState = "active" | "stale" | "inactive";

export interface SessionGenerationStateInput {
  provider: string;
  stale: boolean;
  activeRecordingCount?: number;
  staleRecordingCount?: number;
  recordingCount?: number;
}

export function activityStateLabel(state: ActivityState): string {
  switch (state) {
    case "active":
      return "active";
    case "stale":
      return "idle";
    case "inactive":
      return "off";
  }
}

export function recordingActivityStateLabel(state: ActivityState): string {
  switch (state) {
    case "active":
      return "recording";
    case "stale":
      return "ready to record";
    case "inactive":
      return "stopped";
  }
}

export function activityStateDot(state: ActivityState): string {
  return state === "inactive" ? "○" : "●";
}

export function deriveSessionGenerationState(
  input: SessionGenerationStateInput,
  runtimeConfig: RuntimeConfig,
): ActivityState {
  const engaged = providerAutoGeneratesTwins(input.provider, runtimeConfig) ||
    (input.activeRecordingCount ?? 0) > 0 ||
    (input.staleRecordingCount ?? 0) > 0 ||
    (input.recordingCount ?? 0) > 0;

  if (!engaged) {
    return "inactive";
  }
  return input.stale ? "stale" : "active";
}

export function providerAutoGeneratesTwins(
  provider: string,
  runtimeConfig: RuntimeConfig,
): boolean {
  const perProvider = (runtimeConfig.providerAutoGenerateTwins ?? {}) as Record<
    string,
    boolean | undefined
  >;
  return perProvider[provider] ?? runtimeConfig.globalAutoGenerateTwins ??
    false;
}
