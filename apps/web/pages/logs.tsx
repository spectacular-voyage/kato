import LogPageView from "../src/log_page.tsx";
import { loadLogPageData } from "../src/loaders/logs.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { parseLogsPageQuery } from "../src/page_queries.ts";
import type { RouteContext } from "../src/route_context.ts";
import type { PageResult } from "./page.ts";

export async function page(ctx: RouteContext): Promise<PageResult> {
  const query = parseLogsPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadLogPageData(query),
    loadAppChromeStatus(),
  ]);

  return {
    title: "Kato Web · Logs",
    body: (
      <>
        <LogPageView
          title="Logs"
          description="Daemon and web logs across operational and security-audit channels with shared filtering for channel, scope, level, event, and text."
          currentPath="/logs"
          pageData={pageData}
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
          liveResultsEndpoint={`/api/logs${ctx.url.search}`}
        />
      </>
    ),
  };
}
