import { Head } from "fresh/runtime";
import RecordingsLive from "../islands/RecordingsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadRecordingsPageData } from "../src/loaders/recordings.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { parseRecordingsPageQuery } from "../src/page_queries.ts";
import { define } from "../utils.ts";

export default define.page(async function RecordingsPage(ctx) {
  const query = parseRecordingsPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadRecordingsPageData(query),
    loadAppChromeStatus(),
  ]);

  return (
    <>
      <Head>
        <title>Kato Web · Recordings</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Recordings"
          description="Full recording history and live recording status across all discovered sessions."
          currentPath="/recordings"
          showLogout
          appStatus={appStatus}
        />
        <RecordingsLive
          initialData={pageData}
          endpoint={`/api/recordings${ctx.url.search}`}
        />
      </div>
    </>
  );
});
