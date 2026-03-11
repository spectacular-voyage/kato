import { Head } from "fresh/runtime";
import SummaryLive from "../islands/SummaryLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadSummaryPageData } from "../src/loaders/status.ts";
import { define } from "../utils.ts";

export default define.page(async function Home() {
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
          appStatus={{
            daemon: summary.daemon,
            snapshot: summary.stale ? "stale" : "current",
          }}
        />
        <SummaryLive initialData={summary} endpoint="/api/summary" />
      </div>
    </>
  );
});
