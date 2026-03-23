import { assertEquals } from "@std/assert";
import {
  buildWorkspaceSelectorIds,
  canStopSessionRecording,
  readRememberedSessionsWorkspace,
  recordingsPageStaleFilterLabel,
  recordingsPageStateLabel,
  recordingsPageStopActionLabel,
  rememberSessionsWorkspace,
  resolveDefaultWorkspaceSelectorValue,
  SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY,
} from "../apps/web/src/session_recording_view_model.ts";
import type {
  SessionRecordingActivityRow,
  WorkspaceOption,
} from "../apps/web/src/loaders/sessions.ts";

class MemoryStorage {
  #entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, value);
  }
}

function makeWorkspaceOptions(): WorkspaceOption[] {
  return [
    {
      workspaceId: "ws-alpha",
      alias: "alpha",
      displayName: "Alpha",
    },
    {
      workspaceId: "ws-beta",
      alias: "beta",
      displayName: "Beta",
    },
  ];
}

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

Deno.test("resolveDefaultWorkspaceSelectorValue prefers explicit filter over remembered workspace", () => {
  assertEquals(
    resolveDefaultWorkspaceSelectorValue({
      workspaceOptions: makeWorkspaceOptions(),
      workspaceFilter: "beta",
      rememberedWorkspaceId: "ws-alpha",
    }),
    "ws-beta",
  );
  assertEquals(
    resolveDefaultWorkspaceSelectorValue({
      workspaceOptions: makeWorkspaceOptions(),
      workspaceFilterId: "ws-beta",
      rememberedWorkspaceId: "ws-alpha",
    }),
    "ws-beta",
  );
});

Deno.test("resolveDefaultWorkspaceSelectorValue falls back to remembered workspace id when valid", () => {
  assertEquals(
    resolveDefaultWorkspaceSelectorValue({
      workspaceOptions: makeWorkspaceOptions(),
      rememberedWorkspaceId: "ws-beta",
    }),
    "ws-beta",
  );
});

Deno.test("resolveDefaultWorkspaceSelectorValue falls back to first option when remembered workspace is stale", () => {
  assertEquals(
    resolveDefaultWorkspaceSelectorValue({
      workspaceOptions: makeWorkspaceOptions(),
      rememberedWorkspaceId: "ws-missing",
    }),
    "ws-alpha",
  );
});

Deno.test("rememberSessionsWorkspace stores a trimmed shared workspace id", () => {
  const storage = new MemoryStorage();

  rememberSessionsWorkspace("  ws-beta  ", storage);

  assertEquals(
    storage.getItem(SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY),
    "ws-beta",
  );
  assertEquals(readRememberedSessionsWorkspace(storage), "ws-beta");
});

Deno.test("readRememberedSessionsWorkspace ignores blank values", () => {
  const storage = new MemoryStorage();
  storage.setItem(SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY, "   ");

  assertEquals(readRememberedSessionsWorkspace(storage), undefined);
});
