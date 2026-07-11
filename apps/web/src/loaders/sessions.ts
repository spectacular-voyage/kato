import type {
  DaemonRecordingStatus,
  DaemonSessionStatus,
  SessionMetadataV1,
  SessionOutputMetadataV1,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
  UserConfig,
} from "@kato/shared";
import {
  DEFAULT_STATUS_STALE_AFTER_MS,
  isSessionStale,
  resolveEffectiveOutputMetadata,
  resolveOutputTagSuggestions,
} from "@kato/shared";
import {
  createDefaultUserConfig,
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  PersistentSessionStateStore,
  type RegisteredWorkspace,
  resolveDefaultKatoDir,
  resolveDefaultStatusPath,
  resolveDefaultUserConfigPath,
  resolveDefaultWorkspaceRegistryPath,
  UserConfigFileStore,
  WorkspaceProfileResolver,
  WorkspaceRegistryFileStore,
} from "@kato/runtime";
import { relative } from "@std/path";
import {
  type ActivityState,
  deriveSessionGenerationState,
  providerAutoGeneratesTwins,
} from "../activity_state.ts";
import { loadRuntimeConfigOrDefault } from "./activity_state.ts";
import { buildSessionInventorySessionHref } from "../session_routes.ts";
import {
  type OutputWriterPolicyProjection,
  projectOutputWriterPolicy,
} from "../output_writer_policy.ts";
import { resolveKatoDirFromStatusPath } from "./logs.ts";
import { resolveClaudeSubagentParentProviderSessionId } from "../../../daemon/src/providers/claude/mod.ts";

export interface SessionRecordingActivityRow {
  key: string;
  state: "engaged-active" | "engaged-stale" | "stopped";
  workspaceId?: string;
  workspaceAlias?: string;
  workspaceDisplayName?: string;
  workspaceHref: string;
  outputPath: string;
  displayOutputPath: string;
  startedAt?: string;
  stoppedAt?: string;
  lastWriteAt?: string;
  recordingCycleId?: string;
  effectiveMetadata?: SessionOutputMetadataV1;
  directMetadata?: SessionOutputMetadataV1;
  tagSuggestions?: string[];
  writerPolicy?: OutputWriterPolicyProjection;
}

export interface SessionActivityRow {
  sessionKey: string;
  provider: string;
  sessionId: string;
  sessionShortId: string;
  providerSessionId: string;
  relationship?: {
    kind: "subconversation";
    parentSessionId?: string;
  };
  structuralContext?: boolean;
  snippet?: string;
  updatedAt: string;
  lastEventAt?: string;
  twinSizeBytes?: number;
  stale: boolean;
  state: ActivityState;
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  outputMetadataDefaults?: SessionOutputMetadataV1;
  recordings: SessionRecordingActivityRow[];
}

export interface SessionsPageData {
  includeStale: boolean;
  includeSubagents: boolean;
  workspaceFilter?: string;
  workspaceFilterId?: string;
  workspaceFilterAlias?: string;
  workspaceFilterDisplayName?: string;
  workspaceOptions: WorkspaceOption[];
  sessionCount: number;
  activeSessionCount: number;
  staleSessionCount: number;
  inactiveSessionCount: number;
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  rows: SessionActivityRow[];
}

export interface LoadSessionActivityRowsOptions {
  includeStale?: boolean;
  includeSubagents?: boolean;
  workspaceFilter?: string;
  recordingsMode?: "latest" | "all";
  retainSubconversationAncestors?: boolean;
  now?: () => Date;
  katoDir?: string;
  statusPath?: string;
  statusStore?: DaemonStatusSnapshotStoreLike;
  workspaceEntries?: RegisteredWorkspace[];
}

export interface ResolvedWorkspaceFilter {
  selector: string;
  workspaceId: string;
  workspaceAlias?: string;
  workspaceDisplayName?: string;
}

export interface RecordingListEntry extends SessionRecordingActivityRow {
  provider: string;
  sessionId: string;
  sessionShortId: string;
  snippet?: string;
  sessionState: ActivityState;
  sessionHref: string;
  updatedAt: string;
  lastEventAt?: string;
}

export interface WorkspaceOption {
  workspaceId: string;
  alias: string;
  displayName?: string;
  filenameTemplate?: string;
  filenameTemplateIncludesSnippet?: boolean;
  defaultTags?: string[];
  tagSuggestions?: string[];
}

function resolveActivityTimestamp(
  row: Pick<
    SessionRecordingActivityRow,
    "lastWriteAt" | "stoppedAt" | "startedAt"
  >,
): number {
  for (const value of [row.lastWriteAt, row.stoppedAt, row.startedAt]) {
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function resolveEngagedRecordingState(options: {
  startedAt?: string;
  lastWriteAt?: string;
  sessionStale: boolean;
  now: Date;
}): SessionRecordingActivityRow["state"] {
  for (const value of [options.lastWriteAt, options.startedAt]) {
    if (!value) {
      continue;
    }
    return isSessionStale(
        value,
        options.now,
        DEFAULT_STATUS_STALE_AFTER_MS,
      )
      ? "engaged-stale"
      : "engaged-active";
  }
  return options.sessionStale ? "engaged-stale" : "engaged-active";
}

function resolveCycleTimestamp(
  cycle: Pick<
    SessionWorkspaceOutputState["recordingCycles"][number],
    "stoppedAt" | "startedAt"
  >,
): number {
  for (const value of [cycle.stoppedAt, cycle.startedAt]) {
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isUsableRelativePath(value: string): boolean {
  return value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    !/^[A-Za-z]:/.test(value);
}

function resolveDisplayOutputPath(
  outputPath: string,
  workspaceRoot?: string,
  relativePathHint?: string,
): string {
  const hinted = normalizePath(relativePathHint?.trim() ?? "");
  if (isUsableRelativePath(hinted)) {
    return hinted;
  }

  if (workspaceRoot) {
    const rel = normalizePath(relative(workspaceRoot, outputPath));
    if (isUsableRelativePath(rel)) {
      return rel;
    }
  }

  return outputPath;
}

function buildWorkspaceHref(workspaceId: string | undefined): string {
  return workspaceId ? `/workspaces#workspace-${workspaceId}` : "/workspaces";
}

async function loadRegisteredWorkspaces(
  katoDir: string,
): Promise<RegisteredWorkspace[]> {
  try {
    const store = new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    );
    return await store.load();
  } catch {
    return [];
  }
}

interface WorkspaceOutputProfileProjection {
  writerFeatureFlags: SessionWorkspaceAttachmentWriterFeatureFlagsV1;
  defaultTags: string[];
  tagSuggestions: string[];
}

async function loadUserConfigOrDefault(katoDir: string): Promise<UserConfig> {
  try {
    const store = new UserConfigFileStore(
      resolveDefaultUserConfigPath(katoDir),
    );
    return (await store.ensureInitialized(createDefaultUserConfig())).config;
  } catch {
    return createDefaultUserConfig();
  }
}

async function resolveWorkspaceOutputProfilesById(
  workspaceEntries: RegisteredWorkspace[],
  metadataList: SessionMetadataV1[],
): Promise<Map<string, WorkspaceOutputProfileProjection>> {
  const usedWorkspaceIds = new Set<string>();
  for (const metadata of metadataList) {
    for (const output of metadata.workspaceOutputs ?? []) {
      usedWorkspaceIds.add(output.workspaceId);
    }
  }
  const profilesById = new Map<string, WorkspaceOutputProfileProjection>();
  if (usedWorkspaceIds.size === 0) {
    return profilesById;
  }
  const resolver = new WorkspaceProfileResolver();
  for (const entry of workspaceEntries) {
    if (!usedWorkspaceIds.has(entry.workspaceId)) {
      continue;
    }
    try {
      const profile = await resolver.resolveForCommand(entry);
      profilesById.set(entry.workspaceId, {
        writerFeatureFlags: { ...profile.writerFeatureFlags },
        defaultTags: [...profile.defaultTags],
        tagSuggestions: [...profile.tagSuggestions],
      });
    } catch {
      // Unresolvable workspaces fall back to per-output snapshots.
    }
  }
  return profilesById;
}

async function resolveWorkspaceOptions(
  workspaceEntries: RegisteredWorkspace[],
  userConfig: UserConfig,
): Promise<WorkspaceOption[]> {
  const resolver = new WorkspaceProfileResolver();
  const options = await Promise.all(
    workspaceEntries.map(async (entry): Promise<WorkspaceOption> => {
      try {
        const profile = await resolver.resolveForCommand(entry);
        return {
          workspaceId: entry.workspaceId,
          alias: entry.alias,
          displayName: entry.displayName,
          filenameTemplate: profile.filenameTemplate,
          filenameTemplateIncludesSnippet: profile.filenameTemplate.includes(
            "{snippetSlug}",
          ),
          defaultTags: [...profile.defaultTags],
          tagSuggestions: resolveOutputTagSuggestions({
            workspaceTagSuggestions: [
              ...profile.defaultTags,
              ...profile.tagSuggestions,
            ],
            userGlobalTagSuggestions: userConfig.tagLibraries
              ?.globalSuggestions,
            userWorkspaceTagSuggestions: userConfig.tagLibraries
              ?.workspaceSuggestions[entry.workspaceId],
          }),
        };
      } catch {
        return {
          workspaceId: entry.workspaceId,
          alias: entry.alias,
          displayName: entry.displayName,
        };
      }
    }),
  );
  return options.sort((a, b) =>
    a.alias.localeCompare(b.alias) ||
    a.workspaceId.localeCompare(b.workspaceId)
  );
}

function sortRecordings(
  rows: SessionRecordingActivityRow[],
): SessionRecordingActivityRow[] {
  return [...rows].sort((a, b) => {
    const timeDiff = resolveActivityTimestamp(b) - resolveActivityTimestamp(a);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.outputPath.localeCompare(b.outputPath);
  });
}

function matchesWorkspaceFilter(
  row: SessionRecordingActivityRow,
  resolvedWorkspaceFilter: ResolvedWorkspaceFilter | undefined,
): boolean {
  if (!resolvedWorkspaceFilter) {
    return true;
  }
  return row.workspaceId === resolvedWorkspaceFilter.workspaceId ||
    (
      !row.workspaceId &&
      !!row.workspaceAlias &&
      row.workspaceAlias === resolvedWorkspaceFilter.workspaceAlias
    );
}

function resolveWorkspaceDisplayName(
  row: SessionRecordingActivityRow,
  workspaceDisplayNamesById: ReadonlyMap<string, string | undefined>,
  workspaceDisplayNamesByAlias: ReadonlyMap<string, string | undefined>,
): string | undefined {
  return (row.workspaceId
    ? workspaceDisplayNamesById.get(row.workspaceId)
    : undefined) ??
    (row.workspaceAlias
      ? workspaceDisplayNamesByAlias.get(row.workspaceAlias)
      : undefined);
}

function deriveSessionShortId(
  session: SessionMetadataV1,
  live: DaemonSessionStatus | undefined,
): string {
  return live?.sessionShortId ?? session.sessionId.slice(0, 8);
}

function hasTwinHistory(metadata: SessionMetadataV1): boolean {
  return metadata.nextTwinSeq > 1;
}

function hasPersistedTwinState(metadata: SessionMetadataV1): boolean {
  return hasTwinHistory(metadata) ||
    metadata.recentFingerprints.length > 0 ||
    metadata.ingestionActivatedAt !== undefined;
}

async function readTwinFileInfo(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

interface NormalizedPersistedTwinMetadata {
  metadata: SessionMetadataV1;
  twinSizeBytes?: number;
}

function hasLegacyManualIngestionHistory(metadata: SessionMetadataV1): boolean {
  return hasTwinHistory(metadata) &&
    (metadata.commandCursor ?? 0) === 0;
}

function hasExplicitTwinHistory(metadata: SessionMetadataV1): boolean {
  return metadata.ingestionActivatedAt !== undefined ||
    hasLegacyManualIngestionHistory(metadata);
}

function hasExplicitIngestionHistory(metadata: SessionMetadataV1): boolean {
  return hasExplicitTwinHistory(metadata) ||
    (metadata.workspaceOutputs?.length ?? 0) > 0;
}

function hasVisibleIngestionHistory(
  metadata: SessionMetadataV1,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfigOrDefault>>,
): boolean {
  return hasExplicitIngestionHistory(metadata) ||
    providerAutoGeneratesTwins(metadata.provider, runtimeConfig);
}

function normalizePersistedSessionState(
  metadata: SessionMetadataV1,
  state: ActivityState,
  runtimeConfig: Awaited<ReturnType<typeof loadRuntimeConfigOrDefault>>,
): ActivityState {
  if (
    state === "inactive" &&
    hasVisibleIngestionHistory(metadata, runtimeConfig)
  ) {
    return "stale";
  }
  return state;
}

async function normalizePersistedTwinMetadata(
  sessionStore: PersistentSessionStateStore,
  metadata: SessionMetadataV1,
): Promise<NormalizedPersistedTwinMetadata> {
  if (!hasPersistedTwinState(metadata)) {
    return { metadata };
  }
  const twinFileInfo = await readTwinFileInfo(metadata.twinPath);
  if (twinFileInfo) {
    const twinSizeBytes = hasTwinHistory(metadata) && twinFileInfo.isFile &&
        Number.isFinite(twinFileInfo.size) && twinFileInfo.size >= 0
      ? twinFileInfo.size
      : undefined;
    return {
      metadata,
      ...(twinSizeBytes !== undefined ? { twinSizeBytes } : {}),
    };
  }
  return {
    metadata: await sessionStore.resetSessionTwinPersistence(metadata),
  };
}

function findActiveCycle(
  output: SessionWorkspaceOutputState,
): SessionWorkspaceOutputState["recordingCycles"][number] | undefined {
  if (!output.activeRecordingCycleId) {
    return undefined;
  }
  return output.recordingCycles.find((
    cycle: SessionWorkspaceOutputState["recordingCycles"][number],
  ) => cycle.recordingCycleId === output.activeRecordingCycleId);
}

function findLatestStoppedCycle(
  output: SessionWorkspaceOutputState,
): SessionWorkspaceOutputState["recordingCycles"][number] | undefined {
  const stoppedCycles = output.recordingCycles.filter((cycle) =>
    cycle.recordingCycleId !== output.activeRecordingCycleId
  );
  return [...stoppedCycles].sort((a, b) =>
    resolveCycleTimestamp(b) - resolveCycleTimestamp(a)
  )[0];
}

interface OutputRowProjectionContext {
  outputMetadataDefaults?: SessionOutputMetadataV1;
  workspaceOutputProfilesById: ReadonlyMap<
    string,
    WorkspaceOutputProfileProjection
  >;
  userConfig: UserConfig;
}

function buildOutputRowProjection(
  output: SessionWorkspaceOutputState,
  context: OutputRowProjectionContext,
): Pick<
  SessionRecordingActivityRow,
  "effectiveMetadata" | "directMetadata" | "tagSuggestions" | "writerPolicy"
> {
  const workspaceProfile = context.workspaceOutputProfilesById.get(
    output.workspaceId,
  );
  const effectiveMetadata = resolveEffectiveOutputMetadata(
    context.outputMetadataDefaults,
    output.outputMetadata,
    workspaceProfile?.defaultTags ?? output.defaultTags,
  );
  const workspaceDefaultFlags = workspaceProfile?.writerFeatureFlags ??
    output.writerFeatureFlags;
  const tagSuggestions = resolveOutputTagSuggestions({
    workspaceTagSuggestions: workspaceProfile
      ? [
        ...workspaceProfile.defaultTags,
        ...workspaceProfile.tagSuggestions,
      ]
      : output.defaultTags ?? [],
    userGlobalTagSuggestions: context.userConfig.tagLibraries
      ?.globalSuggestions,
    userWorkspaceTagSuggestions: context.userConfig.tagLibraries
      ?.workspaceSuggestions[output.workspaceId],
    existingTags: effectiveMetadata.tags,
  });
  return {
    ...(Object.keys(effectiveMetadata).length > 0 ? { effectiveMetadata } : {}),
    ...(output.outputMetadata
      ? { directMetadata: structuredClone(output.outputMetadata) }
      : {}),
    ...(tagSuggestions.length > 0 ? { tagSuggestions } : {}),
    writerPolicy: projectOutputWriterPolicy(
      workspaceDefaultFlags,
      output.writerFeatureFlagOverrides,
    ),
  };
}

function buildRecordingRowsForOutput(
  output: SessionWorkspaceOutputState,
  liveRecordings: DaemonRecordingStatus[],
  sessionStale: boolean,
  now: Date,
  projectionContext: OutputRowProjectionContext,
): SessionRecordingActivityRow[] {
  const activeCycle = findActiveCycle(output);
  const liveRecording = liveRecordings.find((recording) =>
    recording.outputPath === output.currentResolvedPath
  );
  const displayOutputPath = resolveDisplayOutputPath(
    output.currentResolvedPath,
    output.workspaceRootSnapshot,
    output.currentDestination.relativePathFromWorkspaceRoot,
  );
  const projection = buildOutputRowProjection(output, projectionContext);
  const activeStartedAt = activeCycle?.startedAt ?? liveRecording?.startedAt;
  const activeLastWriteAt = liveRecording?.lastWriteAt ??
    activeCycle?.lastWriteAt;

  if (activeCycle || output.desiredState === "on") {
    return [{
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        activeCycle?.recordingCycleId ?? liveRecording?.recordingId ?? "active",
      ].join(":"),
      state: resolveEngagedRecordingState({
        startedAt: activeStartedAt,
        lastWriteAt: activeLastWriteAt,
        sessionStale,
        now,
      }),
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt: activeStartedAt,
      lastWriteAt: activeLastWriteAt,
      recordingCycleId: activeCycle?.recordingCycleId,
      ...projection,
    }];
  }

  const latestStoppedCycle = findLatestStoppedCycle(output);
  if (latestStoppedCycle) {
    return [{
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        latestStoppedCycle.recordingCycleId,
      ].join(":"),
      state: "stopped",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt: latestStoppedCycle.startedAt,
      lastWriteAt: latestStoppedCycle.lastWriteAt,
      stoppedAt: latestStoppedCycle.stoppedAt,
      recordingCycleId: latestStoppedCycle.recordingCycleId,
      ...projection,
    }];
  }

  if (!liveRecording) {
    return [];
  }

  return [{
    key: [
      output.workspaceId,
      output.currentResolvedPath,
      liveRecording.recordingId ?? "active",
    ].join(":"),
    state: resolveEngagedRecordingState({
      startedAt: liveRecording.startedAt,
      lastWriteAt: liveRecording.lastWriteAt,
      sessionStale,
      now,
    }),
    workspaceId: output.workspaceId,
    workspaceAlias: output.workspaceAliasSnapshot ??
      liveRecording.workspaceAlias,
    workspaceHref: buildWorkspaceHref(output.workspaceId),
    outputPath: output.currentResolvedPath,
    displayOutputPath,
    startedAt: liveRecording.startedAt,
    lastWriteAt: liveRecording.lastWriteAt,
    recordingCycleId: liveRecording.recordingId,
    ...projection,
  }];
}

function buildAllRecordingRowsForOutput(
  output: SessionWorkspaceOutputState,
  liveRecordings: DaemonRecordingStatus[],
  sessionStale: boolean,
  now: Date,
  projectionContext: OutputRowProjectionContext,
): SessionRecordingActivityRow[] {
  const activeCycle = findActiveCycle(output);
  const liveRecording = liveRecordings.find((recording) =>
    recording.outputPath === output.currentResolvedPath
  );
  const displayOutputPath = resolveDisplayOutputPath(
    output.currentResolvedPath,
    output.workspaceRootSnapshot,
    output.currentDestination.relativePathFromWorkspaceRoot,
  );
  const projection = buildOutputRowProjection(output, projectionContext);
  const rows: SessionRecordingActivityRow[] = [];

  for (const cycle of output.recordingCycles) {
    const active = activeCycle?.recordingCycleId === cycle.recordingCycleId;
    const startedAt = cycle.startedAt ??
      (active ? liveRecording?.startedAt : undefined);
    const lastWriteAt = active
      ? liveRecording?.lastWriteAt ?? cycle.lastWriteAt
      : cycle.lastWriteAt;
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        cycle.recordingCycleId,
      ].join(":"),
      state: active
        ? resolveEngagedRecordingState({
          startedAt,
          lastWriteAt,
          sessionStale,
          now,
        })
        : "stopped",
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt,
      stoppedAt: active ? undefined : cycle.stoppedAt,
      lastWriteAt,
      recordingCycleId: cycle.recordingCycleId,
      ...projection,
    });
  }

  const hasActiveRow = rows.some((row) => row.state !== "stopped");
  if (
    !hasActiveRow &&
    (output.desiredState === "on" || (rows.length === 0 && liveRecording))
  ) {
    rows.push({
      key: [
        output.workspaceId,
        output.currentResolvedPath,
        activeCycle?.recordingCycleId ?? liveRecording?.recordingId ?? "active",
      ].join(":"),
      state: resolveEngagedRecordingState({
        startedAt: activeCycle?.startedAt ?? liveRecording?.startedAt,
        lastWriteAt: liveRecording?.lastWriteAt ?? activeCycle?.lastWriteAt,
        sessionStale,
        now,
      }),
      workspaceId: output.workspaceId,
      workspaceAlias: output.workspaceAliasSnapshot ??
        liveRecording?.workspaceAlias,
      workspaceHref: buildWorkspaceHref(output.workspaceId),
      outputPath: output.currentResolvedPath,
      displayOutputPath,
      startedAt: activeCycle?.startedAt ?? liveRecording?.startedAt,
      lastWriteAt: liveRecording?.lastWriteAt,
      recordingCycleId: activeCycle?.recordingCycleId ??
        liveRecording?.recordingId,
      ...projection,
    });
  }

  return rows;
}

function buildRecordingRows(
  session: SessionMetadataV1,
  live: DaemonSessionStatus | undefined,
  recordingsMode: "latest" | "all" = "latest",
  now: Date,
  workspaceOutputProfilesById: OutputRowProjectionContext[
    "workspaceOutputProfilesById"
  ] = new Map(),
  userConfig: UserConfig = createDefaultUserConfig(),
): SessionRecordingActivityRow[] {
  const liveRecordings = live?.recordings ?? [];
  const rows: SessionRecordingActivityRow[] = [];
  const seenOutputPaths = new Set<string>();
  const sessionStale = live?.stale ?? true;
  const projectionContext: OutputRowProjectionContext = {
    outputMetadataDefaults: session.outputMetadataDefaults,
    workspaceOutputProfilesById,
    userConfig,
  };

  for (const output of session.workspaceOutputs ?? []) {
    const outputRows = recordingsMode === "all"
      ? buildAllRecordingRowsForOutput(
        output,
        liveRecordings,
        sessionStale,
        now,
        projectionContext,
      )
      : buildRecordingRowsForOutput(
        output,
        liveRecordings,
        sessionStale,
        now,
        projectionContext,
      );
    for (const row of outputRows) {
      rows.push(row);
      seenOutputPaths.add(row.outputPath);
    }
  }

  for (const liveRecording of liveRecordings) {
    if (seenOutputPaths.has(liveRecording.outputPath)) {
      continue;
    }
    rows.push({
      key: [
        session.sessionKey,
        liveRecording.outputPath,
        liveRecording.recordingId ?? "active",
      ].join(":"),
      state: resolveEngagedRecordingState({
        startedAt: liveRecording.startedAt,
        lastWriteAt: liveRecording.lastWriteAt,
        sessionStale,
        now,
      }),
      workspaceAlias: liveRecording.workspaceAlias,
      workspaceHref: buildWorkspaceHref(undefined),
      outputPath: liveRecording.outputPath,
      displayOutputPath: liveRecording.outputPath,
      startedAt: liveRecording.startedAt,
      lastWriteAt: liveRecording.lastWriteAt,
      recordingCycleId: liveRecording.recordingId,
    });
  }

  return sortRecordings(rows);
}

export async function resolveWorkspaceFilter(
  selector: string | undefined,
  katoDir: string,
  workspaceEntries?: RegisteredWorkspace[],
): Promise<ResolvedWorkspaceFilter | undefined> {
  const trimmed = selector?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const entries = workspaceEntries ?? await loadRegisteredWorkspaces(katoDir);
    const matched = entries.find((entry) =>
      entry.workspaceId === trimmed || entry.alias === trimmed
    );
    if (matched) {
      return {
        selector: trimmed,
        workspaceId: matched.workspaceId,
        workspaceAlias: matched.alias,
        workspaceDisplayName: matched.displayName,
      };
    }
  } catch {
    // Treat missing or unreadable registry data as unresolved metadata only.
  }

  return {
    selector: trimmed,
    workspaceId: trimmed,
  };
}

export function flattenSessionRecordings(
  rows: SessionActivityRow[],
): RecordingListEntry[] {
  return rows.flatMap((row) =>
    row.recordings.map((recording) => ({
      ...recording,
      provider: row.provider,
      sessionId: row.sessionId,
      sessionShortId: row.sessionShortId,
      snippet: row.snippet,
      sessionState: row.state,
      sessionHref: buildSessionInventorySessionHref(row.sessionId),
      updatedAt: row.updatedAt,
      lastEventAt: row.lastEventAt,
    }))
  ).sort((a, b) => {
    const timeDiff = resolveActivityTimestamp(b) - resolveActivityTimestamp(a);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    const workspaceDiff = (a.workspaceAlias ?? a.workspaceId ?? "")
      .localeCompare(
        b.workspaceAlias ?? b.workspaceId ?? "",
      );
    if (workspaceDiff !== 0) {
      return workspaceDiff;
    }
    return a.displayOutputPath.localeCompare(b.displayOutputPath);
  });
}

function providerSessionKey(
  provider: string,
  providerSessionId: string,
): string {
  return `${provider}\u0000${providerSessionId}`;
}

function resolveParentProviderSessionId(
  metadata: SessionMetadataV1,
): string | undefined {
  if (metadata.parentProviderSessionId) {
    return metadata.parentProviderSessionId;
  }
  if (metadata.provider === "claude") {
    return resolveClaudeSubagentParentProviderSessionId(
      metadata.sourceFilePath,
    );
  }
  return undefined;
}

function resolveSessionRelationships(
  metadataRows: NormalizedPersistedTwinMetadata[],
): Map<string, NonNullable<SessionActivityRow["relationship"]>> {
  const metadataByProviderSession = new Map(
    metadataRows.map(({ metadata }) => [
      providerSessionKey(metadata.provider, metadata.providerSessionId),
      metadata,
    ]),
  );
  const relationships = new Map<
    string,
    NonNullable<SessionActivityRow["relationship"]>
  >();

  for (const { metadata } of metadataRows) {
    const parentProviderSessionId = resolveParentProviderSessionId(metadata);
    if (!parentProviderSessionId) {
      continue;
    }
    const parent = metadataByProviderSession.get(
      providerSessionKey(metadata.provider, parentProviderSessionId),
    );
    relationships.set(metadata.sessionId, {
      kind: "subconversation",
      ...(parent && parent.sessionId !== metadata.sessionId
        ? { parentSessionId: parent.sessionId }
        : {}),
    });
  }

  return relationships;
}

export async function loadSessionActivityRows(
  options: LoadSessionActivityRowsOptions = {},
): Promise<SessionActivityRow[]> {
  const now = options.now ?? (() => new Date());
  const statusPath = options.statusPath ??
    resolveDefaultStatusPath(options.katoDir ?? resolveDefaultKatoDir());
  const katoDir = options.katoDir ?? resolveKatoDirFromStatusPath(statusPath);
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(statusPath, now);
  const sessionStore = new PersistentSessionStateStore({
    katoDir,
    now,
  });
  const workspaceEntriesPromise = options.workspaceEntries
    ? Promise.resolve(options.workspaceEntries)
    : loadRegisteredWorkspaces(katoDir);
  const [snapshot, metadataList, runtimeConfig, workspaceEntries, userConfig] =
    await Promise.all([
      statusStore.load(),
      sessionStore.listSessionMetadata(),
      loadRuntimeConfigOrDefault({ katoDir }),
      workspaceEntriesPromise,
      loadUserConfigOrDefault(katoDir),
    ]);
  const normalizedMetadataRows = await Promise.all(
    metadataList.map((metadata) =>
      normalizePersistedTwinMetadata(sessionStore, metadata)
    ),
  );
  const relationships = resolveSessionRelationships(normalizedMetadataRows);
  const includeSubagents = options.includeSubagents ?? true;
  const visibleMetadataRows = includeSubagents
    ? normalizedMetadataRows
    : normalizedMetadataRows.filter(({ metadata }) =>
      !relationships.has(metadata.sessionId)
    );
  const visibleMetadataList = visibleMetadataRows.map(({ metadata }) =>
    metadata
  );
  const workspaceOutputProfilesById = await resolveWorkspaceOutputProfilesById(
    workspaceEntries,
    visibleMetadataList,
  );

  const liveBySessionId = new Map(
    (snapshot.sessions ?? []).map((session) => [session.sessionId, session]),
  );
  const resolvedWorkspaceFilter = await resolveWorkspaceFilter(
    options.workspaceFilter,
    katoDir,
    workspaceEntries,
  );
  const workspaceDisplayNamesById = new Map(
    workspaceEntries.map((entry) => [entry.workspaceId, entry.displayName]),
  );
  const workspaceDisplayNamesByAlias = new Map(
    workspaceEntries.map((entry) => [entry.alias, entry.displayName]),
  );
  const statusClock = (() => {
    const generatedAtMs = Date.parse(snapshot.generatedAt);
    return Number.isNaN(generatedAtMs) ? now() : new Date(generatedAtMs);
  })();
  const includeStale = options.includeStale ?? true;
  const recordingsMode = options.recordingsMode ?? "latest";

  const candidateRows = await Promise.all(visibleMetadataRows.map((
    { metadata, twinSizeBytes },
  ): SessionActivityRow => {
    const live = liveBySessionId.get(metadata.sessionId);
    const recordings = buildRecordingRows(
      metadata,
      live,
      recordingsMode,
      statusClock,
      workspaceOutputProfilesById,
      userConfig,
    );
    const filteredRecordings = resolvedWorkspaceFilter
      ? recordings.filter((row) =>
        matchesWorkspaceFilter(row, resolvedWorkspaceFilter)
      )
      : recordings;
    const displayRecordings = filteredRecordings.map((recording) => {
      const workspaceDisplayName = resolveWorkspaceDisplayName(
        recording,
        workspaceDisplayNamesById,
        workspaceDisplayNamesByAlias,
      );
      return workspaceDisplayName
        ? {
          ...recording,
          workspaceDisplayName,
        }
        : recording;
    });
    const activeRecordingCount = filteredRecordings.filter((row) =>
      row.state === "engaged-active"
    ).length;
    const staleRecordingCount = filteredRecordings.filter((row) =>
      row.state === "engaged-stale"
    ).length;
    const state = normalizePersistedSessionState(
      metadata,
      deriveSessionGenerationState(
        {
          provider: metadata.provider,
          stale: live?.stale ?? true,
          activeRecordingCount,
          staleRecordingCount,
        },
        runtimeConfig,
      ),
      runtimeConfig,
    );
    return {
      sessionKey: metadata.sessionKey,
      provider: metadata.provider,
      sessionId: metadata.sessionId,
      sessionShortId: deriveSessionShortId(metadata, live),
      providerSessionId: metadata.providerSessionId,
      ...(relationships.has(metadata.sessionId)
        ? { relationship: relationships.get(metadata.sessionId) }
        : {}),
      snippet: live?.snippet,
      updatedAt: live?.updatedAt ?? metadata.updatedAt,
      lastEventAt: live?.lastEventAt,
      ...(twinSizeBytes !== undefined ? { twinSizeBytes } : {}),
      stale: live?.stale ?? true,
      state,
      activeRecordingCount,
      staleRecordingCount,
      stoppedRecordingCount:
        filteredRecordings.filter((row) => row.state === "stopped").length,
      ...(metadata.outputMetadataDefaults
        ? {
          outputMetadataDefaults: structuredClone(
            metadata.outputMetadataDefaults,
          ),
        }
        : {}),
      recordings: displayRecordings,
    };
  }));

  candidateRows.sort((a, b) => {
    const staleDiff = Number(a.stale) - Number(b.stale);
    if (staleDiff !== 0) {
      return staleDiff;
    }
    const recordingDiff = b.activeRecordingCount - a.activeRecordingCount;
    if (recordingDiff !== 0) {
      return recordingDiff;
    }
    const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) {
      return updatedDiff;
    }
    return `${a.provider}:${a.sessionId}`.localeCompare(
      `${b.provider}:${b.sessionId}`,
    );
  });

  const matchesRequestedFilters = (row: SessionActivityRow): boolean =>
    (includeStale || !row.stale) &&
    (!resolvedWorkspaceFilter || row.recordings.length > 0);
  const matchingSessionIds = new Set(
    candidateRows.filter(matchesRequestedFilters).map((row) => row.sessionId),
  );
  const includedSessionIds = new Set(matchingSessionIds);

  if (options.retainSubconversationAncestors && includeSubagents) {
    const rowsBySessionId = new Map(
      candidateRows.map((row) => [row.sessionId, row]),
    );
    for (const sessionId of matchingSessionIds) {
      let current = rowsBySessionId.get(sessionId);
      const visited = new Set([sessionId]);
      while (current?.relationship?.parentSessionId) {
        const parentSessionId = current.relationship.parentSessionId;
        if (visited.has(parentSessionId)) {
          break;
        }
        visited.add(parentSessionId);
        const parent = rowsBySessionId.get(parentSessionId);
        if (!parent) {
          break;
        }
        includedSessionIds.add(parentSessionId);
        current = parent;
      }
    }
  }

  return candidateRows
    .filter((row) => includedSessionIds.has(row.sessionId))
    .map((row) =>
      matchingSessionIds.has(row.sessionId)
        ? row
        : { ...row, structuralContext: true }
    );
}

export async function loadSessionsPageData(
  options: LoadSessionActivityRowsOptions = {},
): Promise<SessionsPageData> {
  const includeStale = options.includeStale ?? true;
  const includeSubagents = options.includeSubagents ?? true;
  const statusPath = options.statusPath ??
    resolveDefaultStatusPath(options.katoDir ?? resolveDefaultKatoDir());
  const katoDir = options.katoDir ?? resolveKatoDirFromStatusPath(statusPath);
  const workspaceEntries = options.workspaceEntries ??
    await loadRegisteredWorkspaces(katoDir);
  const userConfig = await loadUserConfigOrDefault(katoDir);
  const [rows, resolvedWorkspaceFilter] = await Promise.all([
    loadSessionActivityRows({
      ...options,
      includeStale,
      includeSubagents,
      retainSubconversationAncestors: true,
      katoDir,
      statusPath,
      workspaceEntries,
    }),
    resolveWorkspaceFilter(
      options.workspaceFilter,
      katoDir,
      workspaceEntries,
    ),
  ]);
  const workspaceOptions = await resolveWorkspaceOptions(
    workspaceEntries,
    userConfig,
  );

  return {
    includeStale,
    includeSubagents,
    workspaceFilter: resolvedWorkspaceFilter?.selector,
    workspaceFilterId: resolvedWorkspaceFilter?.workspaceId,
    workspaceFilterAlias: resolvedWorkspaceFilter?.workspaceAlias,
    workspaceFilterDisplayName: resolvedWorkspaceFilter?.workspaceDisplayName,
    workspaceOptions,
    sessionCount: rows.filter((row) => !row.structuralContext).length,
    activeSessionCount:
      rows.filter((row) => !row.structuralContext && row.state === "active")
        .length,
    staleSessionCount:
      rows.filter((row) => !row.structuralContext && row.state === "stale")
        .length,
    inactiveSessionCount:
      rows.filter((row) => !row.structuralContext && row.state === "inactive")
        .length,
    activeRecordingCount: rows.filter((row) => !row.structuralContext).reduce(
      (sum, row) => sum + row.activeRecordingCount,
      0,
    ),
    staleRecordingCount: rows.filter((row) => !row.structuralContext).reduce(
      (sum, row) => sum + row.staleRecordingCount,
      0,
    ),
    stoppedRecordingCount: rows.filter((row) => !row.structuralContext).reduce(
      (sum, row) => sum + row.stoppedRecordingCount,
      0,
    ),
    rows,
  };
}
type SessionWorkspaceOutputState = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number];
