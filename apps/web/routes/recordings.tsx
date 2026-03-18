import { Head } from "fresh/runtime";
import RecordingsLive from "../islands/RecordingsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadRecordingsPageData } from "../src/loaders/recordings.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { parseRecordingsPageQuery } from "../src/page_queries.ts";
import { handleRecordingsPagePost } from "../src/recordings_page_post.ts";
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
    return await handleRecordingsPagePost(ctx.req);
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
