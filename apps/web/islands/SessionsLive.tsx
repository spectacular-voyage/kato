import { formatWorkspaceLabel } from "@kato/shared";
import { activityStateDot, activityStateLabel } from "../src/activity_state.ts";
import type {
  SessionActivityRow,
  SessionRecordingActivityRow,
  SessionsPageData,
} from "../src/loaders/sessions.ts";
import {
  buildRecordingsRecordingHref,
  buildSessionInventoryHref,
} from "../src/session_routes.ts";
import {
  buildWorkspaceSelectorIds,
  canStopSessionRecording,
  readRememberedSessionsWorkspace,
  rememberSessionsWorkspace,
  resolveDefaultWorkspaceSelectorValue,
  type SessionRecordingAction,
} from "../src/session_recording_view_model.ts";
import { TimestampText } from "../src/TimestampText.tsx";
import SessionSnippet from "./SessionSnippet.tsx";
import { useBrowserTimeZone } from "./use_browser_time_zone.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";
import { useEffect, useRef, useState } from "preact/hooks";

function buildSessionListStateLabel(row: SessionActivityRow): string {
  return activityStateLabel(row.state);
}

function buildPageTitle(
  workspaceAlias: string | undefined,
  workspaceId: string | undefined,
  workspaceDisplayName: string | undefined,
): string {
  const workspaceLabel = workspaceAlias
    ? formatWorkspaceLabel(workspaceAlias, workspaceDisplayName)
    : workspaceId;
  return workspaceLabel ? `Sessions for ${workspaceLabel}` : "Sessions";
}

function buildCountSummary(options: {
  includeStale: boolean;
  activeSessionCount: number;
  staleSessionCount: number;
  inactiveSessionCount: number;
}): string {
  if (!options.includeStale) {
    return `Active: ${options.activeSessionCount}`;
  }
  return `Active: ${options.activeSessionCount}, Idle: ${options.staleSessionCount}, Inactive: ${options.inactiveSessionCount}`;
}

function buildRecordingFilename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function buildWorkspaceLabel(recording: SessionRecordingActivityRow): string {
  if (recording.workspaceAlias) {
    return formatWorkspaceLabel(
      recording.workspaceAlias,
      recording.workspaceDisplayName,
    );
  }
  return recording.workspaceId ?? "workspace";
}

function resolveRecordingWorkspaceFilter(
  recording: SessionRecordingActivityRow,
): string | undefined {
  return recording.workspaceId ?? recording.workspaceAlias;
}

function SessionPageActionFields(
  props: {
    sessionId: string;
    includeStale: boolean;
    workspaceFilter?: string;
    csrfToken?: string;
  },
) {
  return (
    <>
      <input type="hidden" name="sessionId" value={props.sessionId} />
      <input
        type="hidden"
        name="includeStale"
        value={String(props.includeStale)}
      />
      <input
        type="hidden"
        name="workspaceFilter"
        value={props.workspaceFilter ?? ""}
      />
      <input
        type="hidden"
        name="csrfToken"
        value={props.csrfToken ?? ""}
      />
    </>
  );
}

function buildPopoverTitle(action: SessionRecordingAction): string {
  return action === "new-capture"
    ? "Choose workspace for new capture"
    : "Choose workspace for new recording";
}

function buildPopoverDescription(action: SessionRecordingAction): string {
  return action === "new-capture"
    ? "From the start, then stay engaged."
    : "Future activity only.";
}

function buildSubmitLabel(action: SessionRecordingAction): string {
  return action === "new-capture" ? "Start capture" : "Start recording";
}

function buildActionTooltip(action: SessionRecordingAction): string {
  return action === "new-capture"
    ? "Capture will write the entire session to the selected workspace and keep recording further conversation."
    : "Record will create the recording output file and capture subsequent conversation.";
}

function buildPendingSubmitLabel(action: SessionRecordingAction): string {
  return action === "new-capture"
    ? "Starting capture..."
    : "Starting recording...";
}

function buildStopAllActionKey(sessionId: string): string {
  return `stop-all:${sessionId}`;
}

function buildStopRecordingActionKey(
  sessionId: string,
  recordingKey: string,
): string {
  return `stop:${sessionId}:${recordingKey}`;
}

function SessionRecordingActions(
  props: {
    sessionId: string;
    includeStale: boolean;
    workspaceFilter?: string;
    workspaceFilterId?: string;
    csrfToken?: string;
    workspaceOptions: SessionsPageData["workspaceOptions"];
  },
) {
  const [openAction, setOpenAction] = useState<SessionRecordingAction | null>(
    null,
  );
  const [pendingCreateAction, setPendingCreateAction] = useState<
    SessionRecordingAction | null
  >(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState(() =>
    resolveDefaultWorkspaceSelectorValue({
      workspaceOptions: props.workspaceOptions,
      workspaceFilter: props.workspaceFilter,
      workspaceFilterId: props.workspaceFilterId,
      rememberedWorkspaceId: readRememberedSessionsWorkspace(),
    }) ?? ""
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const resolvedWorkspace = resolveDefaultWorkspaceSelectorValue({
      workspaceOptions: props.workspaceOptions,
      workspaceFilter: props.workspaceFilter,
      workspaceFilterId: props.workspaceFilterId,
      rememberedWorkspaceId: readRememberedSessionsWorkspace(),
    }) ?? "";
    const hasExplicitWorkspaceFilter = !!props.workspaceFilter ||
      !!props.workspaceFilterId;
    const hasSelectedWorkspace = props.workspaceOptions.some((option) =>
      option.workspaceId === selectedWorkspace
    );
    if (hasExplicitWorkspaceFilter && selectedWorkspace !== resolvedWorkspace) {
      setSelectedWorkspace(resolvedWorkspace);
      return;
    }
    if (!hasSelectedWorkspace && selectedWorkspace !== resolvedWorkspace) {
      setSelectedWorkspace(resolvedWorkspace);
    }
  }, [
    props.workspaceFilter,
    props.workspaceFilterId,
    props.workspaceOptions,
    selectedWorkspace,
  ]);

  useEffect(() => {
    if (!openAction || pendingCreateAction !== null) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) {
        return;
      }
      if (!rootRef.current?.contains(event.target)) {
        setOpenAction(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenAction(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openAction, pendingCreateAction]);

  if (props.workspaceOptions.length === 0) {
    return (
      <div class="muted mono session-recording-empty">
        Register a workspace to enable recording actions.
      </div>
    );
  }

  const toggleAction = (action: SessionRecordingAction) => {
    if (pendingCreateAction !== null) {
      return;
    }
    setOpenAction((current) => current === action ? null : action);
  };

  const handleCreateSubmit =
    (action: SessionRecordingAction) => (event: Event) => {
      if (!(event.currentTarget instanceof HTMLFormElement)) {
        return;
      }
      if (pendingCreateAction !== null) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const form = event.currentTarget;
      rememberSessionsWorkspace(selectedWorkspace);
      setPendingCreateAction(action);
      if ("requestAnimationFrame" in globalThis) {
        globalThis.requestAnimationFrame(() => form.submit());
        return;
      }
      globalThis.setTimeout(() => form.submit(), 0);
    };

  return (
    <div ref={rootRef} class="session-recording-actions">
      <button
        class={openAction === "new-capture"
          ? "secondary-button current-filter"
          : "secondary-button"}
        type="button"
        title={buildActionTooltip("new-capture")}
        disabled={pendingCreateAction !== null}
        onClick={() => toggleAction("new-capture")}
      >
        New capture
      </button>
      <button
        class={openAction === "new-recording"
          ? "secondary-button current-filter"
          : "secondary-button"}
        type="button"
        title={buildActionTooltip("new-recording")}
        disabled={pendingCreateAction !== null}
        onClick={() => toggleAction("new-recording")}
      >
        New recording
      </button>
      {openAction
        ? (
          <div class="session-recording-popover">
            <form
              method="post"
              class="session-recording-popover-form"
              aria-busy={pendingCreateAction === openAction}
              onSubmit={handleCreateSubmit(openAction)}
            >
              <SessionPageActionFields
                sessionId={props.sessionId}
                includeStale={props.includeStale}
                workspaceFilter={props.workspaceFilter}
                csrfToken={props.csrfToken}
              />
              <input type="hidden" name="action" value={openAction} />
              <div class="session-recording-popover-copy">
                <strong id={buildWorkspaceSelectorIds(openAction).titleId}>
                  {buildPopoverTitle(openAction)}
                </strong>
                <span>{buildPopoverDescription(openAction)}</span>
              </div>
              <select
                id={buildWorkspaceSelectorIds(openAction).selectId}
                class="form-input session-recording-select"
                name="workspaceSelector"
                aria-labelledby={buildWorkspaceSelectorIds(openAction).titleId}
                value={selectedWorkspace}
                onInput={(event) =>
                  setSelectedWorkspace(
                    (event.currentTarget as HTMLSelectElement).value,
                  )}
              >
                {props.workspaceOptions.map((option) => (
                  <option key={option.workspaceId} value={option.workspaceId}>
                    {formatWorkspaceLabel(option.alias, option.displayName)}
                  </option>
                ))}
              </select>
              <div class="session-recording-popover-actions">
                <button
                  class="secondary-button"
                  type="submit"
                  disabled={pendingCreateAction !== null}
                >
                  {pendingCreateAction === openAction
                    ? buildPendingSubmitLabel(openAction)
                    : buildSubmitLabel(openAction)}
                </button>
                <button
                  class="secondary-button"
                  type="button"
                  disabled={pendingCreateAction !== null}
                  onClick={() => setOpenAction(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )
        : null}
    </div>
  );
}

export default function SessionsLive(
  props: {
    initialData: SessionsPageData;
    endpoint: string;
    csrfToken?: string;
  },
) {
  const pageData = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  const heading = buildPageTitle(
    pageData.workspaceFilterAlias,
    pageData.workspaceFilterId,
    pageData.workspaceFilterDisplayName,
  );
  const countSummary = buildCountSummary({
    includeStale: pageData.includeStale,
    activeSessionCount: pageData.activeSessionCount,
    staleSessionCount: pageData.staleSessionCount,
    inactiveSessionCount: pageData.inactiveSessionCount,
  });
  const timeZone = useBrowserTimeZone();
  const [pendingStopActionKey, setPendingStopActionKey] = useState<
    string | null
  >(null);
  const handleStopSubmit = (actionKey: string) => (event: Event) => {
    if (!(event.currentTarget instanceof HTMLFormElement)) {
      return;
    }
    if (pendingStopActionKey !== null) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const form = event.currentTarget;
    setPendingStopActionKey(actionKey);
    if ("requestAnimationFrame" in globalThis) {
      globalThis.requestAnimationFrame(() => form.submit());
      return;
    }
    globalThis.setTimeout(() => form.submit(), 0);
  };

  return (
    <section class="grid">
      <article class="card span-12">
        <div class="page-toolbar">
          <div>
            <h2>{heading}</h2>
            {pageData.workspaceFilterId
              ? (
                <p class="page-toolbar-summary muted mono">
                  Workspace: {pageData.workspaceFilterId}
                </p>
              )
              : null}
            <p class="page-toolbar-summary muted mono">{countSummary}</p>
          </div>
          <div class="page-actions">
            <a
              class={pageData.includeStale
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildSessionInventoryHref({
                includeStale: true,
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              All Sessions
            </a>
            <a
              class={!pageData.includeStale
                ? "secondary-button current-filter"
                : "secondary-button"}
              href={buildSessionInventoryHref({
                includeStale: false,
                workspaceFilter: pageData.workspaceFilter,
              })}
            >
              Active Only
            </a>
            {pageData.workspaceFilter
              ? (
                <a
                  class="secondary-button"
                  href={buildSessionInventoryHref({
                    includeStale: pageData.includeStale,
                  })}
                >
                  Clear Workspace Filter
                </a>
              )
              : null}
          </div>
        </div>

        <hr class="sessions-header-divider" />

        <ul class="session-list-rows">
          {pageData.rows.length === 0
            ? <li class="muted">No sessions match the current filters.</li>
            : pageData.rows.map((row) => {
              const engagedRecordings = row.recordings.filter((recording) =>
                recording.state !== "stopped"
              );
              const stoppableRecordings = engagedRecordings.filter(
                canStopSessionRecording,
              );
              const stopAllActionKey = buildStopAllActionKey(row.sessionId);
              return (
                <li
                  key={row.sessionKey}
                  class={`session-list-row ${row.state}`}
                  id={`session-${row.sessionId}`}
                >
                  <div class="session-list-action">
                    <span
                      class={`activity-state-dot session-list-dot ${row.state}`}
                      aria-label={buildSessionListStateLabel(row)}
                      title={buildSessionListStateLabel(row)}
                    >
                      {activityStateDot(row.state)}
                    </span>
                  </div>
                  <span class="session-list-copy">
                    <span class="session-list-primary">
                      <span class="mono">{row.provider}:</span>{" "}
                      <SessionSnippet
                        sessionId={row.sessionId}
                        snippet={row.snippet}
                        snippetClass="session-list-snippet"
                        title={`Session ${row.sessionShortId}`}
                      />
                    </span>{" "}
                    <span class="muted mono session-list-updated">
                      Updated{" "}
                      <TimestampText
                        value={row.updatedAt}
                        timeZone={timeZone}
                      />
                    </span>
                  </span>
                  <div class="session-list-right">
                    <SessionRecordingActions
                      sessionId={row.sessionId}
                      includeStale={pageData.includeStale}
                      workspaceFilter={pageData.workspaceFilter}
                      workspaceFilterId={pageData.workspaceFilterId}
                      csrfToken={props.csrfToken}
                      workspaceOptions={pageData.workspaceOptions}
                    />
                  </div>
                  {engagedRecordings.length > 0
                    ? (
                      <div class="session-recordings-block session-recordings-wide">
                        <div class="session-recordings-heading-row">
                          <div class="session-recordings-heading muted mono">
                            Recordings
                          </div>
                          {stoppableRecordings.length > 0
                            ? (
                              <form
                                method="post"
                                class="session-list-action-form session-inline-action-form"
                                onSubmit={handleStopSubmit(stopAllActionKey)}
                              >
                                <SessionPageActionFields
                                  sessionId={row.sessionId}
                                  includeStale={pageData.includeStale}
                                  workspaceFilter={pageData.workspaceFilter}
                                  csrfToken={props.csrfToken}
                                />
                                <input
                                  type="hidden"
                                  name="action"
                                  value="stop-all-recordings"
                                />
                                <button
                                  class="session-inline-action session-inline-action-danger session-inline-action-small mono"
                                  type="submit"
                                  disabled={pendingStopActionKey !== null}
                                >
                                  {pendingStopActionKey === stopAllActionKey
                                    ? "[stopping all...]"
                                    : "[stop all]"}
                                </button>
                              </form>
                            )
                            : null}
                        </div>
                        <div class="session-engaged-recordings muted mono">
                          {engagedRecordings.map((recording) => (
                            <div
                              key={recording.key}
                              class="session-engaged-line"
                            >
                              {(() => {
                                const stopActionKey =
                                  buildStopRecordingActionKey(
                                    row.sessionId,
                                    recording.key,
                                  );
                                return (
                                  <>
                                    <span class="session-engaged-copy">
                                      <a href={recording.workspaceHref}>
                                        {buildWorkspaceLabel(recording)}
                                      </a>
                                      <span>:</span>
                                      <a
                                        href={buildRecordingsRecordingHref({
                                          workspaceFilter:
                                            resolveRecordingWorkspaceFilter(
                                              recording,
                                            ),
                                          recordingCycleId:
                                            recording.recordingCycleId,
                                          rowKey: recording.key,
                                        })}
                                      >
                                        {buildRecordingFilename(
                                          recording.displayOutputPath,
                                        )}
                                      </a>
                                    </span>
                                    {canStopSessionRecording(recording)
                                      ? (
                                        <form
                                          method="post"
                                          class="session-list-action-form session-inline-action-form"
                                          onSubmit={handleStopSubmit(
                                            stopActionKey,
                                          )}
                                        >
                                          <SessionPageActionFields
                                            sessionId={row.sessionId}
                                            includeStale={pageData.includeStale}
                                            workspaceFilter={pageData
                                              .workspaceFilter}
                                            csrfToken={props.csrfToken}
                                          />
                                          <input
                                            type="hidden"
                                            name="action"
                                            value="stop-recording"
                                          />
                                          <input
                                            type="hidden"
                                            name="workspaceId"
                                            value={recording.workspaceId ?? ""}
                                          />
                                          <input
                                            type="hidden"
                                            name="recordingCycleId"
                                            value={recording.recordingCycleId ??
                                              ""}
                                          />
                                          <input
                                            type="hidden"
                                            name="outputPath"
                                            value={recording.outputPath}
                                          />
                                          <button
                                            class="session-inline-action session-inline-action-danger mono"
                                            type="submit"
                                            disabled={pendingStopActionKey !==
                                              null}
                                          >
                                            {pendingStopActionKey ===
                                                stopActionKey
                                              ? "[stopping...]"
                                              : "[stop]"}
                                          </button>
                                        </form>
                                      )
                                      : null}
                                  </>
                                );
                              })()}
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                    : null}
                </li>
              );
            })}
        </ul>
      </article>
    </section>
  );
}
