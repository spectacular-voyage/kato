import type {
  SessionMetadataV1,
  SessionOutputMetadataV1,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
  SessionWorkspaceOutputWriterFeatureFlagOverridesV1,
} from "@kato/shared";
import {
  hasWriterFeatureFlagOverrides,
  resolveEffectiveOutputMetadata,
  resolveEffectiveWriterFeatureFlags,
} from "@kato/shared";
import {
  type AuditLogger,
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
  resolveDefaultWorkspaceRegistryPath,
  type StructuredLogger,
  WorkspaceCatalog,
  WorkspaceProfileResolver,
  WorkspaceRegistryFileStore,
} from "@kato/runtime";
import {
  type FrontmatterWriterPolicy,
  type MarkdownFrontmatterMetadataUpdateStatus,
  updateMarkdownFrontmatterMetadata,
} from "../../daemon/src/writer/mod.ts";
import { readWorkspaceOutputs } from "../../daemon/src/orchestrator/runtime_workspace_output_state.ts";
import { withSessionMutationLock } from "./session_mutation_lock.ts";

export type WriterFlagChoice = "inherit" | "include" | "exclude";

type WorkspaceOutputState = NonNullable<
  SessionMetadataV1["workspaceOutputs"]
>[number];

export interface SessionWorkspaceOutputSelector {
  workspaceId?: string;
  outputPath?: string;
  recordingCycleId?: string;
}

export interface SessionOutputMetadataFieldEdits {
  // `null` clears a field; `undefined` leaves it unchanged. Tags replace the
  // directly stored list (inherited session tags still apply at resolution).
  displayTitle?: string | null;
  tags?: string[];
  personaName?: string | null;
  participantUsername?: string | null;
}

export interface RunSessionOutputMetadataUpdateActionOptions {
  scope: "session-defaults" | "output";
  sessionId: string;
  selector?: SessionWorkspaceOutputSelector;
  edits: SessionOutputMetadataFieldEdits;
  katoDir?: string;
  now?: () => Date;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface RunSessionOutputMetadataUpdateActionResult {
  scope: "session-defaults" | "output";
  sessionId: string;
  sessionShortId: string;
  workspaceId?: string;
  outputPath?: string;
  effectiveMetadata: SessionOutputMetadataV1;
  frontmatterStatuses: Array<{
    outputPath: string;
    status: MarkdownFrontmatterMetadataUpdateStatus;
  }>;
}

export interface RunSessionWriterOverridesActionOptions {
  sessionId: string;
  selector: SessionWorkspaceOutputSelector;
  commentary?: WriterFlagChoice;
  thinking?: WriterFlagChoice;
  katoDir?: string;
  now?: () => Date;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export interface RunSessionWriterOverridesActionResult {
  sessionId: string;
  sessionShortId: string;
  workspaceId: string;
  workspaceAlias?: string;
  outputPath: string;
  overrides?: SessionWorkspaceOutputWriterFeatureFlagOverridesV1;
  defaultWriterFlags: {
    writerIncludeCommentary: boolean;
    writerIncludeThinking: boolean;
  };
  effectiveWriterFlags: {
    writerIncludeCommentary: boolean;
    writerIncludeThinking: boolean;
  };
  frontmatterStatus?: MarkdownFrontmatterMetadataUpdateStatus;
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

export function findWorkspaceOutputForSelector(
  metadata: SessionMetadataV1,
  selector: SessionWorkspaceOutputSelector,
): WorkspaceOutputState {
  const workspaceId = selector.workspaceId?.trim();
  const outputPath = selector.outputPath?.trim();
  const recordingCycleId = selector.recordingCycleId?.trim();
  if (!workspaceId && !outputPath && !recordingCycleId) {
    throw new Error("Workspace output selector is required");
  }
  const outputs = readWorkspaceOutputs(metadata);
  for (let i = outputs.length - 1; i >= 0; i -= 1) {
    const output = outputs[i];
    if (!output) {
      continue;
    }
    if (workspaceId && output.workspaceId !== workspaceId) {
      continue;
    }
    if (outputPath && output.currentResolvedPath !== outputPath) {
      continue;
    }
    if (
      recordingCycleId &&
      output.activeRecordingCycleId !== recordingCycleId &&
      !output.recordingCycles.some((cycle) =>
        cycle.recordingCycleId === recordingCycleId
      )
    ) {
      continue;
    }
    return output;
  }
  throw new Error(
    `Workspace output not found for selector: ${
      [workspaceId, outputPath, recordingCycleId].filter(Boolean).join(", ")
    }`,
  );
}

function normalizeScalarEdit(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTagsEdit(values: string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length > 0) {
      deduped.add(normalized);
    }
  }
  return Array.from(deduped);
}

function applyMetadataEdits(
  current: SessionOutputMetadataV1 | undefined,
  edits: SessionOutputMetadataFieldEdits,
): SessionOutputMetadataV1 | undefined {
  const next: SessionOutputMetadataV1 = {
    ...(current ?? {}),
    ...(current?.tags ? { tags: [...current.tags] } : {}),
  };

  const scalarEdits: Array<
    [keyof SessionOutputMetadataV1 & string, string | null | undefined]
  > = [
    ["displayTitle", normalizeScalarEdit(edits.displayTitle)],
    ["personaName", normalizeScalarEdit(edits.personaName)],
    ["participantUsername", normalizeScalarEdit(edits.participantUsername)],
  ];
  for (const [field, value] of scalarEdits) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete next[field];
    } else {
      (next as Record<string, unknown>)[field] = value;
    }
  }

  const tags = normalizeTagsEdit(edits.tags);
  if (tags !== undefined) {
    if (tags.length > 0) {
      next.tags = tags;
    } else {
      delete next.tags;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

async function resolveWorkspaceDefaultWriterFlags(
  katoDir: string,
  output: WorkspaceOutputState,
): Promise<SessionWorkspaceAttachmentWriterFeatureFlagsV1> {
  try {
    const catalog = new WorkspaceCatalog(
      new WorkspaceRegistryFileStore(
        resolveDefaultWorkspaceRegistryPath(katoDir),
      ),
    );
    const registered = await catalog.getByWorkspaceId(output.workspaceId);
    if (registered) {
      const profile = await new WorkspaceProfileResolver().resolveForCommand(
        registered,
      );
      return { ...profile.writerFeatureFlags };
    }
  } catch {
    // Fall back to the persisted workspace-default snapshot below.
  }
  return { ...output.writerFeatureFlags };
}

function isMarkdownOutputPath(outputPath: string): boolean {
  return /\.md$/i.test(outputPath);
}

async function bestEffortFrontmatterMetadataUpdate(
  outputPath: string,
  update: {
    title?: string;
    tags?: string[];
    writerPolicy?: FrontmatterWriterPolicy;
  },
): Promise<MarkdownFrontmatterMetadataUpdateStatus> {
  try {
    return (await updateMarkdownFrontmatterMetadata(outputPath, update)).status;
  } catch {
    return "missing-file";
  }
}

export async function runSessionOutputMetadataUpdateAction(
  options: RunSessionOutputMetadataUpdateActionOptions,
): Promise<RunSessionOutputMetadataUpdateActionResult> {
  const now = options.now ?? (() => new Date());
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sessionStore = new PersistentSessionStateStore({ katoDir, now });

  const result = await withSessionMutationLock(options.sessionId, async () => {
    const metadata = await resolveSessionMetadata(
      sessionStore,
      options.sessionId,
    );
    const frontmatterStatuses: RunSessionOutputMetadataUpdateActionResult[
      "frontmatterStatuses"
    ] = [];

    if (options.scope === "session-defaults") {
      const nextDefaults = applyMetadataEdits(
        metadata.outputMetadataDefaults,
        options.edits,
      );
      if (nextDefaults) {
        metadata.outputMetadataDefaults = nextDefaults;
      } else {
        delete metadata.outputMetadataDefaults;
      }
      await sessionStore.saveSessionMetadata(metadata, {
        touchUpdatedAt: true,
      });

      if (options.edits.tags !== undefined) {
        for (const output of metadata.workspaceOutputs ?? []) {
          if (!isMarkdownOutputPath(output.currentResolvedPath)) {
            continue;
          }
          const effective = resolveEffectiveOutputMetadata(
            metadata.outputMetadataDefaults,
            output.outputMetadata,
          );
          if (!effective.tags || effective.tags.length === 0) {
            continue;
          }
          frontmatterStatuses.push({
            outputPath: output.currentResolvedPath,
            status: await bestEffortFrontmatterMetadataUpdate(
              output.currentResolvedPath,
              { tags: effective.tags },
            ),
          });
        }
      }

      return {
        scope: options.scope,
        sessionId: metadata.sessionId,
        sessionShortId: metadata.sessionId.slice(0, 8),
        effectiveMetadata: resolveEffectiveOutputMetadata(
          metadata.outputMetadataDefaults,
          undefined,
        ),
        frontmatterStatuses,
      };
    }

    const output = findWorkspaceOutputForSelector(
      metadata,
      options.selector ?? {},
    );
    const nextOutputMetadata = applyMetadataEdits(
      output.outputMetadata,
      options.edits,
    );
    if (nextOutputMetadata) {
      output.outputMetadata = nextOutputMetadata;
    } else {
      delete output.outputMetadata;
    }
    await sessionStore.saveSessionMetadata(metadata, {
      touchUpdatedAt: true,
    });

    const effectiveMetadata = resolveEffectiveOutputMetadata(
      metadata.outputMetadataDefaults,
      output.outputMetadata,
    );
    if (
      isMarkdownOutputPath(output.currentResolvedPath) &&
      (options.edits.displayTitle !== undefined ||
        options.edits.tags !== undefined)
    ) {
      frontmatterStatuses.push({
        outputPath: output.currentResolvedPath,
        status: await bestEffortFrontmatterMetadataUpdate(
          output.currentResolvedPath,
          {
            ...(options.edits.displayTitle !== undefined &&
                effectiveMetadata.displayTitle
              ? { title: effectiveMetadata.displayTitle }
              : {}),
            ...(options.edits.tags !== undefined && effectiveMetadata.tags
              ? { tags: effectiveMetadata.tags }
              : {}),
          },
        ),
      });
    }

    return {
      scope: options.scope,
      sessionId: metadata.sessionId,
      sessionShortId: metadata.sessionId.slice(0, 8),
      workspaceId: output.workspaceId,
      outputPath: output.currentResolvedPath,
      effectiveMetadata,
      frontmatterStatuses,
    };
  });

  const logAttributes = {
    scope: result.scope,
    sessionId: result.sessionId,
    sessionShortId: result.sessionShortId,
    ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}),
    ...(result.outputPath ? { outputPath: result.outputPath } : {}),
    frontmatterStatuses: result.frontmatterStatuses,
  };
  await options.operationalLogger?.info(
    "web.sessions.output-metadata.updated",
    "Session output metadata updated",
    logAttributes,
  );
  await options.auditLogger?.record(
    "web.sessions.output-metadata.updated",
    "Session output metadata updated",
    logAttributes,
  );

  return result;
}

function applyWriterFlagChoice(
  overrides: SessionWorkspaceOutputWriterFeatureFlagOverridesV1,
  flag: keyof SessionWorkspaceOutputWriterFeatureFlagOverridesV1,
  choice: WriterFlagChoice | undefined,
): void {
  if (choice === undefined) {
    return;
  }
  if (choice === "inherit") {
    delete overrides[flag];
    return;
  }
  overrides[flag] = choice === "include";
}

export async function runSessionWriterOverridesAction(
  options: RunSessionWriterOverridesActionOptions,
): Promise<RunSessionWriterOverridesActionResult> {
  const now = options.now ?? (() => new Date());
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sessionStore = new PersistentSessionStateStore({ katoDir, now });

  const result = await withSessionMutationLock(options.sessionId, async () => {
    const metadata = await resolveSessionMetadata(
      sessionStore,
      options.sessionId,
    );
    const output = findWorkspaceOutputForSelector(metadata, options.selector);

    const overrides: SessionWorkspaceOutputWriterFeatureFlagOverridesV1 = {
      ...(output.writerFeatureFlagOverrides ?? {}),
    };
    applyWriterFlagChoice(
      overrides,
      "writerIncludeCommentary",
      options.commentary,
    );
    applyWriterFlagChoice(overrides, "writerIncludeThinking", options.thinking);
    if (hasWriterFeatureFlagOverrides(overrides)) {
      output.writerFeatureFlagOverrides = overrides;
    } else {
      delete output.writerFeatureFlagOverrides;
    }
    await sessionStore.saveSessionMetadata(metadata, {
      touchUpdatedAt: true,
    });

    const defaultWriterFlags = await resolveWorkspaceDefaultWriterFlags(
      katoDir,
      output,
    );
    const effectiveWriterFlags = resolveEffectiveWriterFeatureFlags(
      defaultWriterFlags,
      output.writerFeatureFlagOverrides,
    );

    let frontmatterStatus:
      | MarkdownFrontmatterMetadataUpdateStatus
      | undefined;
    if (isMarkdownOutputPath(output.currentResolvedPath)) {
      frontmatterStatus = await bestEffortFrontmatterMetadataUpdate(
        output.currentResolvedPath,
        {
          writerPolicy: {
            writerIncludeCommentary:
              effectiveWriterFlags.writerIncludeCommentary,
            writerIncludeThinking: effectiveWriterFlags.writerIncludeThinking,
          },
        },
      );
    }

    return {
      sessionId: metadata.sessionId,
      sessionShortId: metadata.sessionId.slice(0, 8),
      workspaceId: output.workspaceId,
      ...(output.workspaceAliasSnapshot
        ? { workspaceAlias: output.workspaceAliasSnapshot }
        : {}),
      outputPath: output.currentResolvedPath,
      ...(output.writerFeatureFlagOverrides
        ? { overrides: { ...output.writerFeatureFlagOverrides } }
        : {}),
      defaultWriterFlags: {
        writerIncludeCommentary: defaultWriterFlags.writerIncludeCommentary,
        writerIncludeThinking: defaultWriterFlags.writerIncludeThinking,
      },
      effectiveWriterFlags: {
        writerIncludeCommentary: effectiveWriterFlags.writerIncludeCommentary,
        writerIncludeThinking: effectiveWriterFlags.writerIncludeThinking,
      },
      ...(frontmatterStatus ? { frontmatterStatus } : {}),
    };
  });

  const logAttributes = {
    sessionId: result.sessionId,
    sessionShortId: result.sessionShortId,
    workspaceId: result.workspaceId,
    ...(result.workspaceAlias ? { workspaceAlias: result.workspaceAlias } : {}),
    outputPath: result.outputPath,
    overrides: result.overrides ?? {},
    effectiveWriterFlags: result.effectiveWriterFlags,
    ...(result.frontmatterStatus
      ? { frontmatterStatus: result.frontmatterStatus }
      : {}),
  };
  await options.operationalLogger?.info(
    "web.sessions.writer-overrides.updated",
    "Session output writer overrides updated",
    logAttributes,
  );
  await options.auditLogger?.record(
    "web.sessions.writer-overrides.updated",
    "Session output writer overrides updated",
    logAttributes,
  );

  return result;
}
