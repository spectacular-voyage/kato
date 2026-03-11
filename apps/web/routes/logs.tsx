import { Head } from "fresh/runtime";
import LogPageView from "../src/log_page.tsx";
import { loadLogPageData } from "../src/loaders/logs.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { parseLogsPageQuery } from "../src/page_queries.ts";
import { define } from "../utils.ts";

export default define.page(async function LogsPage(ctx) {
  const query = parseLogsPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadLogPageData(query),
    loadAppChromeStatus(),
  ]);

  return (
    <>
      <Head>
        <title>Kato Web · Logs</title>
      </Head>
      <LogPageView
        title="Logs"
        description="Daemon and web logs across operational and security-audit channels with shared filtering for channel, scope, level, event, and text."
        currentPath="/logs"
        pageData={pageData}
        appStatus={appStatus}
        liveResultsEndpoint={`/api/logs${ctx.url.search}`}
      />
    </>
  );
});
