import { Head } from "fresh/runtime";
import SessionsLive from "../islands/SessionsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { loadSessionsPageData } from "../src/loaders/sessions.ts";
import { createWebLoggers } from "../src/logging.ts";
import { parseSessionPageQuery } from "../src/page_queries.ts";
import {
  runSessionRecordingAction,
  runSessionRecordingStopAction,
} from "../src/session_recording_actions.ts";
import { runSessionOutputMetadataUpdateAction } from "../src/session_metadata_actions.ts";
import { buildSessionInventoryHref } from "../src/session_routes.ts";
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

function buildRedirectUrl(
  reqUrl: string,
  options: {
    includeStale: boolean;
    workspaceFilter?: string;
    notice?: string;
    error?: string;
  },
): URL {
  const url = new URL(
    buildSessionInventoryHref({
      includeStale: options.includeStale,
      workspaceFilter: options.workspaceFilter,
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

function buildSessionRecordingNotice(
  result: Awaited<ReturnType<typeof runSessionRecordingAction>>,
): string {
  if (result.mode === "record") {
    return result.noOp
      ? `recording already engaged: ${result.workspaceAlias} (${result.sessionShortId})`
      : `recording engaged: ${result.workspaceAlias} (${result.sessionShortId})`;
  }
  return `capture created: ${result.workspaceAlias} (${result.sessionShortId})`;
}

function buildSessionRecordingStopNotice(
  result: Awaited<ReturnType<typeof runSessionRecordingStopAction>>,
): string {
  if (result.action === "stop-all-recordings") {
    return result.noOp
      ? `no engaged recordings to stop (${result.sessionShortId})`
      : `stopped ${result.stoppedCount} recording${
        result.stoppedCount === 1 ? "" : "s"
      } (${result.sessionShortId})`;
  }
  const workspaceAlias = result.stoppedWorkspaceAliases[0];
  return result.noOp
    ? `recording already stopped (${result.sessionShortId})`
    : workspaceAlias
    ? `recording stopped: ${workspaceAlias} (${result.sessionShortId})`
    : `recording stopped (${result.sessionShortId})`;
}

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const includeStale = String(form.get("includeStale") ?? "true") !== "false";
    const workspaceFilter = String(form.get("workspaceFilter") ?? "").trim() ||
      undefined;
    const { operationalLogger, auditLogger } = createWebLoggers();

    try {
      const sessionId = String(form.get("sessionId") ?? "").trim();
      if (sessionId.length === 0) {
        throw new Error("Session id is required");
      }

      if (action === "new-recording" || action === "new-capture") {
        const workspaceSelector = String(form.get("workspaceSelector") ?? "")
          .trim();
        if (workspaceSelector.length === 0) {
          throw new Error("Workspace selector is required");
        }
        const displayTitle = String(form.get("displayTitle") ?? "").trim();
        const filenameSlug = String(form.get("filenameSlug") ?? "").trim();
        const tags = String(form.get("tags") ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
        const result = await runSessionRecordingAction({
          action,
          sessionId,
          workspaceSelector,
          creationMetadata: {
            ...(displayTitle.length > 0 ? { displayTitle } : {}),
            ...(filenameSlug.length > 0 ? { filenameSlug } : {}),
            ...(tags.length > 0 ? { tags } : {}),
          },
          operationalLogger,
          auditLogger,
        });
        return Response.redirect(
          buildRedirectUrl(ctx.req.url, {
            includeStale,
            workspaceFilter,
            notice: buildSessionRecordingNotice(result),
          }),
          303,
        );
      }

      if (action === "stop-recording" || action === "stop-all-recordings") {
        const workspaceId = String(form.get("workspaceId") ?? "").trim() ||
          undefined;
        const recordingCycleId = String(form.get("recordingCycleId") ?? "")
          .trim() || undefined;
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
            includeStale,
            workspaceFilter,
            notice: buildSessionRecordingStopNotice(result),
          }),
          303,
        );
      }

      if (
        action === "update-session-metadata-defaults" ||
        action === "update-recording-metadata"
      ) {
        const readScalarEdit = (name: string): string | null | undefined => {
          if (!form.has(name)) {
            return undefined;
          }
          const value = String(form.get(name) ?? "").trim();
          return value.length > 0 ? value : null;
        };
        const tags = form.has("tags")
          ? String(form.get("tags") ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0)
          : undefined;
        const result = await runSessionOutputMetadataUpdateAction({
          scope: action === "update-session-metadata-defaults"
            ? "session-defaults"
            : "output",
          sessionId,
          selector: {
            workspaceId: String(form.get("workspaceId") ?? "").trim() ||
              undefined,
            outputPath: String(form.get("outputPath") ?? "").trim() ||
              undefined,
            recordingCycleId:
              String(form.get("recordingCycleId") ?? "").trim() ||
              undefined,
          },
          edits: {
            displayTitle: readScalarEdit("displayTitle"),
            personaName: readScalarEdit("personaName"),
            participantUsername: readScalarEdit("participantUsername"),
            ...(tags !== undefined ? { tags } : {}),
          },
          operationalLogger,
          auditLogger,
        });
        return Response.redirect(
          buildRedirectUrl(ctx.req.url, {
            includeStale,
            workspaceFilter,
            notice: result.scope === "session-defaults"
              ? `session metadata updated (${result.sessionShortId})`
              : `recording metadata updated (${result.sessionShortId})`,
          }),
          303,
        );
      }

      return new Response("unsupported sessions action", { status: 400 });
    } catch (error) {
      await operationalLogger.error(
        "web.sessions.recording.mutation.failed",
        "Session recording mutation failed",
        {
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return Response.redirect(
        buildRedirectUrl(ctx.req.url, {
          includeStale,
          workspaceFilter,
          error: error instanceof Error ? error.message : String(error),
        }),
        303,
      );
    }
  },
});

export default define.page(async function SessionsPage(ctx) {
  const query = parseSessionPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadSessionsPageData(query),
    loadAppChromeStatus(),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));

  return (
    <>
      <Head>
        <title>Kato Web · Sessions</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Sessions"
          description="Discovered chat-session inventory with live activity, recording state, and on-demand snippet reveal."
          currentPath="/sessions"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}

        <SessionsLive
          initialData={pageData}
          endpoint={`/api/sessions${ctx.url.search}`}
          csrfToken={ctx.state.csrfToken}
        />
      </div>
    </>
  );
});
