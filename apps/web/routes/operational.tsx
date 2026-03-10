import { Head } from "fresh/runtime";
import LogPageView from "../src/log_page.tsx";
import {
  loadLogPageData,
  type LogLevelFilter,
  type LogScopeFilter,
} from "../src/loaders/logs.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { define } from "../utils.ts";

function parseScope(value: string | null): LogScopeFilter {
  return value === "daemon" || value === "web" ? value : "all";
}

function parseLevel(value: string | null): LogLevelFilter {
  return value === "debug" || value === "info" || value === "warn" ||
      value === "error"
    ? value
    : "all";
}

export default define.page(async function OperationalPage(ctx) {
  const scope = parseScope(ctx.url.searchParams.get("scope"));
  const level = parseLevel(ctx.url.searchParams.get("level"));
  const eventFilter = ctx.url.searchParams.get("event") ?? undefined;
  const textFilter = ctx.url.searchParams.get("q") ?? undefined;
  const [pageData, appStatus] = await Promise.all([
    loadLogPageData({
      channel: "operational",
      scope,
      level,
      eventFilter,
      textFilter,
    }),
    loadAppChromeStatus(),
  ]);

  return (
    <>
      <Head>
        <title>Kato Web · Operational</title>
      </Head>
      <LogPageView
        title="Operational"
        description="Daemon and web operational logs with shared filtering for scope, level, event, and text."
        currentPath="/operational"
        pageData={pageData}
        appStatus={appStatus}
      />
    </>
  );
});
