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

export interface RecordingSummary {
  activeRecordings: number;
  destinations: number;
}

export interface ActiveRecording {
  recordingId: string;
  provider: string;
  sessionId: string;
  outputPath: string;
  startedAt: string;
  lastWriteAt: string;
}

export interface StartOrRotateRecordingInput {
  provider: string;
  sessionId: string;
  targetPath: string;
  seedEvents?: ConversationEvent[];
  title?: string;
}

export interface SnapshotExportInput {
  provider: string;
  sessionId: string;
  targetPath: string;
  events: ConversationEvent[];
  title?: string;
  format?: ExportFormat;
}

export interface SnapshotExportResult {
  outputPath: string;
  writeResult: MarkdownWriteResult;
  format: ExportFormat;
}

export interface AppendToActiveRecordingInput {
  provider: string;
  sessionId: string;
  events: ConversationEvent[];
  title?: string;
}

export interface AppendToDestinationInput {
  provider: string;
  sessionId: string;
  targetPath: string;
  events: ConversationEvent[];
  title?: string;
}

export interface AppendToActiveRecordingResult {
  appended: boolean;
  deduped: boolean;
  recording?: ActiveRecording;
}

export interface RecordingPipelineLike {
  startOrRotateRecording(
    input: StartOrRotateRecordingInput,
  ): Promise<ActiveRecording>;
  captureSnapshot(input: SnapshotExportInput): Promise<SnapshotExportResult>;
  exportSnapshot(input: SnapshotExportInput): Promise<SnapshotExportResult>;
  appendToActiveRecording(
    input: AppendToActiveRecordingInput,
  ): Promise<AppendToActiveRecordingResult>;
  appendToDestination?(
    input: AppendToDestinationInput,
  ): Promise<MarkdownWriteResult>;
  stopRecording(provider: string, sessionId: string): boolean;
  getActiveRecording(
    provider: string,
    sessionId: string,
  ): ActiveRecording | undefined;
  listActiveRecordings(): ActiveRecording[];
  getRecordingSummary(): RecordingSummary;
}

export interface RecordingPipelineOptions {
  pathPolicyGate: WritePathPolicyGateLike;
  writer?: ConversationWriterLike;
  jsonlWriter?: JsonlConversationWriter;
  defaultRenderOptions?: Pick<
    MarkdownRenderOptions,
    | "includeCommentary"
    | "includeThinking"
    | "includeToolCalls"
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

function makeSessionKey(provider: string, sessionId: string): string {
  return `${provider}\u0000${sessionId}`;
}

function cloneRecording(recording: ActiveRecording): ActiveRecording {
  return {
    recordingId: recording.recordingId,
    provider: recording.provider,
    sessionId: recording.sessionId,
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
    | "includeCommentary"
    | "includeThinking"
    | "includeToolCalls"
    | "italicizeUserMessages"
    | "includeSystemEvents"
  >;
  private readonly makeRecordingId: () => string;
  private readonly recordings = new Map<string, ActiveRecording>();
  private readonly operationalLogger: StructuredLogger;
  private readonly auditLogger: AuditLogger;

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
  }

  async startOrRotateRecording(
    input: StartOrRotateRecordingInput,
  ): Promise<ActiveRecording> {
    const decision = await this.evaluatePathPolicy({
      commandName: "record",
      provider: input.provider,
      sessionId: input.sessionId,
      targetPath: input.targetPath,
    });
    const outputPath = decision.canonicalTargetPath ?? input.targetPath;
    const nowIso = this.now().toISOString();
    const sessionKey = makeSessionKey(input.provider, input.sessionId);
    const nextRecording: ActiveRecording = {
      recordingId: this.makeRecordingId(),
      provider: input.provider,
      sessionId: input.sessionId,
      outputPath,
      startedAt: nowIso,
      lastWriteAt: nowIso,
    };
    this.recordings.set(sessionKey, nextRecording);

    if ((input.seedEvents?.length ?? 0) > 0) {
      const result = await this.writer.appendEvents(
        outputPath,
        input.seedEvents ?? [],
        this.makeWriterOptions(input.title),
      );
      if (result.wrote) {
        const updated = this.recordings.get(sessionKey);
        if (updated) {
          updated.lastWriteAt = this.now().toISOString();
        }
      }
    }

    await this.operationalLogger.info(
      "recording.rotate",
      "Recording stream started or rotated",
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
      this.makeWriterOptions(input.title),
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
      this.makeWriterOptions(input.title),
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
    const sessionKey = makeSessionKey(input.provider, input.sessionId);
    const activeRecording = this.recordings.get(sessionKey);
    if (!activeRecording) {
      return { appended: false, deduped: false };
    }

    const writeResult = await this.writer.appendEvents(
      activeRecording.outputPath,
      input.events,
      this.makeWriterOptions(input.title),
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
      this.makeWriterOptions(input.title),
    );
  }

  stopRecording(provider: string, sessionId: string): boolean {
    return this.recordings.delete(makeSessionKey(provider, sessionId));
  }

  getActiveRecording(
    provider: string,
    sessionId: string,
  ): ActiveRecording | undefined {
    const recording = this.recordings.get(makeSessionKey(provider, sessionId));
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
        "overwrite",
      );
    }
    return await this.writer.overwriteEvents(outputPath, events, writerOptions);
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

  private makeWriterOptions(title: string | undefined): MarkdownRenderOptions {
    return {
      ...this.defaultRenderOptions,
      title,
      now: this.now,
    };
  }
}
