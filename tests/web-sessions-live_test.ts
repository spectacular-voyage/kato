import { assertEquals } from "@std/assert";
import {
  buildWorkspaceSelectorIds,
  canStopSessionRecording,
  recordingsPageStaleFilterLabel,
  recordingsPageStateLabel,
  recordingsPageStopActionLabel,
} from "../apps/web/src/session_recording_view_model.ts";
import type { SessionRecordingActivityRow } from "../apps/web/src/loaders/sessions.ts";

function makeRecordingRow(
  overrides: Partial<SessionRecordingActivityRow> = {},
): SessionRecordingActivityRow {
  return {
    key: "row-1",
    state: "engaged-active",
    workspaceHref: "/workspaces#workspace-ws-alpha",
    outputPath: "/tmp/alpha/notes/output.md",
    displayOutputPath: "notes/output.md",
    ...overrides,
  };
}

Deno.test("canStopSessionRecording requires both workspace and recording cycle ids", () => {
  assertEquals(
    canStopSessionRecording(
      makeRecordingRow({
        workspaceId: "ws-alpha",
        recordingCycleId: "cycle-1",
      }),
    ),
    true,
  );
  assertEquals(
    canStopSessionRecording(makeRecordingRow({ workspaceId: "ws-alpha" })),
    false,
  );
  assertEquals(
    canStopSessionRecording(makeRecordingRow({ recordingCycleId: "cycle-1" })),
    false,
  );
});

Deno.test("buildWorkspaceSelectorIds returns stable popover ids", () => {
  assertEquals(buildWorkspaceSelectorIds("new-capture"), {
    titleId: "session-recording-popover-title-new-capture",
    selectId: "session-recording-popover-select-new-capture",
  });
  assertEquals(buildWorkspaceSelectorIds("new-recording"), {
    titleId: "session-recording-popover-title-new-recording",
    selectId: "session-recording-popover-select-new-recording",
  });
});

Deno.test("recordings page labels use armed/disarm wording for idle engaged rows", () => {
  assertEquals(recordingsPageStateLabel("active"), "recording");
  assertEquals(recordingsPageStateLabel("stale"), "armed for recording");
  assertEquals(recordingsPageStateLabel("inactive"), "stopped");
  assertEquals(recordingsPageStaleFilterLabel(), "Armed for recording");
  assertEquals(recordingsPageStopActionLabel("engaged-active"), "stop");
  assertEquals(recordingsPageStopActionLabel("engaged-stale"), "disarm");
  assertEquals(recordingsPageStopActionLabel("stopped"), "stop");
});
