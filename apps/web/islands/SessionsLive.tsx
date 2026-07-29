import { formatWorkspaceLabel } from "@kato/shared";
import { activityStateDot, activityStateLabel } from "../src/activity_state.ts";
import { formatBytes } from "../src/format_bytes.ts";
import type {
  SessionActivityRow,
  SessionRecordingActivityRow,
  SessionsPageData,
} from "../src/loaders/sessions.ts";
import {
  buildRecordingsRecordingHref,
  buildSessionDetailHref,
  buildSessionInventoryHref,
} from "../src/session_routes.ts";
import {
  applySessionTreeExpansion,
  buildSessionTree,
  resolveSessionIdFromHash,
  resolveSessionTreeExpansion,
  type SessionTreeNode,
} from "../src/session_tree.ts";
import {
  buildWorkspaceSelectorIds,
  canStopSessionRecording,
  deriveFilenameSlugFromTitle,
  readRememberedSessionsWorkspace,
  rememberSessionsWorkspace,
  resolveDefaultWorkspaceSelectorValue,
  resolvePolledCreationFields,
  resolveTitleDerivedFilenameSlug,
  type SessionRecordingAction,
} from "../src/session_recording_view_model.ts";
import { TimestampText } from "../src/TimestampText.tsx";
import SessionSnippet from "./SessionSnippet.tsx";
import { useBrowserTimeZone } from "./use_browser_time_zone.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";
import { useEffect, useRef, useState } from "preact/hooks";

const UNLINKED_TREE_KEY = "__unlinked-subconversations__";

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

function positionRecordingPopover(
  root: HTMLDivElement,
  popover: HTMLDivElement,
) {
  const viewportPadding = 16;
  const anchorGap = 8;
  const rootRect = root.getBoundingClientRect();
  const viewportHeight = globalThis.innerHeight ||
    document.documentElement.clientHeight;
  const maxVisibleHeight = Math.max(0, viewportHeight - viewportPadding * 2);
  const popoverHeight = Math.min(popover.scrollHeight, maxVisibleHeight);
  const belowTop = rootRect.bottom + anchorGap;
  const belowFits = belowTop + popoverHeight <=
    viewportHeight - viewportPadding;
  const aboveTop = rootRect.top - anchorGap - popoverHeight;
  const preferredTop = belowFits || aboveTop < viewportPadding
    ? belowTop
    : aboveTop;
  const clampedTop = Math.min(
    Math.max(preferredTop, viewportPadding),
    Math.max(viewportPadding, viewportHeight - viewportPadding - popoverHeight),
  );

  popover.style.setProperty(
    "--session-recording-popover-top",
    `${Math.round(clampedTop - rootRect.top)}px`,
  );
  popover.style.setProperty(
    "--session-recording-popover-max-height",
    `${Math.round(maxVisibleHeight)}px`,
  );
}

function SessionRecordingActions(
  props: {
    sessionId: string;
    includeStale: boolean;
    workspaceFilter?: string;
    workspaceFilterId?: string;
    sessionSnippet?: string;
    outputMetadataDefaults?: SessionActivityRow["outputMetadataDefaults"];
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
  const initialDisplayTitle = props.outputMetadataDefaults?.displayTitle ??
    props.sessionSnippet ?? "";
  const [displayTitle, setDisplayTitle] = useState(() => initialDisplayTitle);
  const [filenameSlug, setFilenameSlug] = useState(
    () =>
      props.outputMetadataDefaults?.filenameSlug ??
        deriveFilenameSlugFromTitle(initialDisplayTitle),
  );
  const [tagsInput, setTagsInput] = useState("");
  const [displayTitleCustomized, setDisplayTitleCustomized] = useState(false);
  const [filenameSlugCustomized, setFilenameSlugCustomized] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const resetCreationFields = () => {
    const nextTitle = props.outputMetadataDefaults?.displayTitle ??
      props.sessionSnippet ?? "";
    setDisplayTitle(nextTitle);
    setFilenameSlug(
      props.outputMetadataDefaults?.filenameSlug ??
        deriveFilenameSlugFromTitle(nextTitle),
    );
    setTagsInput("");
    setDisplayTitleCustomized(false);
    setFilenameSlugCustomized(false);
  };

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
    const next = resolvePolledCreationFields({
      currentDisplayTitle: displayTitle,
      currentFilenameSlug: filenameSlug,
      displayTitleCustomized,
      filenameSlugCustomized,
      sessionSnippet: props.sessionSnippet,
      defaultDisplayTitle: props.outputMetadataDefaults?.displayTitle,
      defaultFilenameSlug: props.outputMetadataDefaults?.filenameSlug,
    });
    if (next.displayTitle !== displayTitle) {
      setDisplayTitle(next.displayTitle);
    }
    if (next.filenameSlug !== filenameSlug) {
      setFilenameSlug(next.filenameSlug);
    }
  }, [
    displayTitle,
    displayTitleCustomized,
    filenameSlug,
    filenameSlugCustomized,
    props.outputMetadataDefaults?.displayTitle,
    props.outputMetadataDefaults?.filenameSlug,
    props.sessionSnippet,
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

  useEffect(() => {
    if (!openAction) {
      return;
    }

    let frameId: number | undefined;
    const schedulePopoverPosition = () => {
      if (frameId !== undefined && "cancelAnimationFrame" in globalThis) {
        globalThis.cancelAnimationFrame(frameId);
      }
      if ("requestAnimationFrame" in globalThis) {
        frameId = globalThis.requestAnimationFrame(() => {
          frameId = undefined;
          if (rootRef.current && popoverRef.current) {
            positionRecordingPopover(rootRef.current, popoverRef.current);
          }
        });
        return;
      }
      if (rootRef.current && popoverRef.current) {
        positionRecordingPopover(rootRef.current, popoverRef.current);
      }
    };

    schedulePopoverPosition();
    globalThis.addEventListener("resize", schedulePopoverPosition);
    globalThis.addEventListener("scroll", schedulePopoverPosition, true);
    return () => {
      if (frameId !== undefined && "cancelAnimationFrame" in globalThis) {
        globalThis.cancelAnimationFrame(frameId);
      }
      globalThis.removeEventListener("resize", schedulePopoverPosition);
      globalThis.removeEventListener("scroll", schedulePopoverPosition, true);
    };
  }, [
    displayTitle,
    filenameSlug,
    openAction,
    props.workspaceOptions,
    selectedWorkspace,
    tagsInput,
  ]);

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
    setOpenAction((current) => {
      if (current === action) {
        return null;
      }
      resetCreationFields();
      return action;
    });
  };

  const selectedWorkspaceOption = props.workspaceOptions.find((option) =>
    option.workspaceId === selectedWorkspace
  );
  const selectedTemplate = selectedWorkspaceOption?.filenameTemplate;
  const selectedDefaultTags = selectedWorkspaceOption?.defaultTags ?? [];
  const selectedTagSuggestions = selectedWorkspaceOption?.tagSuggestions ?? [];
  const selectedTemplateUsesSnippet =
    selectedWorkspaceOption?.filenameTemplateIncludesSnippet ?? true;
  const filenamePreview = selectedTemplate
    ? selectedTemplate.replaceAll(
      "{snippetSlug}",
      filenameSlug || "conversation",
    )
    : filenameSlug || "conversation";

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
          <div ref={popoverRef} class="session-recording-popover">
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
                onInput={(event) => {
                  setSelectedWorkspace(
                    (event.currentTarget as HTMLSelectElement).value,
                  );
                }}
              >
                {props.workspaceOptions.map((option) => (
                  <option key={option.workspaceId} value={option.workspaceId}>
                    {formatWorkspaceLabel(option.alias, option.displayName)}
                  </option>
                ))}
              </select>
              {selectedDefaultTags.length > 0
                ? (
                  <div class="session-recording-default-tags muted mono">
                    Default tags: {selectedDefaultTags.join(", ")}
                  </div>
                )
                : null}
              <label class="form-label" for={`display-title-${openAction}`}>
                Title
              </label>
              <input
                id={`display-title-${openAction}`}
                class="form-input"
                name={props.outputMetadataDefaults?.displayTitle ===
                      undefined ||
                    displayTitleCustomized
                  ? "displayTitle"
                  : undefined}
                type="text"
                value={displayTitle}
                onInput={(event) => {
                  const nextTitle = (event.currentTarget as HTMLInputElement)
                    .value;
                  setDisplayTitle(nextTitle);
                  setDisplayTitleCustomized(true);
                  setFilenameSlug((current) =>
                    resolveTitleDerivedFilenameSlug({
                      title: nextTitle,
                      currentFilenameSlug: current,
                      filenameSlugCustomized,
                    })
                  );
                }}
              />
              <label class="form-label" for={`tags-${openAction}`}>
                Tags
              </label>
              <input
                id={`tags-${openAction}`}
                class="form-input"
                name="tags"
                type="text"
                list={`tag-suggestions-${openAction}`}
                value={tagsInput}
                onInput={(event) =>
                  setTagsInput(
                    (event.currentTarget as HTMLInputElement).value,
                  )}
              />
              <datalist id={`tag-suggestions-${openAction}`}>
                {selectedTagSuggestions.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
              {selectedTemplateUsesSnippet
                ? (
                  <>
                    <label
                      class="form-label"
                      for={`filename-slug-${openAction}`}
                    >
                      Filename snippet
                    </label>
                    <div class="session-recording-slug-row">
                      <input
                        id={`filename-slug-${openAction}`}
                        class="form-input"
                        name={props.outputMetadataDefaults?.filenameSlug ===
                              undefined ||
                            displayTitleCustomized ||
                            filenameSlugCustomized
                          ? "filenameSlug"
                          : undefined}
                        type="text"
                        value={filenameSlug}
                        onInput={(event) => {
                          setFilenameSlug(
                            (event.currentTarget as HTMLInputElement).value,
                          );
                          setFilenameSlugCustomized(true);
                        }}
                      />
                      <button
                        class="secondary-button session-recording-reset-button"
                        type="button"
                        disabled={!filenameSlugCustomized ||
                          pendingCreateAction !== null}
                        onClick={() => {
                          setFilenameSlug(
                            displayTitleCustomized
                              ? deriveFilenameSlugFromTitle(displayTitle)
                              : props.outputMetadataDefaults?.filenameSlug ??
                                deriveFilenameSlugFromTitle(displayTitle),
                          );
                          setFilenameSlugCustomized(false);
                        }}
                      >
                        Reset
                      </button>
                    </div>
                  </>
                )
                : null}
              <div class="session-recording-preview muted mono">
                Filename: {filenamePreview}
              </div>
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

function buildSubconversationSummary(node: SessionTreeNode): string {
  const parts = [
    `${node.descendantCount} sub-conversation${
      node.descendantCount === 1 ? "" : "s"
    }`,
  ];
  if (node.activeDescendantCount > 0) {
    parts.push(`${node.activeDescendantCount} active`);
  }
  if (node.descendantActiveRecordingCount > 0) {
    parts.push(
      `${node.descendantActiveRecordingCount} recording${
        node.descendantActiveRecordingCount === 1 ? "" : "s"
      }`,
    );
  }
  if (node.descendantTwinSizeBytes !== undefined) {
    parts.push(
      `${formatBytes(node.descendantTwinSizeBytes)} child Twin${
        node.descendantCount === 1 ? "" : "s"
      }`,
    );
  }
  return parts.join(" · ");
}

function SessionRow(
  props: {
    row: SessionActivityRow;
    node: SessionTreeNode;
    expanded: boolean;
    onToggle: (sessionId: string) => void;
    pageData: SessionsPageData;
    csrfToken?: string;
    timeZone?: string;
    pendingStopActionKey: string | null;
    handleStopSubmit: (actionKey: string) => (event: Event) => void;
  },
) {
  const row = props.row;
  const [revealedSnippet, setRevealedSnippet] = useState<string | undefined>(
    undefined,
  );
  const engagedRecordings = row.recordings.filter((recording) =>
    recording.state !== "stopped"
  );
  const stoppableRecordings = engagedRecordings.filter(
    canStopSessionRecording,
  );
  const stopAllActionKey = buildStopAllActionKey(row.sessionId);
  const childrenId = `session-children-${row.sessionId}`;

  return (
    <div
      class={`session-list-row ${row.state}${
        row.structuralContext ? " structural-context" : ""
      }`}
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
            onSnippetResolved={setRevealedSnippet}
          />
        </span>{" "}
        <span class="muted mono session-list-updated">
          Updated{" "}
          <TimestampText value={row.updatedAt} timeZone={props.timeZone} />
          {" · Twin "}
          {row.twinSizeBytes === undefined
            ? "absent"
            : formatBytes(row.twinSizeBytes)}
          {row.twinSizeBytes !== undefined
            ? (
              <>
                {" · "}
                <a href={buildSessionDetailHref(row.sessionId)}>
                  View
                </a>
              </>
            )
            : null}
        </span>
        {row.relationship || row.structuralContext
          ? (
            <span class="session-list-flags muted mono">
              {row.relationship ? "Sub-conversation" : null}
              {row.relationship && row.structuralContext ? " · " : null}
              {row.structuralContext ? "Context parent" : null}
            </span>
          )
          : null}
        {props.node.children.length > 0
          ? (
            <button
              class="session-tree-toggle mono"
              type="button"
              aria-expanded={props.expanded ? "true" : "false"}
              aria-controls={childrenId}
              onClick={() => props.onToggle(row.sessionId)}
            >
              <span class="session-tree-chevron" aria-hidden="true">›</span>
              {buildSubconversationSummary(props.node)}
            </button>
          )
          : null}
      </span>
      <div class="session-list-right">
        <SessionRecordingActions
          sessionId={row.sessionId}
          includeStale={props.pageData.includeStale}
          workspaceFilter={props.pageData.workspaceFilter}
          workspaceFilterId={props.pageData.workspaceFilterId}
          sessionSnippet={row.snippet ?? revealedSnippet}
          outputMetadataDefaults={row.outputMetadataDefaults}
          csrfToken={props.csrfToken}
          workspaceOptions={props.pageData.workspaceOptions}
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
                    onSubmit={props.handleStopSubmit(stopAllActionKey)}
                  >
                    <SessionPageActionFields
                      sessionId={row.sessionId}
                      includeStale={props.pageData.includeStale}
                      workspaceFilter={props.pageData.workspaceFilter}
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
                      disabled={props.pendingStopActionKey !== null}
                    >
                      {props.pendingStopActionKey === stopAllActionKey
                        ? "[stopping all...]"
                        : "[stop all]"}
                    </button>
                  </form>
                )
                : null}
            </div>
            <div class="session-engaged-recordings muted mono">
              {engagedRecordings.map((recording) => {
                const stopActionKey = buildStopRecordingActionKey(
                  row.sessionId,
                  recording.key,
                );
                return (
                  <div key={recording.key} class="session-engaged-line">
                    <span class="session-engaged-copy">
                      <a href={recording.workspaceHref}>
                        {buildWorkspaceLabel(recording)}
                      </a>
                      <span>:</span>
                      <a
                        href={buildRecordingsRecordingHref({
                          workspaceFilter: resolveRecordingWorkspaceFilter(
                            recording,
                          ),
                          recordingCycleId: recording.recordingCycleId,
                          rowKey: recording.key,
                        })}
                      >
                        {buildRecordingFilename(recording.displayOutputPath)}
                      </a>
                    </span>
                    {canStopSessionRecording(recording)
                      ? (
                        <form
                          method="post"
                          class="session-list-action-form session-inline-action-form"
                          onSubmit={props.handleStopSubmit(stopActionKey)}
                        >
                          <SessionPageActionFields
                            sessionId={row.sessionId}
                            includeStale={props.pageData.includeStale}
                            workspaceFilter={props.pageData.workspaceFilter}
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
                            disabled={props.pendingStopActionKey !== null}
                          >
                            {props.pendingStopActionKey === stopActionKey
                              ? "[stopping...]"
                              : "[stop]"}
                          </button>
                        </form>
                      )
                      : null}
                  </div>
                );
              })}
            </div>
          </div>
        )
        : null}
    </div>
  );
}

function SessionTreeBranch(
  props: {
    node: SessionTreeNode;
    expandedSessionIds: ReadonlySet<string>;
    onToggle: (sessionId: string) => void;
    pageData: SessionsPageData;
    csrfToken?: string;
    timeZone?: string;
    pendingStopActionKey: string | null;
    handleStopSubmit: (actionKey: string) => (event: Event) => void;
  },
) {
  const expanded = props.expandedSessionIds.has(props.node.row.sessionId);
  const childrenId = `session-children-${props.node.row.sessionId}`;
  return (
    <li class="session-tree-node">
      <SessionRow
        row={props.node.row}
        node={props.node}
        expanded={expanded}
        onToggle={props.onToggle}
        pageData={props.pageData}
        csrfToken={props.csrfToken}
        timeZone={props.timeZone}
        pendingStopActionKey={props.pendingStopActionKey}
        handleStopSubmit={props.handleStopSubmit}
      />
      {props.node.children.length > 0
        ? (
          <ul
            id={childrenId}
            class="session-tree-children"
            hidden={!expanded}
          >
            {expanded
              ? props.node.children.map((child) => (
                <SessionTreeBranch
                  key={child.row.sessionKey}
                  node={child}
                  expandedSessionIds={props.expandedSessionIds}
                  onToggle={props.onToggle}
                  pageData={props.pageData}
                  csrfToken={props.csrfToken}
                  timeZone={props.timeZone}
                  pendingStopActionKey={props.pendingStopActionKey}
                  handleStopSubmit={props.handleStopSubmit}
                />
              ))
              : null}
          </ul>
        )
        : null}
    </li>
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
  const sessionTree = buildSessionTree(pageData.rows);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const lastExpansionSignatureRef = useRef<string | null>(null);
  const lastScrolledHashRef = useRef<string | null>(null);
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
  const toggleSession = (sessionId: string) => {
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!("location" in globalThis) || !("document" in globalThis)) {
      return;
    }
    const handleHash = () => {
      const hash = globalThis.location.hash;
      const targetSessionId = resolveSessionIdFromHash(hash);
      if (!targetSessionId) {
        return;
      }
      const expansion = resolveSessionTreeExpansion(
        pageData.rows,
        targetSessionId,
        sessionTree,
      );
      if (!expansion) {
        return;
      }
      if (expansion.signature !== lastExpansionSignatureRef.current) {
        setExpandedSessionIds((current) =>
          applySessionTreeExpansion(
            current,
            expansion,
            UNLINKED_TREE_KEY,
          )
        );
        lastExpansionSignatureRef.current = expansion.signature;
      }
      if (hash === lastScrolledHashRef.current) {
        return;
      }
      lastScrolledHashRef.current = hash;
      globalThis.setTimeout(() => {
        const scroll = () =>
          document.getElementById(`session-${targetSessionId}`)
            ?.scrollIntoView({ block: "center" });
        if ("requestAnimationFrame" in globalThis) {
          globalThis.requestAnimationFrame(scroll);
        } else {
          scroll();
        }
      }, 0);
    };

    handleHash();
    globalThis.addEventListener("hashchange", handleHash);
    return () => globalThis.removeEventListener("hashchange", handleHash);
  }, [pageData.rows]);

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
            <div class="filter-choice-group">
              <span class="filter-choice-label muted mono">Activity</span>
              <div class="filter-choice-row">
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
              </div>
            </div>
            {pageData.workspaceFilter
              ? (
                <div class="filter-choice-group">
                  <span class="filter-choice-label muted mono">Workspace</span>
                  <div class="filter-choice-row">
                    <a
                      class="secondary-button"
                      href={buildSessionInventoryHref({
                        includeStale: pageData.includeStale,
                      })}
                    >
                      Clear Filter
                    </a>
                  </div>
                </div>
              )
              : null}
          </div>
        </div>

        <hr class="sessions-header-divider" />

        <ul class="session-list-rows">
          {pageData.rows.length === 0
            ? <li class="muted">No sessions match the current filters.</li>
            : (
              <>
                {sessionTree.roots.map((node) => (
                  <SessionTreeBranch
                    key={node.row.sessionKey}
                    node={node}
                    expandedSessionIds={expandedSessionIds}
                    onToggle={toggleSession}
                    pageData={pageData}
                    csrfToken={props.csrfToken}
                    timeZone={timeZone}
                    pendingStopActionKey={pendingStopActionKey}
                    handleStopSubmit={handleStopSubmit}
                  />
                ))}
                {sessionTree.unlinked.length > 0
                  ? (
                    <li class="session-tree-unlinked">
                      <button
                        class="session-tree-unlinked-toggle mono"
                        type="button"
                        aria-expanded={expandedSessionIds.has(
                            UNLINKED_TREE_KEY,
                          )
                          ? "true"
                          : "false"}
                        aria-controls="session-unlinked-children"
                        onClick={() => toggleSession(UNLINKED_TREE_KEY)}
                      >
                        <span
                          class="session-tree-chevron"
                          aria-hidden="true"
                        >
                          ›
                        </span>
                        Unlinked sub-conversations · {sessionTree.unlinked
                          .reduce(
                            (sum, node) => sum + 1 + node.descendantCount,
                            0,
                          )}
                      </button>
                      <ul
                        id="session-unlinked-children"
                        class="session-tree-children session-tree-unlinked-children"
                        hidden={!expandedSessionIds.has(UNLINKED_TREE_KEY)}
                      >
                        {expandedSessionIds.has(UNLINKED_TREE_KEY)
                          ? sessionTree.unlinked.map((node) => (
                            <SessionTreeBranch
                              key={node.row.sessionKey}
                              node={node}
                              expandedSessionIds={expandedSessionIds}
                              onToggle={toggleSession}
                              pageData={pageData}
                              csrfToken={props.csrfToken}
                              timeZone={timeZone}
                              pendingStopActionKey={pendingStopActionKey}
                              handleStopSubmit={handleStopSubmit}
                            />
                          ))
                          : null}
                      </ul>
                    </li>
                  )
                  : null}
              </>
            )}
        </ul>
      </article>
    </section>
  );
}
