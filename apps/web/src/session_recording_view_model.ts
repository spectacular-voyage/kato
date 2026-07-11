import type { ActivityState } from "./activity_state.ts";
import type {
  SessionRecordingActivityRow,
  WorkspaceOption,
} from "./loaders/sessions.ts";

export type SessionRecordingAction = "new-capture" | "new-recording";
export const SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY =
  "kato:sessions:selected-workspace";

export interface BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ResolveDefaultWorkspaceSelectorValueOptions {
  workspaceOptions: WorkspaceOption[];
  workspaceFilter?: string;
  workspaceFilterId?: string;
  rememberedWorkspaceId?: string;
}

export function deriveFilenameSlugFromTitle(
  value: string | undefined,
): string {
  const normalized = value?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") ?? "";
  return normalized;
}

export function resolveTitleDerivedFilenameSlug(options: {
  title: string;
  currentFilenameSlug: string;
  filenameSlugCustomized: boolean;
}): string {
  return options.filenameSlugCustomized
    ? options.currentFilenameSlug
    : deriveFilenameSlugFromTitle(options.title);
}

export function resolvePolledCreationFields(options: {
  currentDisplayTitle: string;
  currentFilenameSlug: string;
  displayTitleCustomized: boolean;
  filenameSlugCustomized: boolean;
  sessionSnippet?: string;
  defaultDisplayTitle?: string;
  defaultFilenameSlug?: string;
}): { displayTitle: string; filenameSlug: string } {
  const defaultDisplayTitle = options.defaultDisplayTitle ??
    options.sessionSnippet ?? "";
  const displayTitle = options.displayTitleCustomized
    ? options.currentDisplayTitle
    : defaultDisplayTitle;
  return {
    displayTitle,
    filenameSlug: options.filenameSlugCustomized
      ? options.currentFilenameSlug
      : options.displayTitleCustomized
      ? deriveFilenameSlugFromTitle(displayTitle)
      : options.defaultFilenameSlug ??
        deriveFilenameSlugFromTitle(defaultDisplayTitle),
  };
}

function normalizeWorkspacePreference(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function hasWorkspaceOption(
  workspaceOptions: WorkspaceOption[],
  workspaceId: string | undefined,
): workspaceId is string {
  return !!workspaceId &&
    workspaceOptions.some((option) => option.workspaceId === workspaceId);
}

function resolveWorkspaceOptionId(
  workspaceOptions: WorkspaceOption[],
  selector: string | undefined,
): string | undefined {
  const normalizedSelector = normalizeWorkspacePreference(selector);
  if (!normalizedSelector) {
    return undefined;
  }
  const matchingOption = workspaceOptions.find((option) =>
    option.workspaceId === normalizedSelector ||
    option.alias === normalizedSelector
  );
  return matchingOption?.workspaceId;
}

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

export function readRememberedSessionsWorkspace(
  storage?: BrowserStorageLike,
): string | undefined {
  try {
    const storageValue = storage
      ? storage.getItem(SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY)
      : globalThis.localStorage?.getItem(
        SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY,
      );
    return normalizeWorkspacePreference(
      storageValue ?? undefined,
    );
  } catch {
    return undefined;
  }
}

export function rememberSessionsWorkspace(
  workspaceId: string,
  storage?: BrowserStorageLike,
): void {
  const normalizedWorkspaceId = normalizeWorkspacePreference(workspaceId);
  if (!normalizedWorkspaceId) {
    return;
  }
  try {
    storage?.setItem(
      SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY,
      normalizedWorkspaceId,
    );
    if (!storage) {
      globalThis.localStorage?.setItem(
        SESSIONS_SELECTED_WORKSPACE_STORAGE_KEY,
        normalizedWorkspaceId,
      );
    }
  } catch {
    // Ignore storage failures; the current submission can still proceed.
  }
}

export function resolveDefaultWorkspaceSelectorValue(
  options: ResolveDefaultWorkspaceSelectorValueOptions,
): string | undefined {
  if (hasWorkspaceOption(options.workspaceOptions, options.workspaceFilterId)) {
    return options.workspaceFilterId;
  }

  const filteredWorkspaceId = resolveWorkspaceOptionId(
    options.workspaceOptions,
    options.workspaceFilter,
  );
  if (filteredWorkspaceId) {
    return filteredWorkspaceId;
  }

  if (
    hasWorkspaceOption(
      options.workspaceOptions,
      options.rememberedWorkspaceId,
    )
  ) {
    return options.rememberedWorkspaceId;
  }

  return options.workspaceOptions[0]?.workspaceId;
}
