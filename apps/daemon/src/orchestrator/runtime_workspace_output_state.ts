import type {
  ConversationEvent,
  SessionMetadataV1,
  SessionWorkspaceOutputWriteSourceCursorV1,
} from "@kato/shared";
import { isAbsolute, relative, resolve } from "@std/path";
import type { ResolvedWorkspaceProfile } from "../workspace/mod.ts";

export type WorkspaceOutputState = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number];

export type WorkspaceDestinationBinding =
  WorkspaceOutputState["currentDestination"];

export function readWorkspaceOutputs(
  metadata: SessionMetadataV1,
): NonNullable<SessionMetadataV1["workspaceOutputs"]> {
  if (!metadata.workspaceOutputs) {
    metadata.workspaceOutputs = [];
  }
  return metadata.workspaceOutputs;
}

export function findWorkspaceOutput(
  metadata: SessionMetadataV1,
  workspaceId: string,
): WorkspaceOutputState | undefined {
  let latestMatch: WorkspaceOutputState | undefined;
  const outputs = readWorkspaceOutputs(metadata);
  for (let i = outputs.length - 1; i >= 0; i -= 1) {
    const entry = outputs[i];
    if (!entry || entry.workspaceId !== workspaceId) {
      continue;
    }
    if (!latestMatch) {
      latestMatch = entry;
    }
    if (entry.desiredState === "on") {
      return entry;
    }
  }
  return latestMatch;
}

export function activeWorkspaceOutputs(
  metadata: SessionMetadataV1,
): NonNullable<SessionMetadataV1["workspaceOutputs"]> {
  return readWorkspaceOutputs(metadata).filter((entry) =>
    entry.desiredState === "on"
  );
}

export function closeWorkspaceOutputCycle(
  output: WorkspaceOutputState,
  stopCursor: number,
  nowIso: string,
): boolean {
  const cycleId = output.activeRecordingCycleId;
  if (!cycleId) {
    const changed = output.desiredState !== "off";
    delete output.activeRecordingCycleId;
    output.desiredState = "off";
    return changed;
  }
  for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
    const cycle = output.recordingCycles[i];
    if (
      !cycle || cycle.recordingCycleId !== cycleId ||
      cycle.stoppedCursor !== undefined
    ) {
      continue;
    }
    cycle.stoppedCursor = stopCursor;
    cycle.stoppedAt = nowIso;
    if (stopCursor > 0) {
      cycle.stoppedBySeq = stopCursor;
    } else {
      delete cycle.stoppedBySeq;
    }
    break;
  }
  delete output.activeRecordingCycleId;
  output.desiredState = "off";
  return true;
}

export function stopAllWorkspaceOutputs(
  metadata: SessionMetadataV1,
  stopCursor: number,
  nowIso: string,
): string[] {
  const changed: string[] = [];
  for (const output of readWorkspaceOutputs(metadata)) {
    if (closeWorkspaceOutputCycle(output, stopCursor, nowIso)) {
      changed.push(output.workspaceId);
    }
  }
  return changed;
}

export function openWorkspaceOutputCycle(
  output: WorkspaceOutputState,
  startCursor: number,
  nowIso: string,
  recordingCycleId: string = crypto.randomUUID(),
): string {
  output.recordingCycles.push({
    recordingCycleId,
    startedCursor: startCursor,
    startedAt: nowIso,
    lastWriteAt: nowIso,
    ...(startCursor > 0 ? { startedBySeq: startCursor } : {}),
  });
  output.activeRecordingCycleId = recordingCycleId;
  output.desiredState = "on";
  return recordingCycleId;
}

function readPositionalSourceCursor(
  event: ConversationEvent | undefined,
): SessionWorkspaceOutputWriteSourceCursorV1 | undefined {
  const cursor = event?.source.rawCursor;
  if (
    cursor && (cursor.kind === "byte-offset" || cursor.kind === "item-index") &&
    Number.isSafeInteger(cursor.value) && cursor.value >= 0
  ) {
    return { kind: cursor.kind, value: cursor.value };
  }
  return undefined;
}

function readActiveCycleLastWriteMs(
  output: WorkspaceOutputState,
): number | undefined {
  const cycleId = output.activeRecordingCycleId;
  if (!cycleId) return undefined;
  for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
    const cycle = output.recordingCycles[i];
    if (cycle?.recordingCycleId !== cycleId) continue;
    const ms = cycle.lastWriteAt ? Date.parse(cycle.lastWriteAt) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/**
 * Records that `events[0, writeCursor)` have been written to `output`. The
 * source cursor of the last written event is what later passes resume from;
 * `writeCursor` is kept for older binaries.
 */
export function setWorkspaceOutputWritePosition(
  output: WorkspaceOutputState,
  events: readonly ConversationEvent[],
  writeCursor: number,
): void {
  const end = Math.max(0, Math.min(events.length, Math.floor(writeCursor)));
  output.writeCursor = end;
  for (let i = end - 1; i >= 0; i -= 1) {
    const cursor = readPositionalSourceCursor(events[i]);
    if (cursor) {
      output.writeSourceCursor = cursor;
      return;
    }
  }
  delete output.writeSourceCursor;
}

/**
 * Index of the first snapshot event not yet written to `output`.
 *
 * The snapshot is rebuilt on every daemon start and keeps only its newest
 * events, so a stored index cannot be trusted. Resolution order:
 * 1. `writeSourceCursor`: everything after the last event at or before that
 *    source position (all events when every comparable event is newer, i.e.
 *    a snapshot rebuilt from content that arrived later).
 * 2. Outputs already written by older versions (no source cursor,
 *    `writeCursor > 0`, snapshot has positional cursors to migrate to):
 *    events whose timestamp is after the active cycle's `lastWriteAt`. When
 *    timestamped events exist but none is newer, everything counts as
 *    written.
 * 3. The stored index, clamped (no comparable cursors or timestamps).
 */
export function resolveWorkspaceOutputWriteStart(
  output: WorkspaceOutputState,
  events: readonly ConversationEvent[],
): number {
  const anchor = output.writeSourceCursor;
  if (anchor) {
    let sawComparable = false;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const cursor = readPositionalSourceCursor(events[i]);
      if (!cursor || cursor.kind !== anchor.kind) continue;
      sawComparable = true;
      if (cursor.value <= anchor.value) return i + 1;
    }
    if (sawComparable) return 0;
  } else if (
    output.writeCursor > 0 &&
    events.some((event) => readPositionalSourceCursor(event) !== undefined)
  ) {
    // One-time migration: the write that follows records a source cursor.
    // writeCursor 0 means nothing was written yet (e.g. auto-record), and
    // without positional cursors there is nothing to migrate to.
    const lastWriteMs = readActiveCycleLastWriteMs(output);
    if (lastWriteMs !== undefined) {
      let sawTimestamp = false;
      for (let i = 0; i < events.length; i += 1) {
        const eventMs = Date.parse(events[i]?.timestamp ?? "");
        if (!Number.isFinite(eventMs)) continue;
        sawTimestamp = true;
        if (eventMs > lastWriteMs) return i;
      }
      if (sawTimestamp) return events.length;
    }
  }
  return Math.max(0, Math.min(output.writeCursor, events.length));
}

export function updateWorkspaceOutputCycleLastWrite(
  output: WorkspaceOutputState,
  lastWriteAt: string,
  recordingCycleId: string | undefined = output.activeRecordingCycleId,
): boolean {
  const cycleId = recordingCycleId?.trim();
  if (!cycleId) {
    return false;
  }
  for (let i = output.recordingCycles.length - 1; i >= 0; i -= 1) {
    const cycle = output.recordingCycles[i];
    if (!cycle || cycle.recordingCycleId !== cycleId) {
      continue;
    }
    if (cycle.lastWriteAt === lastWriteAt) {
      return false;
    }
    cycle.lastWriteAt = lastWriteAt;
    return true;
  }
  return false;
}

export function applyWorkspaceProfileSnapshot(
  output: WorkspaceOutputState,
  profile: ResolvedWorkspaceProfile,
  resolvedDefaultOutputDir: string,
): void {
  output.workspaceAliasSnapshot = profile.alias;
  output.sourceConfigPath = profile.configPath;
  output.workspaceRootSnapshot = profile.workspaceRoot;
  output.resolvedDefaultOutputDir = resolvedDefaultOutputDir;
  output.filenameTemplate = profile.filenameTemplate;
  output.defaultTags = [...profile.defaultTags];
  output.writerFeatureFlags = { ...profile.writerFeatureFlags };
}

export function createWorkspaceOutputState(options: {
  profile: ResolvedWorkspaceProfile;
  binding: WorkspaceDestinationBinding;
  resolvedPath: string;
  resolvedDefaultOutputDir: string;
  desiredState: "on" | "off";
  writeCursor: number;
  nowIso: string;
}): WorkspaceOutputState {
  return {
    workspaceId: options.profile.workspaceId,
    workspaceAliasSnapshot: options.profile.alias,
    desiredState: options.desiredState,
    currentDestination: options.binding,
    currentResolvedPath: options.resolvedPath,
    sourceConfigPath: options.profile.configPath,
    workspaceRootSnapshot: options.profile.workspaceRoot,
    resolvedDefaultOutputDir: options.resolvedDefaultOutputDir,
    filenameTemplate: options.profile.filenameTemplate,
    defaultTags: [...options.profile.defaultTags],
    writerFeatureFlags: { ...options.profile.writerFeatureFlags },
    writeCursor: options.writeCursor,
    createdAt: options.nowIso,
    recordingCycles: [],
  };
}

export function toWorkspaceDestinationBinding(
  profile: ResolvedWorkspaceProfile,
  resolvedPath: string,
): WorkspaceDestinationBinding {
  const rel = relative(resolve(profile.workspaceRoot), resolve(resolvedPath));
  if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
    return {
      kind: "workspace-relative",
      relativePathFromWorkspaceRoot: rel,
    };
  }
  if (rel === "") {
    return {
      kind: "workspace-relative",
      relativePathFromWorkspaceRoot: ".",
    };
  }
  return {
    kind: "absolute-explicit",
    absolutePath: resolve(resolvedPath),
  };
}

export function resolveBindingForRetargetedWorkspacePath(options: {
  profile: ResolvedWorkspaceProfile;
  currentBinding: WorkspaceDestinationBinding;
  resolvedPath: string;
}): WorkspaceDestinationBinding {
  if (options.currentBinding.kind === "absolute-explicit") {
    return {
      kind: "absolute-explicit",
      absolutePath: resolve(options.resolvedPath),
    };
  }
  return toWorkspaceDestinationBinding(options.profile, options.resolvedPath);
}
