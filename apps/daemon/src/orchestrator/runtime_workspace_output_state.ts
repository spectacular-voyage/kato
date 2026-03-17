import type { SessionMetadataV1 } from "@kato/shared";
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
    cycle.stoppedBySeq = stopCursor;
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
    startedBySeq: startCursor,
  });
  output.activeRecordingCycleId = recordingCycleId;
  output.desiredState = "on";
  return recordingCycleId;
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
