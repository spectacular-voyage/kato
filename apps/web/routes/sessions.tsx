import { Head } from "fresh/runtime";
import SessionsLive from "../islands/SessionsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { loadSessionsPageData } from "../src/loaders/sessions.ts";
import { parseSessionPageQuery } from "../src/page_queries.ts";
import { define } from "../utils.ts";

export default define.page(async function SessionsPage(ctx) {
  const query = parseSessionPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadSessionsPageData(query),
    loadAppChromeStatus(),
  ]);

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

        <SessionsLive
          initialData={pageData}
          endpoint={`/api/sessions${ctx.url.search}`}
        />
      </div>
    </>
  );
});
