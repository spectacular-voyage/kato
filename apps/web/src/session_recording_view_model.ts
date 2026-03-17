import type { SessionRecordingActivityRow } from "./loaders/sessions.ts";

export type SessionRecordingAction = "new-capture" | "new-recording";

export function canStopSessionRecording(
  recording: SessionRecordingActivityRow,
): boolean {
  return !!recording.workspaceId && !!recording.recordingCycleId;
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
