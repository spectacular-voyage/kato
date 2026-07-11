import type { WebConfig } from "@kato/shared";
import type { AuditLogger, StructuredLogger } from "@kato/runtime";
import type { RecordingStateFilter } from "./loaders/recordings.ts";
import { loadWebConfig, verifyCsrfToken } from "./auth.ts";
import { createWebLoggers } from "./logging.ts";
import {
  runSessionRecordingRestartAction,
  runSessionRecordingStopAction,
} from "./session_recording_actions.ts";
import {
  runSessionOutputMetadataUpdateAction,
  runSessionWriterOverridesAction,
} from "./session_metadata_actions.ts";
import { parseWriterFlagChoice } from "./output_writer_policy.ts";
import { buildRecordingsRecordingHref } from "./session_routes.ts";

function normalizeRecordingsStateFilter(value: string): RecordingStateFilter {
  return value === "engaged-active" || value === "engaged-stale" ||
      value === "stopped"
    ? value
    : "all";
}

function buildRedirectUrl(
  reqUrl: string,
  options: {
    stateFilter: RecordingStateFilter;
    workspaceFilter?: string;
    recordingCycleId?: string;
    rowKey?: string;
    notice?: string;
    error?: string;
  },
): URL {
  const url = new URL(
    buildRecordingsRecordingHref({
      stateFilter: options.stateFilter,
      workspaceFilter: options.workspaceFilter,
      recordingCycleId: options.recordingCycleId,
      rowKey: options.rowKey,
    }),
    reqUrl,
  );
  if (options.notice) {
    url.searchParams.set("notice", options.notice);
  }
  if (options.error) {
    url.searchParams.set("error", options.error);
  }
  return url;
}

function buildRecordingStopNotice(
  result: Awaited<ReturnType<typeof runSessionRecordingStopAction>>,
): string {
  const workspaceAlias = result.stoppedWorkspaceAliases[0];
  return result.noOp
    ? `recording already stopped (${result.sessionShortId})`
    : workspaceAlias
    ? `recording stopped: ${workspaceAlias} (${result.sessionShortId})`
    : `recording stopped (${result.sessionShortId})`;
}

function buildRecordingRestartNotice(
  result: Awaited<ReturnType<typeof runSessionRecordingRestartAction>>,
): string {
  return result.noOp
    ? `recording already engaged (${result.sessionShortId})`
    : result.workspaceAlias
    ? `recording re-armed: ${result.workspaceAlias} (${result.sessionShortId})`
    : `recording re-armed (${result.sessionShortId})`;
}

function buildWriterOverridesNotice(
  result: Awaited<ReturnType<typeof runSessionWriterOverridesAction>>,
): string {
  const describe = (label: string, override: boolean | undefined) =>
    override === undefined
      ? `${label} default`
      : `${label} ${override ? "include" : "exclude"}`;
  return `render policy updated: ${
    describe("commentary", result.overrides?.writerIncludeCommentary)
  }, ${
    describe("thinking", result.overrides?.writerIncludeThinking)
  } (${result.sessionShortId})`;
}

function buildRecordingsMutationErrorToken(
  action: string,
  error: unknown,
): string {
  if (error instanceof Error && error.message === "Session id is required") {
    return "invalid_request";
  }
  if (action === "stop-recording") {
    return "stop_failed";
  }
  if (action === "restart-recording") {
    return "restart_failed";
  }
  if (action === "set-writer-overrides") {
    return "writer_overrides_failed";
  }
  if (action === "update-recording-metadata") {
    return "metadata_update_failed";
  }
  return "internal_error";
}

export interface HandleRecordingsPagePostOptions {
  katoDir?: string;
  webConfig?: WebConfig;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

export async function handleRecordingsPagePost(
  req: Request,
  options: HandleRecordingsPagePostOptions = {},
): Promise<Response> {
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const stateFilter = normalizeRecordingsStateFilter(
    String(form.get("stateFilter") ?? ""),
  );
  const workspaceFilter = String(form.get("workspaceFilter") ?? "").trim() ||
    undefined;
  const recordingCycleId = String(form.get("recordingCycleId") ?? "").trim() ||
    undefined;
  const rowKey = String(form.get("rowKey") ?? "").trim() || undefined;
  const csrfToken = String(form.get("csrfToken") ?? "").trim() || undefined;
  const webConfig = options.webConfig ??
    await loadWebConfig({ katoDir: options.katoDir });
  if (!webConfig || !(await verifyCsrfToken(req, webConfig, csrfToken))) {
    return new Response("csrf token required", { status: 403 });
  }
  const defaultLoggers = options.operationalLogger && options.auditLogger
    ? undefined
    : createWebLoggers({ katoDir: options.katoDir });
  const operationalLogger = options.operationalLogger ??
    defaultLoggers?.operationalLogger;
  const auditLogger = options.auditLogger ?? defaultLoggers?.auditLogger;
  if (!operationalLogger || !auditLogger) {
    throw new Error("Recordings page post loggers were not initialized");
  }

  try {
    const sessionId = String(form.get("sessionId") ?? "").trim();
    if (sessionId.length === 0) {
      throw new Error("Session id is required");
    }

    if (action === "stop-recording") {
      const workspaceId = String(form.get("workspaceId") ?? "").trim() ||
        undefined;
      const outputPath = String(form.get("outputPath") ?? "").trim() ||
        undefined;
      const result = await runSessionRecordingStopAction({
        action,
        sessionId,
        workspaceId,
        recordingCycleId,
        outputPath,
        katoDir: options.katoDir,
        operationalLogger,
        auditLogger,
      });
      return Response.redirect(
        buildRedirectUrl(req.url, {
          stateFilter,
          workspaceFilter,
          recordingCycleId,
          rowKey,
          notice: buildRecordingStopNotice(result),
        }),
        303,
      );
    }

    if (action === "restart-recording") {
      const workspaceId = String(form.get("workspaceId") ?? "").trim() ||
        undefined;
      const outputPath = String(form.get("outputPath") ?? "").trim() ||
        undefined;
      const result = await runSessionRecordingRestartAction({
        action,
        sessionId,
        workspaceId,
        recordingCycleId,
        outputPath,
        katoDir: options.katoDir,
        operationalLogger,
        auditLogger,
      });
      return Response.redirect(
        buildRedirectUrl(req.url, {
          stateFilter,
          workspaceFilter,
          recordingCycleId: result.recordingCycleId ?? recordingCycleId,
          rowKey,
          notice: buildRecordingRestartNotice(result),
        }),
        303,
      );
    }

    if (action === "set-writer-overrides") {
      const workspaceId = String(form.get("workspaceId") ?? "").trim() ||
        undefined;
      const outputPath = String(form.get("outputPath") ?? "").trim() ||
        undefined;
      const result = await runSessionWriterOverridesAction({
        sessionId,
        selector: { workspaceId, outputPath, recordingCycleId },
        commentary: parseWriterFlagChoice(
          String(form.get("commentary") ?? "").trim() || undefined,
        ),
        thinking: parseWriterFlagChoice(
          String(form.get("thinking") ?? "").trim() || undefined,
        ),
        katoDir: options.katoDir,
        operationalLogger,
        auditLogger,
      });
      return Response.redirect(
        buildRedirectUrl(req.url, {
          stateFilter,
          workspaceFilter,
          recordingCycleId,
          rowKey,
          notice: buildWriterOverridesNotice(result),
        }),
        303,
      );
    }

    if (action === "update-recording-metadata") {
      const workspaceId = String(form.get("workspaceId") ?? "").trim() ||
        undefined;
      const outputPath = String(form.get("outputPath") ?? "").trim() ||
        undefined;
      const tags = String(form.get("tags") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      const result = await runSessionOutputMetadataUpdateAction({
        scope: "output",
        sessionId,
        selector: { workspaceId, outputPath, recordingCycleId },
        edits: { tags },
        katoDir: options.katoDir,
        operationalLogger,
        auditLogger,
      });
      return Response.redirect(
        buildRedirectUrl(req.url, {
          stateFilter,
          workspaceFilter,
          recordingCycleId,
          rowKey,
          notice: `recording tags updated (${result.sessionShortId})`,
        }),
        303,
      );
    }

    return new Response("unsupported recordings action", { status: 400 });
  } catch (error) {
    await operationalLogger.error(
      "web.recordings.mutation.failed",
      "Recordings mutation failed",
      {
        action,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack
          ? { errorStack: error.stack }
          : {}),
      },
    );
    return Response.redirect(
      buildRedirectUrl(req.url, {
        stateFilter,
        workspaceFilter,
        recordingCycleId,
        rowKey,
        error: buildRecordingsMutationErrorToken(action, error),
      }),
      303,
    );
  }
}
