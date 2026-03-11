import { Head } from "fresh/runtime";
import IngestionLive from "../islands/IngestionLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadSessionsPageData } from "../src/loaders/sessions.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { parseSessionPageQuery } from "../src/page_queries.ts";
import { define } from "../utils.ts";

export default define.page(async function IngestionPage(ctx) {
  const query = parseSessionPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadSessionsPageData(query),
    loadAppChromeStatus(),
  ]);

  return (
    <>
      <Head>
        <title>Kato Web · Ingestion</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Ingestion"
          description="Operational state for provider-session ingestion, with the latest recording per destination."
          currentPath="/ingestion"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />
        <IngestionLive
          initialData={pageData}
          endpoint={`/api/ingestion${ctx.url.search}`}
        />
      </div>
    </>
  );
});
