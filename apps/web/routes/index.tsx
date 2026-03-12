import { Head } from "fresh/runtime";
import SummaryLive from "../islands/SummaryLive.tsx";
import AppHeader from "../src/app_header.tsx";
import {
  loadSummaryPageData,
  toAppChromeStatus,
} from "../src/loaders/status.ts";
import { define } from "../utils.ts";

export default define.page(async function Home(ctx) {
  const summary = await loadSummaryPageData();

  return (
    <>
      <Head>
        <title>Kato Web · Summary</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Summary"
          description="Browser access to the daemon status with live polling, workspace health, and recent operator-visible errors."
          currentPath="/"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={toAppChromeStatus({
            daemon: summary.daemon,
            stale: summary.stale,
          })}
        />
        <SummaryLive initialData={summary} endpoint="/api/summary" />
      </div>
    </>
  );
});
