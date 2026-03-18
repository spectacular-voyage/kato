import type { RecordingStateFilter } from "./loaders/recordings.ts";
import { createWebLoggers } from "./logging.ts";
import {
  runSessionRecordingRestartAction,
  runSessionRecordingStopAction,
} from "./session_recording_actions.ts";
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

export async function handleRecordingsPagePost(
  req: Request,
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
  const { operationalLogger, auditLogger } = createWebLoggers();

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

    return new Response("unsupported recordings action", { status: 400 });
  } catch (error) {
    await operationalLogger.error(
      "web.recordings.mutation.failed",
      "Recordings mutation failed",
      {
        action,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return Response.redirect(
      buildRedirectUrl(req.url, {
        stateFilter,
        workspaceFilter,
        recordingCycleId,
        rowKey,
        error: error instanceof Error ? error.message : String(error),
      }),
      303,
    );
  }
}
