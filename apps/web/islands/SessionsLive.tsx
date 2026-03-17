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
): string {
  const workspaceLabel = workspaceAlias ?? workspaceId;
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

function resolveDefaultWorkspaceSelectorValue(
  pageData: SessionsPageData,
): string | undefined {
  if (pageData.workspaceFilterId) {
    return pageData.workspaceFilterId;
  }
  if (pageData.workspaceFilter) {
    const matchingOption = pageData.workspaceOptions.find((option) =>
      option.workspaceId === pageData.workspaceFilter ||
      option.alias === pageData.workspaceFilter
    );
    if (matchingOption) {
      return matchingOption.workspaceId;
    }
  }
  return pageData.workspaceOptions[0]?.workspaceId;
}

function buildRecordingFilename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function buildWorkspaceLabel(recording: SessionRecordingActivityRow): string {
  return recording.workspaceAlias ?? recording.workspaceId ?? "workspace";
}

function resolveRecordingWorkspaceFilter(
  recording: SessionRecordingActivityRow,
): string | undefined {
  return recording.workspaceId ?? recording.workspaceAlias;
}

function canStopRecording(recording: SessionRecordingActivityRow): boolean {
  return !!recording.workspaceId;
}

type SessionRecordingAction = "new-capture" | "new-recording";

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

function SessionRecordingActions(
  props: {
    sessionId: string;
    includeStale: boolean;
    workspaceFilter?: string;
    csrfToken?: string;
    workspaceOptions: SessionsPageData["workspaceOptions"];
    defaultWorkspaceSelectorValue?: string;
  },
) {
  const [openAction, setOpenAction] = useState<SessionRecordingAction | null>(
    null,
  );
  const [selectedWorkspace, setSelectedWorkspace] = useState(
    props.defaultWorkspaceSelectorValue ??
      props.workspaceOptions[0]?.workspaceId ??
      "",
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      props.defaultWorkspaceSelectorValue &&
      !props.workspaceOptions.some((option) =>
        option.workspaceId === selectedWorkspace
      )
    ) {
      setSelectedWorkspace(props.defaultWorkspaceSelectorValue);
    }
  }, [
    props.defaultWorkspaceSelectorValue,
    props.workspaceOptions,
    selectedWorkspace,
  ]);

  useEffect(() => {
    if (!openAction) {
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
  }, [openAction]);

  if (props.workspaceOptions.length === 0) {
    return (
      <div class="muted mono session-recording-empty">
        Register a workspace to enable recording actions.
      </div>
    );
  }

  const toggleAction = (action: SessionRecordingAction) => {
    setOpenAction((current) => current === action ? null : action);
  };

  return (
    <div ref={rootRef} class="session-recording-actions">
      <button
        class={openAction === "new-capture"
          ? "secondary-button current-filter"
          : "secondary-button"}
        type="button"
        onClick={() => toggleAction("new-capture")}
      >
        New capture
      </button>
      <button
        class={openAction === "new-recording"
          ? "secondary-button current-filter"
          : "secondary-button"}
        type="button"
        onClick={() => toggleAction("new-recording")}
      >
        New recording
      </button>
      {openAction
        ? (
          <div class="session-recording-popover">
            <form method="post" class="session-recording-popover-form">
              <SessionPageActionFields
                sessionId={props.sessionId}
                includeStale={props.includeStale}
                workspaceFilter={props.workspaceFilter}
                csrfToken={props.csrfToken}
              />
              <input type="hidden" name="action" value={openAction} />
              <div class="session-recording-popover-copy">
                <strong>{buildPopoverTitle(openAction)}</strong>
                <span>{buildPopoverDescription(openAction)}</span>
              </div>
              <select
                class="form-input session-recording-select"
                name="workspaceSelector"
                value={selectedWorkspace}
                onInput={(event) =>
                  setSelectedWorkspace(
                    (event.currentTarget as HTMLSelectElement).value,
                  )}
              >
                {props.workspaceOptions.map((option) => (
                  <option key={option.workspaceId} value={option.workspaceId}>
                    {option.alias}
                  </option>
                ))}
              </select>
              <div class="session-recording-popover-actions">
                <button class="secondary-button" type="submit">
                  {buildSubmitLabel(openAction)}
                </button>
                <button
                  class="secondary-button"
                  type="button"
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
  );
  const countSummary = buildCountSummary({
    includeStale: pageData.includeStale,
    activeSessionCount: pageData.activeSessionCount,
    staleSessionCount: pageData.staleSessionCount,
    inactiveSessionCount: pageData.inactiveSessionCount,
  });
  const timeZone = useBrowserTimeZone();
  const defaultWorkspaceSelectorValue = resolveDefaultWorkspaceSelectorValue(
    pageData,
  );

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
                canStopRecording,
              );
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
                      csrfToken={props.csrfToken}
                      workspaceOptions={pageData.workspaceOptions}
                      defaultWorkspaceSelectorValue={defaultWorkspaceSelectorValue}
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
                                >
                                  [stop all]
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
                              {canStopRecording(recording)
                                ? (
                                  <form
                                    method="post"
                                    class="session-list-action-form session-inline-action-form"
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
                                      value={recording.recordingCycleId ?? ""}
                                    />
                                    <input
                                      type="hidden"
                                      name="outputPath"
                                      value={recording.outputPath}
                                    />
                                    <button
                                      class="session-inline-action session-inline-action-danger mono"
                                      type="submit"
                                    >
                                      [stop]
                                    </button>
                                  </form>
                                )
                                : null}
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
