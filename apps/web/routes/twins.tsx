import { Head } from "fresh/runtime";
import TwinsLive from "../islands/TwinsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { loadTwinsPageData } from "../src/loaders/twins.ts";
import { createWebLoggers } from "../src/logging.ts";
import { parseSessionPageQuery } from "../src/page_queries.ts";
import { buildTwinInventoryHref } from "../src/session_routes.ts";
import { ingestPersistedSession } from "../src/session_ingestion.ts";
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

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const includeStale = String(form.get("includeStale") ?? "true") !== "false";
    const workspaceFilter = String(form.get("workspaceFilter") ?? "").trim() ||
      undefined;
    const redirectUrl = new URL(
      buildTwinInventoryHref({
        includeStale,
        workspaceFilter,
      }),
      ctx.req.url,
    );
    const { operationalLogger, auditLogger } = createWebLoggers();

    try {
      if (action !== "start-ingestion") {
        return new Response("unsupported twins action", { status: 400 });
      }

      const sessionId = String(form.get("sessionId") ?? "").trim();
      if (sessionId.length === 0) {
        throw new Error("Session id is required");
      }

      const result = await ingestPersistedSession({
        sessionId,
        operationalLogger,
        auditLogger,
      });
      const notice = result.appendedTwinEvents > 0
        ? `${result.twinAction} twin completed: ${result.provider} (${result.sessionShortId})`
        : result.parsedEvents > 0
        ? `${result.twinAction} twin already current: ${result.provider} (${result.sessionShortId})`
        : `no twin events found: ${result.provider} (${result.sessionShortId})`;
      redirectUrl.searchParams.set("notice", notice);
      return Response.redirect(redirectUrl, 303);
    } catch (error) {
      await operationalLogger.error(
        "web.twins.mutation.failed",
        "Twin mutation failed",
        {
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      redirectUrl.searchParams.set(
        "error",
        error instanceof Error ? error.message : String(error),
      );
      return Response.redirect(redirectUrl, 303);
    }
  },
});

export default define.page(async function TwinsPage(ctx) {
  const query = parseSessionPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadTwinsPageData(query),
    loadAppChromeStatus(),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));

  return (
    <>
      <Head>
        <title>Kato Web · Twins</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Twins"
          description="Persisted conversation twin inventory with file paths, freshness, and manual twin actions."
          currentPath="/twins"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}

        <TwinsLive
          initialData={pageData}
          endpoint={`/api/twins${ctx.url.search}`}
          csrfToken={ctx.state.csrfToken}
        />
      </div>
    </>
  );
});
