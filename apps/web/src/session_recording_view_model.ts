import type { ActivityState } from "./activity_state.ts";
import type { SessionRecordingActivityRow } from "./loaders/sessions.ts";

export type SessionRecordingAction = "new-capture" | "new-recording";

export function canStopSessionRecording(
  recording: SessionRecordingActivityRow,
): boolean {
  return !!recording.workspaceId && !!recording.recordingCycleId;
}

export function canRestartSessionRecording(
  recording: SessionRecordingActivityRow,
): boolean {
  return recording.state === "stopped" &&
    !!recording.workspaceId &&
    !!recording.recordingCycleId &&
    !!recording.outputPath;
}

export function recordingsPageStateLabel(state: ActivityState): string {
  switch (state) {
    case "active":
      return "recording";
    case "stale":
      return "armed for recording";
    case "inactive":
      return "stopped";
  }
}

export function recordingsPageStaleFilterLabel(): string {
  return "Armed for recording";
}

export function recordingsPageStopActionLabel(
  state: SessionRecordingActivityRow["state"],
): string {
  return state === "engaged-stale" ? "disarm" : "stop";
}

export function buildWorkspaceSelectorIds(action: SessionRecordingAction): {
  titleId: string;
  selectId: string;
} {
  return {
    titleId: `session-recording-popover-title-${action}`,
    selectId: `session-recording-popover-select-${action}`,
  };
}
