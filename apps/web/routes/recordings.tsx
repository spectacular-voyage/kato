import { Head } from "fresh/runtime";
import type { RecordingStateFilter } from "../src/loaders/recordings.ts";
import RecordingsLive from "../islands/RecordingsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadRecordingsPageData } from "../src/loaders/recordings.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { createWebLoggers } from "../src/logging.ts";
import { parseRecordingsPageQuery } from "../src/page_queries.ts";
import {
  runSessionRecordingRestartAction,
  runSessionRecordingStopAction,
} from "../src/session_recording_actions.ts";
import { buildRecordingsRecordingHref } from "../src/session_routes.ts";
import { define } from "../utils.ts";

function decodeMessage(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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
    ? `recording re-started: ${result.workspaceAlias} (${result.sessionShortId})`
    : `recording re-started (${result.sessionShortId})`;
}

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
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
          buildRedirectUrl(ctx.req.url, {
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
          buildRedirectUrl(ctx.req.url, {
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
        buildRedirectUrl(ctx.req.url, {
          stateFilter,
          workspaceFilter,
          recordingCycleId,
          rowKey,
          error: error instanceof Error ? error.message : String(error),
        }),
        303,
      );
    }
  },
});

export default define.page(async function RecordingsPage(ctx) {
  const query = parseRecordingsPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadRecordingsPageData(query),
    loadAppChromeStatus(),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));

  return (
    <>
      <Head>
        <title>Kato Web · Recordings</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Recordings"
          description="Recording outputs and live recording status across all discovered sessions."
          currentPath="/recordings"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />
        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}
        <RecordingsLive
          initialData={pageData}
          endpoint={`/api/recordings${ctx.url.search}`}
          csrfToken={ctx.state.csrfToken}
        />
      </div>
    </>
  );
});
