import {
  type ConversationEvent,
  extractSnippet,
  type MarkdownFrontmatterConfig,
  type SessionMetadataV1,
  type UserConfig,
} from "@kato/shared";
import {
  type AuditLogger,
  createDefaultSharedBehaviorConfig,
  createDefaultUserConfig,
  loadPersistedSessionHistoryEvents,
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
  resolveDefaultSharedConfigPath,
  resolveDefaultUserConfigPath,
  resolveDefaultWorkspaceRegistryPath,
  type ResolvedWorkspaceProfile,
  resolveFrontmatterParticipantUsername,
  SharedBehaviorConfigFileStore,
  type StructuredLogger,
  UserConfigFileStore,
  WorkspaceCatalog,
  WorkspaceProfileResolver,
  WorkspaceRegistryFileStore,
  WritePathPolicyGate,
} from "@kato/runtime";
import {
  applyWorkspaceProfileSnapshot,
  closeWorkspaceOutputCycle,
  createWorkspaceOutputState,
  openWorkspaceOutputCycle,
  readWorkspaceOutputs,
  stopAllWorkspaceOutputs,
  toWorkspaceDestinationBinding,
} from "../../daemon/src/orchestrator/runtime_workspace_output_state.ts";
import {
  resolveUniqueNonExistingPath,
  resolveWorkspaceCommandDestination,
  validateDestinationPathForCommand,
} from "../../daemon/src/orchestrator/runtime_command_destination.ts";
import { resolveWorkspaceDefaultOutputDir } from "../../daemon/src/orchestrator/runtime_workspace_paths.ts";
import {
  type RecordingOutputOverrides,
  RecordingPipeline,
} from "../../daemon/src/writer/mod.ts";
import { resolvePreferredParticipantUsername } from "../../runtime/src/config/participant_username.ts";

const UNKNOWN_OUTPUT_USERNAME = "unknown-user";
const CAPTURE_DESTINATION_CONFLICT_MAX_RETRIES = 5;
const CAPTURE_DESTINATION_CONFLICT_BACKOFF_MS = 25;

export type SessionRecordingWebAction = "new-recording" | "new-capture";
export type SessionRecordingStopWebAction =
  | "stop-recording"
  | "stop-all-recordings";

export interface RunSessionRecordingActionOptions {
  action: SessionRecordingWebAction;
  sessionId: string;
  workspaceSelector: string;
  katoDir?: string;
  now?: () => Date;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface RunSessionRecordingActionResult {
  action: SessionRecordingWebAction;
  mode: "record" | "capture";
  noOp: boolean;
  sessionId: string;
  sessionShortId: string;
  provider: string;
  providerSessionId: string;
  workspaceId: string;
  workspaceAlias: string;
  targetPath: string;
  writeCursor: number;
  source: "twin" | "source";
}

export interface RunSessionRecordingStopActionOptions {
  action: SessionRecordingStopWebAction;
  sessionId: string;
  workspaceId?: string;
  recordingCycleId?: string;
  outputPath?: string;
  katoDir?: string;
  now?: () => Date;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface RunSessionRecordingStopActionResult {
  action: SessionRecordingStopWebAction;
  noOp: boolean;
  sessionId: string;
  sessionShortId: string;
  provider: string;
  providerSessionId: string;
  writeCursor: number;
  stoppedCount: number;
  stoppedWorkspaceIds: string[];
  stoppedWorkspaceAliases: string[];
  workspaceId?: string;
  recordingCycleId?: string;
  outputPath?: string;
  source: "twin" | "source";
}

function resolveConversationTitle(
  events: ConversationEvent[],
  fallback: string,
): string {
  const snippet = extractSnippet(events);
  if (snippet && snippet.trim().length > 0) {
    return snippet;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertCaptureDestinationDoesNotExist(
  targetPath: string,
): Promise<void> {
  try {
    await Deno.stat(targetPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
  throw new Deno.errors.AlreadyExists(
    `Capture destination already exists: ${targetPath}`,
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  if (error instanceof Deno.errors.AlreadyExists) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  if (candidate.code === "EEXIST" || candidate.name === "AlreadyExists") {
    return true;
  }
  return typeof candidate.message === "string" &&
    /^Capture destination already exists:/.test(candidate.message);
}

async function captureSnapshotWithRetries(options: {
  recordingPipeline: RecordingPipeline;
  provider: string;
  sessionId: string;
  targetPath: string;
  title: string;
  workspaceId: string;
  outputOverrides: RecordingOutputOverrides;
  allowGeneratedDestinationRetries: boolean;
  resolveCycleIdForAttempt: (targetPath: string) => string;
  events: ConversationEvent[];
}): Promise<{ targetPath: string; captureCycleId: string }> {
  let targetPath = options.targetPath;
  let captureConflictRetries = 0;
  while (true) {
    const cycleIdForAttempt = options.resolveCycleIdForAttempt(targetPath);
    try {
      await assertCaptureDestinationDoesNotExist(targetPath);
      await options.recordingPipeline.captureSnapshot({
        provider: options.provider,
        sessionId: options.sessionId,
        targetPath,
        events: options.events,
        title: options.title,
        recordingCycleIds: [cycleIdForAttempt],
        workspaceIds: [options.workspaceId],
        outputOverrides: options.outputOverrides,
      });
      return {
        targetPath,
        captureCycleId: cycleIdForAttempt,
      };
    } catch (error) {
      if (
        !options.allowGeneratedDestinationRetries ||
        !isAlreadyExistsError(error)
      ) {
        throw error;
      }
      captureConflictRetries += 1;
      if (captureConflictRetries > CAPTURE_DESTINATION_CONFLICT_MAX_RETRIES) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        throw new Error(
          `Capture destination conflict retries exceeded (${CAPTURE_DESTINATION_CONFLICT_MAX_RETRIES}) for ${targetPath}: ${errorMessage}`,
        );
      }
      if (CAPTURE_DESTINATION_CONFLICT_BACKOFF_MS > 0) {
        await sleep(CAPTURE_DESTINATION_CONFLICT_BACKOFF_MS);
      }
      const nextTargetPath = await resolveUniqueNonExistingPath(targetPath);
      targetPath = await validateDestinationPathForCommand(
        options.recordingPipeline,
        options.provider,
        options.sessionId,
        nextTargetPath,
        "capture",
      );
    }
  }
}

function createOutputOverrides(options: {
  workspaceId: string;
  markdownFrontmatter: MarkdownFrontmatterConfig;
  writerFeatureFlags: ResolvedWorkspaceProfile["writerFeatureFlags"];
  workspaceTimezone: string;
  preferredUsername?: string;
  userConfig: UserConfig;
}): RecordingOutputOverrides {
  return {
    includeFrontmatter:
      options.markdownFrontmatter.includeFrontmatterInMarkdownRecordings,
    includeUpdatedInFrontmatter:
      options.markdownFrontmatter.includeUpdatedInFrontmatter,
    includeSessionIds: options.markdownFrontmatter.includeSessionIds,
    includeWorkspaceIds: options.markdownFrontmatter.includeWorkspaceIds,
    includeRecordingIds: options.markdownFrontmatter.includeRecordingIds,
    includeConversationEventKinds:
      options.markdownFrontmatter.includeConversationEventKinds,
    participantUsername: resolveFrontmatterParticipantUsername({
      markdownFrontmatter: options.markdownFrontmatter,
      userConfig: options.userConfig,
      workspaceId: options.workspaceId,
    }),
    renderOptions: {
      includeCommentary: options.writerFeatureFlags.writerIncludeCommentary,
      includeThinking: options.writerFeatureFlags.writerIncludeThinking,
      includeToolCalls: options.writerFeatureFlags.writerIncludeToolCalls,
      includeToolResults: options.writerFeatureFlags.writerIncludeToolResults ??
        false,
      includeDecisionPrompt:
        options.writerFeatureFlags.writerIncludeDecisionPrompt ?? true,
      includeDecisionOptions:
        options.writerFeatureFlags.writerIncludeDecisionOptions ?? true,
      includeDecisionSelection:
        options.writerFeatureFlags.writerIncludeDecisionSelection ?? true,
      italicizeUserMessages:
        options.writerFeatureFlags.writerItalicizeUserMessages,
      includeSystemEvents: false,
      headingTimestampTimezone: options.workspaceTimezone,
      ...(options.markdownFrontmatter.addParticipantUsernameToHeadings &&
          options.preferredUsername
        ? {
          speakerNames: { user: options.preferredUsername },
        }
        : {}),
    },
  };
}

function createOutputOverridesFromWorkspaceProfile(
  profile: ResolvedWorkspaceProfile,
  userConfig: UserConfig,
): RecordingOutputOverrides {
  const preferredUsername = resolvePreferredParticipantUsername({
    userConfig,
    workspaceId: profile.workspaceId,
  });
  return createOutputOverrides({
    workspaceId: profile.workspaceId,
    markdownFrontmatter: profile.markdownFrontmatter,
    writerFeatureFlags: profile.writerFeatureFlags,
    workspaceTimezone: profile.workspaceTimezone,
    preferredUsername,
    userConfig,
  });
}

async function resolveSessionMetadata(
  sessionStore: PersistentSessionStateStore,
  sessionId: string,
): Promise<SessionMetadataV1> {
  const metadata = (await sessionStore.listSessionMetadata()).find((entry) =>
    entry.sessionId === sessionId
  );
  if (!metadata) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return metadata;
}

async function resolveWorkspaceForSelector(
  katoDir: string,
  selector: string,
) {
  const trimmed = selector.trim();
  if (!trimmed) {
    throw new Error("Workspace selector is required");
  }
  const catalog = new WorkspaceCatalog(
    new WorkspaceRegistryFileStore(
      resolveDefaultWorkspaceRegistryPath(katoDir),
    ),
  );
  const byWorkspaceId = await catalog.getByWorkspaceId(trimmed);
  if (byWorkspaceId) {
    return byWorkspaceId;
  }
  const byAlias = await catalog.getByAlias(trimmed);
  if (byAlias) {
    return byAlias;
  }
  throw new Error(`Workspace not found: ${trimmed}`);
}

function resolveWorkspaceAliasForOutput(output: {
  workspaceId: string;
  workspaceAliasSnapshot?: string;
}): string {
  return output.workspaceAliasSnapshot ?? output.workspaceId;
}

function findActiveWorkspaceOutputForStop(
  metadata: SessionMetadataV1,
  options: {
    workspaceId?: string;
    recordingCycleId?: string;
    outputPath?: string;
  },
) {
  const workspaceId = options.workspaceId?.trim();
  const recordingCycleId = options.recordingCycleId?.trim();
  const outputPath = options.outputPath?.trim();
  for (let i = readWorkspaceOutputs(metadata).length - 1; i >= 0; i -= 1) {
    const output = readWorkspaceOutputs(metadata)[i];
    if (!output || output.desiredState !== "on") {
      continue;
    }
    if (workspaceId && output.workspaceId !== workspaceId) {
      continue;
    }
    if (
      recordingCycleId && output.activeRecordingCycleId !== recordingCycleId
    ) {
      continue;
    }
    if (outputPath && output.currentResolvedPath !== outputPath) {
      continue;
    }
    return output;
  }
  return undefined;
}

export async function runSessionRecordingStopAction(
  options: RunSessionRecordingStopActionOptions,
): Promise<RunSessionRecordingStopActionResult> {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sessionStore = new PersistentSessionStateStore({ katoDir, now });
  const metadata = await resolveSessionMetadata(
    sessionStore,
    options.sessionId,
  );
  const history = await loadPersistedSessionHistoryEvents(
    metadata,
    sessionStore,
  );
  const writeCursor = history.events.length;

  let stoppedCount = 0;
  let stoppedWorkspaceIds: string[] = [];
  let stoppedWorkspaceAliases: string[] = [];

  if (options.action === "stop-all-recordings") {
    const activeOutputs = readWorkspaceOutputs(metadata).filter((output) =>
      output.desiredState === "on"
    );
    stoppedWorkspaceIds = activeOutputs.map((output) => output.workspaceId);
    stoppedWorkspaceAliases = activeOutputs.map(resolveWorkspaceAliasForOutput);
    stoppedCount =
      stopAllWorkspaceOutputs(metadata, writeCursor, nowIso).length;
  } else {
    const output = findActiveWorkspaceOutputForStop(metadata, {
      workspaceId: options.workspaceId,
      recordingCycleId: options.recordingCycleId,
      outputPath: options.outputPath,
    });
    if (output && closeWorkspaceOutputCycle(output, writeCursor, nowIso)) {
      stoppedCount = 1;
      stoppedWorkspaceIds = [output.workspaceId];
      stoppedWorkspaceAliases = [resolveWorkspaceAliasForOutput(output)];
    }
  }

  if (stoppedCount > 0) {
    await sessionStore.saveSessionMetadata(metadata, {
      touchUpdatedAt: true,
    });
  }

  const result: RunSessionRecordingStopActionResult = {
    action: options.action,
    noOp: stoppedCount === 0,
    sessionId: metadata.sessionId,
    sessionShortId: metadata.sessionId.slice(0, 8),
    provider: metadata.provider,
    providerSessionId: metadata.providerSessionId,
    writeCursor,
    stoppedCount,
    stoppedWorkspaceIds,
    stoppedWorkspaceAliases,
    ...(options.workspaceId?.trim()
      ? { workspaceId: options.workspaceId.trim() }
      : {}),
    ...(options.recordingCycleId?.trim()
      ? { recordingCycleId: options.recordingCycleId.trim() }
      : {}),
    ...(options.outputPath?.trim()
      ? { outputPath: options.outputPath.trim() }
      : {}),
    source: history.source,
  };

  const logAttributes = {
    action: result.action,
    noOp: result.noOp,
    sessionId: result.sessionId,
    sessionShortId: result.sessionShortId,
    provider: result.provider,
    providerSessionId: result.providerSessionId,
    writeCursor: result.writeCursor,
    stoppedCount: result.stoppedCount,
    stoppedWorkspaceIds: result.stoppedWorkspaceIds,
    stoppedWorkspaceAliases: result.stoppedWorkspaceAliases,
    ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
    ...(result.recordingCycleId
      ? { recordingCycleId: result.recordingCycleId }
      : {}),
    ...(result.outputPath ? { outputPath: result.outputPath } : {}),
    source: result.source,
  };
  await options.operationalLogger?.info(
    "web.sessions.recording.stop.completed",
    "Session recording stop action completed",
    logAttributes,
  );
  await options.auditLogger?.record(
    "web.sessions.recording.stop.completed",
    "Session recording stop action completed",
    logAttributes,
  );

  return result;
}

export async function runSessionRecordingAction(
  options: RunSessionRecordingActionOptions,
): Promise<RunSessionRecordingActionResult> {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sessionStore = new PersistentSessionStateStore({ katoDir, now });
  const metadata = await resolveSessionMetadata(
    sessionStore,
    options.sessionId,
  );
  const workspace = await resolveWorkspaceForSelector(
    katoDir,
    options.workspaceSelector,
  );
  const workspaceProfileResolver = new WorkspaceProfileResolver();
  const profile = await workspaceProfileResolver.resolveForCommand(workspace);
  const history = await loadPersistedSessionHistoryEvents(
    metadata,
    sessionStore,
  );
  const writeCursor = history.events.length;
  const sharedConfigStore = new SharedBehaviorConfigFileStore(
    resolveDefaultSharedConfigPath(katoDir),
  );
  const sharedConfig = (await sharedConfigStore.ensureInitialized(
    createDefaultSharedBehaviorConfig({ allowedWriteRoots: [] }),
  )).config;
  const userConfigStore = new UserConfigFileStore(
    resolveDefaultUserConfigPath(katoDir),
  );
  const userConfig = (await userConfigStore.ensureInitialized(
    createDefaultUserConfig(),
  )).config;
  const recordingPipeline = new RecordingPipeline({
    pathPolicyGate: new WritePathPolicyGate({
      allowedRoots: sharedConfig.allowedWriteRoots,
    }),
    now,
    ...(options.operationalLogger
      ? { operationalLogger: options.operationalLogger }
      : {}),
    ...(options.auditLogger ? { auditLogger: options.auditLogger } : {}),
  });
  const outputOverrides = createOutputOverridesFromWorkspaceProfile(
    profile,
    userConfig,
  );
  const outputUsername = resolvePreferredParticipantUsername({
    userConfig,
    workspaceId: workspace.workspaceId,
  }) ?? UNKNOWN_OUTPUT_USERNAME;
  const resolvedDefaultOutputDir = resolveWorkspaceDefaultOutputDir({
    profile,
    provider: metadata.provider,
    sessionId: metadata.providerSessionId,
    now: now(),
    outputUsername,
    boundarySnapshot: history.events,
  });
  const title = resolveConversationTitle(
    history.events,
    metadata.providerSessionId,
  );
  const outputs = readWorkspaceOutputs(metadata);
  const matchingOutputs = outputs.filter((entry) =>
    entry.workspaceId === workspace.workspaceId
  );
  let targetPath: string;
  let noOp = false;

  if (options.action === "new-recording") {
    const resolved = await resolveWorkspaceCommandDestination({
      profile,
      provider: metadata.provider,
      sessionId: metadata.providerSessionId,
      outputUsername,
      boundarySnapshot: history.events,
      ensureGeneratedPathUnique: true,
      now: now(),
    });
    targetPath = await validateDestinationPathForCommand(
      recordingPipeline,
      metadata.provider,
      metadata.providerSessionId,
      resolved.resolvedPath,
      "record",
    );
    for (const output of matchingOutputs) {
      if (output.desiredState === "on") {
        closeWorkspaceOutputCycle(output, writeCursor, nowIso);
      }
    }
    const output = createWorkspaceOutputState({
      profile,
      binding: toWorkspaceDestinationBinding(profile, targetPath),
      resolvedPath: targetPath,
      resolvedDefaultOutputDir: resolved.resolvedDefaultOutputDir,
      desiredState: "off",
      writeCursor,
      nowIso,
    });
    applyWorkspaceProfileSnapshot(output, profile, resolvedDefaultOutputDir);
    const recordingCycleId = openWorkspaceOutputCycle(
      output,
      writeCursor,
      nowIso,
    );
    await recordingPipeline.appendToDestination({
      provider: metadata.provider,
      sessionId: metadata.providerSessionId,
      targetPath,
      events: [],
      title,
      recordingId: recordingCycleId,
      workspaceIds: [workspace.workspaceId],
      outputOverrides,
    });
    output.writeCursor = writeCursor;
    outputs.push(output);
    await sessionStore.saveSessionMetadata(metadata, {
      touchUpdatedAt: true,
    });
  } else {
    const resolved = await resolveWorkspaceCommandDestination({
      profile,
      provider: metadata.provider,
      sessionId: metadata.providerSessionId,
      outputUsername,
      boundarySnapshot: history.events,
      ensureGeneratedPathUnique: true,
      now: now(),
    });
    targetPath = await validateDestinationPathForCommand(
      recordingPipeline,
      metadata.provider,
      metadata.providerSessionId,
      resolved.resolvedPath,
      "capture",
    );
    const captureResult = await captureSnapshotWithRetries({
      recordingPipeline,
      provider: metadata.provider,
      sessionId: metadata.providerSessionId,
      targetPath,
      title,
      workspaceId: workspace.workspaceId,
      outputOverrides,
      allowGeneratedDestinationRetries: resolved.usesGeneratedFilename,
      resolveCycleIdForAttempt: () => crypto.randomUUID(),
      events: history.events,
    });
    targetPath = captureResult.targetPath;
    const captureCycleId = captureResult.captureCycleId;
    for (const output of matchingOutputs) {
      if (output.desiredState === "on") {
        closeWorkspaceOutputCycle(output, writeCursor, nowIso);
      }
    }
    const output = createWorkspaceOutputState({
      profile,
      binding: toWorkspaceDestinationBinding(profile, targetPath),
      resolvedPath: targetPath,
      resolvedDefaultOutputDir: resolved.resolvedDefaultOutputDir,
      desiredState: "off",
      writeCursor,
      nowIso,
    });
    applyWorkspaceProfileSnapshot(
      output,
      profile,
      resolved.resolvedDefaultOutputDir,
    );
    openWorkspaceOutputCycle(
      output,
      writeCursor,
      nowIso,
      captureCycleId,
    );
    output.writeCursor = writeCursor;
    outputs.push(output);
    await sessionStore.saveSessionMetadata(metadata, { touchUpdatedAt: true });
  }

  const result: RunSessionRecordingActionResult = {
    action: options.action,
    mode: options.action === "new-recording" ? "record" : "capture",
    noOp,
    sessionId: metadata.sessionId,
    sessionShortId: metadata.sessionId.slice(0, 8),
    provider: metadata.provider,
    providerSessionId: metadata.providerSessionId,
    workspaceId: workspace.workspaceId,
    workspaceAlias: workspace.alias,
    targetPath,
    writeCursor,
    source: history.source,
  };

  const logAttributes = {
    action: result.action,
    mode: result.mode,
    noOp: result.noOp,
    sessionId: result.sessionId,
    sessionShortId: result.sessionShortId,
    provider: result.provider,
    providerSessionId: result.providerSessionId,
    workspaceId: result.workspaceId,
    workspaceAlias: result.workspaceAlias,
    targetPath: result.targetPath,
    writeCursor: result.writeCursor,
    source: result.source,
  };
  await options.operationalLogger?.info(
    "web.sessions.recording.mutation.completed",
    "Session recording action completed",
    logAttributes,
  );
  await options.auditLogger?.record(
    "web.sessions.recording.mutation.completed",
    "Session recording action completed",
    logAttributes,
  );

  return result;
}
