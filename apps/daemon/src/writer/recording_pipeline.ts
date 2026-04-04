import type { ConversationEvent } from "@kato/shared";
import type {
  WritePathPolicyDecision,
  WritePathPolicyGateLike,
} from "../policy/mod.ts";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import {
  type ConversationWriterLike,
  MarkdownConversationWriter,
  type MarkdownRenderOptions,
  type MarkdownWriteResult,
} from "./markdown_writer.ts";
import type { JsonlConversationWriter } from "./jsonl_writer.ts";

export type ExportFormat = "markdown" | "jsonl";
export type RecordingRenderOptionOverrides = Pick<
  MarkdownRenderOptions,
  | "includeCommentary"
  | "includeThinking"
  | "includeToolCalls"
  | "includeToolResults"
  | "includeDecisionPrompt"
  | "includeDecisionOptions"
  | "includeDecisionSelection"
  | "italicizeUserMessages"
  | "includeSystemEvents"
  | "headingTimestampTimezone"
  | "markdownLinkStyle"
  | "speakerNames"
>;

export interface RecordingOutputOverrides {
  includeFrontmatter?: boolean;
  includeUpdatedInFrontmatter?: boolean;
  includeSessionIds?: boolean;
  includeWorkspaceIds?: boolean;
  includeRecordingIds?: boolean;
  includeConversationEventKinds?: boolean;
  participantUsername?: string;
  renderOptions?: Partial<RecordingRenderOptionOverrides>;
}

export interface RecordingSummary {
  activeRecordings: number;
  destinations: number;
}

export interface ActiveRecording {
  recordingId: string;
  provider: string;
  sessionId: string;
  workspaceAlias?: string;
  outputPath: string;
  startedAt: string;
  restartedAt?: string;
  lastWriteAt: string;
}

export interface ActivateRecordingInput {
  provider: string;
  sessionId: string;
  recordingKey?: string;
  workspaceAlias?: string;
  targetPath: string;
  seedEvents?: ConversationEvent[];
  title?: string;
  recordingId?: string;
  recordingCycleIds?: string[];
  workspaceIds?: string[];
  outputOverrides?: RecordingOutputOverrides;
}

export interface SnapshotExportInput {
  provider: string;
  sessionId: string;
  targetPath: string;
  events: ConversationEvent[];
  title?: string;
  recordingCycleIds?: string[];
  workspaceIds?: string[];
  format?: ExportFormat;
  outputOverrides?: RecordingOutputOverrides;
}

export interface SnapshotExportResult {
  outputPath: string;
  writeResult: MarkdownWriteResult;
  format: ExportFormat;
}

export interface AppendToActiveRecordingInput {
  provider: string;
  sessionId: string;
  recordingKey?: string;
  events: ConversationEvent[];
  title?: string;
  recordingCycleIds?: string[];
  workspaceIds?: string[];
  outputOverrides?: RecordingOutputOverrides;
}

export interface AppendToDestinationInput {
  provider: string;
  sessionId: string;
  targetPath: string;
  events: ConversationEvent[];
  title?: string;
  recordingId?: string;
  recordingCycleIds?: string[];
  workspaceIds?: string[];
  outputOverrides?: RecordingOutputOverrides;
}

export interface ValidateDestinationPathInput {
  provider: string;
  sessionId: string;
  targetPath: string;
  commandName?: "record" | "capture" | "export";
}

export interface AppendToActiveRecordingResult {
  appended: boolean;
  deduped: boolean;
  recording?: ActiveRecording;
}

export interface RecordingPipelineLike {
  activateRecording(
    input: ActivateRecordingInput,
  ): Promise<ActiveRecording>;
  captureSnapshot(input: SnapshotExportInput): Promise<SnapshotExportResult>;
  exportSnapshot(input: SnapshotExportInput): Promise<SnapshotExportResult>;
  appendToActiveRecording(
    input: AppendToActiveRecordingInput,
  ): Promise<AppendToActiveRecordingResult>;
  appendToDestination?(
    input: AppendToDestinationInput,
  ): Promise<MarkdownWriteResult>;
  validateDestinationPath?(
    input: ValidateDestinationPathInput,
  ): Promise<string>;
  stopRecording(
    provider: string,
    sessionId: string,
    recordingKey?: string,
  ): boolean;
  getActiveRecording(
    provider: string,
    sessionId: string,
    recordingKey?: string,
  ): ActiveRecording | undefined;
  listActiveRecordings(): ActiveRecording[];
  getRecordingSummary(): RecordingSummary;
  getMarkdownFrontmatterSettings?(): {
    includeFrontmatter: boolean;
    includeUpdatedInFrontmatter: boolean;
    includeSessionIds: boolean;
    includeWorkspaceIds: boolean;
    includeRecordingIds: boolean;
    includeConversationEventKinds: boolean;
    participantUsername?: string;
  };
}

export interface RecordingPipelineOptions {
  pathPolicyGate: WritePathPolicyGateLike;
  writer?: ConversationWriterLike;
  jsonlWriter?: JsonlConversationWriter;
  includeFrontmatterInMarkdownRecordings?: boolean;
  includeUpdatedInFrontmatter?: boolean;
  includeSessionIdsInFrontmatter?: boolean;
  includeWorkspaceIdsInFrontmatter?: boolean;
  includeRecordingIdsInFrontmatter?: boolean;
  includeConversationEventKindsInFrontmatter?: boolean;
  frontmatterParticipantUsername?: string;
  defaultRenderOptions?: Pick<
    MarkdownRenderOptions,
    | "includeCommentary"
    | "includeThinking"
    | "includeToolCalls"
    | "includeToolResults"
    | "includeDecisionPrompt"
    | "includeDecisionOptions"
    | "includeDecisionSelection"
    | "italicizeUserMessages"
    | "includeSystemEvents"
  >;
  now?: () => Date;
  makeRecordingId?: () => string;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

interface PathDecisionContext {
  commandName: "record" | "capture" | "export";
  provider: string;
  sessionId: string;
  targetPath: string;
}

function makeNoopOperationalLogger(now: () => Date): StructuredLogger {
  return new StructuredLogger([new NoopSink()], {
    channel: "operational",
    minLevel: "info",
    now,
  });
}

function makeNoopAuditLogger(now: () => Date): AuditLogger {
  return new AuditLogger(
    new StructuredLogger([new NoopSink()], {
      channel: "security-audit",
      minLevel: "info",
      now,
    }),
  );
}

function makeSessionKey(
  provider: string,
  sessionId: string,
  recordingKey?: string,
): string {
  return recordingKey
    ? `${provider}\u0000${sessionId}\u0000${recordingKey}`
    : `${provider}\u0000${sessionId}`;
}

function cloneRecording(recording: ActiveRecording): ActiveRecording {
  return {
    recordingId: recording.recordingId,
    provider: recording.provider,
    sessionId: recording.sessionId,
    ...(recording.workspaceAlias
      ? { workspaceAlias: recording.workspaceAlias }
      : {}),
    outputPath: recording.outputPath,
    startedAt: recording.startedAt,
    lastWriteAt: recording.lastWriteAt,
  };
}

export class RecordingPipeline implements RecordingPipelineLike {
  private readonly now: () => Date;
  private readonly writer: ConversationWriterLike;
  private readonly jsonlWriter: JsonlConversationWriter | undefined;
  private readonly defaultRenderOptions: Pick<
    MarkdownRenderOptions,
    keyof RecordingRenderOptionOverrides
  >;
  private readonly makeRecordingId: () => string;
  private readonly recordings = new Map<string, ActiveRecording>();
  private readonly conversationEventKindChecklistByRecording = new Map<
    string,
    Set<string>
  >();
  private readonly operationalLogger: StructuredLogger;
  private readonly auditLogger: AuditLogger;
  private readonly includeFrontmatterInMarkdownRecordings: boolean;
  private readonly includeUpdatedInFrontmatter: boolean;
  private readonly includeSessionIdsInFrontmatter: boolean;
  private readonly includeWorkspaceIdsInFrontmatter: boolean;
  private readonly includeRecordingIdsInFrontmatter: boolean;
  private readonly includeConversationEventKindsInFrontmatter: boolean;
  private readonly frontmatterParticipantUsername: string | undefined;

  constructor(private readonly options: RecordingPipelineOptions) {
    this.now = options.now ?? (() => new Date());
    this.writer = options.writer ?? new MarkdownConversationWriter();
    this.jsonlWriter = options.jsonlWriter;
    this.defaultRenderOptions = { ...options.defaultRenderOptions };
    this.makeRecordingId = options.makeRecordingId ??
      (() => crypto.randomUUID());
    this.operationalLogger = options.operationalLogger ??
      makeNoopOperationalLogger(this.now);
    this.auditLogger = options.auditLogger ?? makeNoopAuditLogger(this.now);
    this.includeFrontmatterInMarkdownRecordings =
      options.includeFrontmatterInMarkdownRecordings ?? true;
    this.includeUpdatedInFrontmatter = options.includeUpdatedInFrontmatter ??
      false;
    this.includeSessionIdsInFrontmatter =
      options.includeSessionIdsInFrontmatter ?? true;
    this.includeWorkspaceIdsInFrontmatter =
      options.includeWorkspaceIdsInFrontmatter ?? true;
    this.includeRecordingIdsInFrontmatter =
      options.includeRecordingIdsInFrontmatter ?? true;
    this.includeConversationEventKindsInFrontmatter =
      options.includeConversationEventKindsInFrontmatter ?? false;
    this.frontmatterParticipantUsername = options.frontmatterParticipantUsername
      ?.trim() || undefined;
  }

  async activateRecording(
    input: ActivateRecordingInput,
  ): Promise<ActiveRecording> {
    const decision = await this.evaluatePathPolicy({
      commandName: "record",
      provider: input.provider,
      sessionId: input.sessionId,
      targetPath: input.targetPath,
    });
    const outputPath = decision.canonicalTargetPath ?? input.targetPath;
    const nowIso = this.now().toISOString();
    const sessionKey = makeSessionKey(
      input.provider,
      input.sessionId,
      input.recordingKey,
    );
    const normalizedRecordingId = input.recordingId?.trim();
    const recordingId = normalizedRecordingId &&
        normalizedRecordingId.length > 0
      ? normalizedRecordingId
      : this.makeRecordingId();
    const nextRecording: ActiveRecording = {
      recordingId,
      provider: input.provider,
      sessionId: input.sessionId,
      ...(input.workspaceAlias ? { workspaceAlias: input.workspaceAlias } : {}),
      outputPath,
      startedAt: nowIso,
      lastWriteAt: nowIso,
    };
    this.recordings.set(sessionKey, nextRecording);
    this.conversationEventKindChecklistByRecording.set(sessionKey, new Set());

    if ((input.seedEvents?.length ?? 0) > 0) {
      const result = await this.writer.appendEvents(
        outputPath,
        input.seedEvents ?? [],
        this.makeWriterOptions({
          provider: input.provider,
          sessionId: input.sessionId,
          events: input.seedEvents ?? [],
          title: input.title,
          recordingCycleIds: [
            nextRecording.recordingId,
            ...(input.recordingCycleIds ?? []),
          ],
          workspaceIds: input.workspaceIds,
          recordingKey: input.recordingKey,
          trackActiveRecordingKinds: true,
          outputOverrides: input.outputOverrides,
        }),
      );
      if (result.wrote) {
        const updated = this.recordings.get(sessionKey);
        if (updated) {
          updated.lastWriteAt = this.now().toISOString();
        }
      }
    }

    await this.operationalLogger.info(
      "recording.activate",
      "Recording stream activated",
      {
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath,
        recordingId: nextRecording.recordingId,
      },
    );

    return cloneRecording(nextRecording);
  }

  async captureSnapshot(
    input: SnapshotExportInput,
  ): Promise<SnapshotExportResult> {
    const decision = await this.evaluatePathPolicy({
      commandName: "capture",
      provider: input.provider,
      sessionId: input.sessionId,
      targetPath: input.targetPath,
    });
    const outputPath = decision.canonicalTargetPath ?? input.targetPath;
    const format = input.format ?? "markdown";
    const writeResult = await this.writeEventsForExport(
      outputPath,
      input.events,
      {
        ...this.makeWriterOptions({
          provider: input.provider,
          sessionId: input.sessionId,
          events: input.events,
          title: input.title,
          recordingCycleIds: input.recordingCycleIds,
          workspaceIds: input.workspaceIds,
          outputOverrides: input.outputOverrides,
        }),
        requireCreateNew: true,
      },
      format,
    );

    await this.operationalLogger.info(
      "recording.capture",
      "Session snapshot captured",
      {
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath,
        format,
        wrote: writeResult.wrote,
      },
    );

    return { outputPath, writeResult, format };
  }

  async exportSnapshot(
    input: SnapshotExportInput,
  ): Promise<SnapshotExportResult> {
    const decision = await this.evaluatePathPolicy({
      commandName: "export",
      provider: input.provider,
      sessionId: input.sessionId,
      targetPath: input.targetPath,
    });
    const outputPath = decision.canonicalTargetPath ?? input.targetPath;
    const format = input.format ?? "markdown";
    const writeResult = await this.writeEventsForExport(
      outputPath,
      input.events,
      this.makeWriterOptions({
        provider: input.provider,
        sessionId: input.sessionId,
        events: input.events,
        title: input.title,
        recordingCycleIds: input.recordingCycleIds,
        workspaceIds: input.workspaceIds,
        outputOverrides: input.outputOverrides,
      }),
      format,
    );

    await this.operationalLogger.info(
      "recording.export",
      "One-off export completed",
      {
        provider: input.provider,
        sessionId: input.sessionId,
        outputPath,
        format,
        wrote: writeResult.wrote,
      },
    );

    return { outputPath, writeResult, format };
  }

  async appendToActiveRecording(
    input: AppendToActiveRecordingInput,
  ): Promise<AppendToActiveRecordingResult> {
    const sessionKey = makeSessionKey(
      input.provider,
      input.sessionId,
      input.recordingKey,
    );
    const activeRecording = this.recordings.get(sessionKey);
    if (!activeRecording) {
      return { appended: false, deduped: false };
    }

    const writeResult = await this.writer.appendEvents(
      activeRecording.outputPath,
      input.events,
      this.makeWriterOptions({
        provider: input.provider,
        sessionId: input.sessionId,
        events: input.events,
        title: input.title,
        recordingCycleIds: [
          activeRecording.recordingId,
          ...(input.recordingCycleIds ?? []),
        ],
        workspaceIds: input.workspaceIds,
        recordingKey: input.recordingKey,
        trackActiveRecordingKinds: true,
        outputOverrides: input.outputOverrides,
      }),
    );
    if (writeResult.wrote) {
      activeRecording.lastWriteAt = this.now().toISOString();
    }

    return {
      appended: writeResult.wrote,
      deduped: writeResult.deduped,
      recording: cloneRecording(activeRecording),
    };
  }

  async appendToDestination(
    input: AppendToDestinationInput,
  ): Promise<MarkdownWriteResult> {
    const decision = await this.evaluatePathPolicy({
      commandName: "record",
      provider: input.provider,
      sessionId: input.sessionId,
      targetPath: input.targetPath,
    });
    const outputPath = decision.canonicalTargetPath ?? input.targetPath;
    return await this.writer.appendEvents(
      outputPath,
      input.events,
      this.makeWriterOptions({
        provider: input.provider,
        sessionId: input.sessionId,
        events: input.events,
        title: input.title,
        recordingCycleIds: [
          ...(input.recordingId ? [input.recordingId] : []),
          ...(input.recordingCycleIds ?? []),
        ],
        workspaceIds: input.workspaceIds,
        outputOverrides: input.outputOverrides,
      }),
    );
  }

  async validateDestinationPath(
    input: ValidateDestinationPathInput,
  ): Promise<string> {
    const decision = await this.evaluatePathPolicy({
      commandName: input.commandName ?? "record",
      provider: input.provider,
      sessionId: input.sessionId,
      targetPath: input.targetPath,
    });
    return decision.canonicalTargetPath ?? input.targetPath;
  }

  stopRecording(
    provider: string,
    sessionId: string,
    recordingKey?: string,
  ): boolean {
    const sessionKey = makeSessionKey(provider, sessionId, recordingKey);
    this.conversationEventKindChecklistByRecording.delete(sessionKey);
    return this.recordings.delete(sessionKey);
  }

  getActiveRecording(
    provider: string,
    sessionId: string,
    recordingKey?: string,
  ): ActiveRecording | undefined {
    const recording = this.recordings.get(
      makeSessionKey(provider, sessionId, recordingKey),
    );
    return recording ? cloneRecording(recording) : undefined;
  }

  listActiveRecordings(): ActiveRecording[] {
    return Array.from(this.recordings.values()).map(cloneRecording);
  }

  getRecordingSummary(): RecordingSummary {
    const destinations = new Set<string>();
    for (const recording of this.recordings.values()) {
      destinations.add(recording.outputPath);
    }
    return {
      activeRecordings: this.recordings.size,
      destinations: destinations.size,
    };
  }

  getMarkdownFrontmatterSettings(): {
    includeFrontmatter: boolean;
    includeUpdatedInFrontmatter: boolean;
    includeSessionIds: boolean;
    includeWorkspaceIds: boolean;
    includeRecordingIds: boolean;
    includeConversationEventKinds: boolean;
    participantUsername?: string;
  } {
    return {
      includeFrontmatter: this.includeFrontmatterInMarkdownRecordings,
      includeUpdatedInFrontmatter: this.includeUpdatedInFrontmatter,
      includeSessionIds: this.includeSessionIdsInFrontmatter,
      includeWorkspaceIds: this.includeWorkspaceIdsInFrontmatter,
      includeRecordingIds: this.includeRecordingIdsInFrontmatter,
      includeConversationEventKinds:
        this.includeConversationEventKindsInFrontmatter,
      participantUsername: this.frontmatterParticipantUsername,
    };
  }

  private async writeEventsForExport(
    outputPath: string,
    events: ConversationEvent[],
    writerOptions: MarkdownRenderOptions,
    format: ExportFormat,
  ): Promise<MarkdownWriteResult> {
    if (format === "jsonl") {
      if (!this.jsonlWriter) {
        throw new Error(
          "JSONL export requested but jsonlWriter is not configured",
        );
      }
      return await this.jsonlWriter.writeEvents(
        outputPath,
        events,
        {
          mode: "append",
          requireCreateNew: writerOptions.requireCreateNew,
        },
      );
    }
    return await this.writer.appendEvents(outputPath, events, writerOptions);
  }

  private async evaluatePathPolicy(
    context: PathDecisionContext,
  ): Promise<WritePathPolicyDecision> {
    const decision = await this.options.pathPolicyGate.evaluateWritePath(
      context.targetPath,
    );

    await this.auditLogger.policyDecision(
      decision.decision,
      context.targetPath,
      decision.reason,
      {
        command: context.commandName,
        provider: context.provider,
        sessionId: context.sessionId,
        canonicalTargetPath: decision.canonicalTargetPath,
        matchedRoot: decision.matchedRoot,
      },
    );

    if (decision.decision === "deny") {
      await this.operationalLogger.warn(
        "recording.policy.denied",
        "Recording command denied by path policy",
        {
          command: context.commandName,
          provider: context.provider,
          sessionId: context.sessionId,
          targetPath: context.targetPath,
          reason: decision.reason,
          canonicalTargetPath: decision.canonicalTargetPath,
        },
      );
      throw new Error(
        `Path denied by policy for ::${context.commandName}: ${decision.reason} (${context.targetPath})`,
      );
    }

    return decision;
  }

  private makeWriterOptions(options: {
    provider: string;
    sessionId: string;
    events: ConversationEvent[];
    title: string | undefined;
    recordingCycleIds?: string[];
    workspaceIds?: string[];
    recordingKey?: string;
    trackActiveRecordingKinds?: boolean;
    outputOverrides?: RecordingOutputOverrides;
  }): MarkdownRenderOptions {
    const includeConversationEventKinds =
      options.outputOverrides?.includeConversationEventKinds ??
        this.includeConversationEventKindsInFrontmatter;
    const frontmatterConversationEventKinds = this
      .buildFrontmatterConversationEventKinds(
        options.provider,
        options.sessionId,
        options.recordingKey,
        options.events,
        options.trackActiveRecordingKinds ?? false,
        includeConversationEventKinds,
      );
    const frontmatterParticipants = this.buildFrontmatterParticipants(
      options.provider,
      options.events,
      options.outputOverrides?.participantUsername ??
        this.frontmatterParticipantUsername,
    );
    const renderOptions = {
      ...this.defaultRenderOptions,
      ...(options.outputOverrides?.renderOptions ?? {}),
    };
    const frontmatterRecordingCycleIds = this.resolveRecordingCycleIds(
      options.recordingCycleIds,
    );
    const includeFrontmatter = options.outputOverrides?.includeFrontmatter ??
      this.includeFrontmatterInMarkdownRecordings;
    const includeUpdatedInFrontmatter =
      options.outputOverrides?.includeUpdatedInFrontmatter ??
        this.includeUpdatedInFrontmatter;
    const includeSessionIds = options.outputOverrides?.includeSessionIds ??
      this.includeSessionIdsInFrontmatter;
    const includeWorkspaceIds = options.outputOverrides?.includeWorkspaceIds ??
      this.includeWorkspaceIdsInFrontmatter;
    const includeRecordingIds = options.outputOverrides?.includeRecordingIds ??
      this.includeRecordingIdsInFrontmatter;
    return {
      ...renderOptions,
      title: options.title,
      now: this.now,
      includeFrontmatter,
      includeUpdatedInFrontmatter,
      ...(includeSessionIds
        ? { frontmatterSessionIds: [options.sessionId] }
        : {}),
      ...(includeWorkspaceIds && options.workspaceIds
        ? { frontmatterWorkspaceIds: options.workspaceIds }
        : {}),
      ...(includeRecordingIds && frontmatterRecordingCycleIds
        ? { frontmatterRecordingCycleIds }
        : {}),
      ...(frontmatterConversationEventKinds
        ? { frontmatterConversationEventKinds }
        : {}),
      ...(frontmatterParticipants ? { frontmatterParticipants } : {}),
    };
  }

  private resolveRecordingCycleIds(values?: string[]): string[] | undefined {
    if (!values || values.length === 0) {
      return undefined;
    }
    const deduped = new Set<string>();
    for (const value of values) {
      const normalized = value.trim();
      if (normalized.length > 0) {
        deduped.add(normalized);
      }
    }
    const resolved = Array.from(deduped);
    return resolved.length > 0 ? resolved : undefined;
  }

  private buildFrontmatterConversationEventKinds(
    provider: string,
    sessionId: string,
    recordingKey: string | undefined,
    events: ConversationEvent[],
    trackActiveRecordingKinds: boolean,
    includeConversationEventKinds: boolean,
  ): string[] | undefined {
    if (!includeConversationEventKinds) {
      return undefined;
    }
    const eventKinds = trackActiveRecordingKinds
      ? this.getOrCreateConversationEventKindChecklist(
        makeSessionKey(provider, sessionId, recordingKey),
      )
      : new Set<string>();
    for (const event of events) {
      eventKinds.add(event.kind);
    }
    const kinds = Array.from(eventKinds).sort((a, b) => a.localeCompare(b));
    return kinds.length > 0 ? kinds : undefined;
  }

  private getOrCreateConversationEventKindChecklist(sessionKey: string): Set<
    string
  > {
    const checklist = this.conversationEventKindChecklistByRecording.get(
      sessionKey,
    );
    if (checklist) {
      return checklist;
    }
    const nextChecklist = new Set<string>();
    this.conversationEventKindChecklistByRecording.set(
      sessionKey,
      nextChecklist,
    );
    return nextChecklist;
  }

  private buildFrontmatterParticipants(
    provider: string,
    events: ConversationEvent[],
    participantUsername: string | undefined,
  ): string[] | undefined {
    const participants: string[] = [];
    const normalizedParticipantUsername = participantUsername?.trim();
    if (normalizedParticipantUsername) {
      participants.push(normalizedParticipantUsername);
    }

    const assistantParticipants = new Set<string>();
    for (const event of events) {
      if (event.kind !== "message.assistant") {
        continue;
      }
      const eventProvider = event.provider?.trim() || provider;
      const model = event.model?.trim();
      assistantParticipants.add(
        model && model.length > 0
          ? `${eventProvider}.${model}`
          : `${eventProvider}.assistant`,
      );
    }
    participants.push(
      ...Array.from(assistantParticipants).sort((a, b) => a.localeCompare(b)),
    );
    return participants.length > 0 ? participants : undefined;
  }
}
