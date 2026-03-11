import { Head } from "fresh/runtime";
import LogPageView from "../src/log_page.tsx";
import {
  DEFAULT_LOG_LEVEL_FILTER,
  loadLogPageData,
  type LogChannelFilter,
  type LogLevelFilter,
  type LogScopeFilter,
} from "../src/loaders/logs.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { define } from "../utils.ts";

function parseChannel(value: string | null): LogChannelFilter {
  return value === "operational" || value === "security-audit" ? value : "all";
}

function parseScope(value: string | null): LogScopeFilter {
  return value === "daemon" || value === "web" ? value : "all";
}

function parseLevel(value: string | null): LogLevelFilter {
  return value === "all" || value === "debug" || value === "info" ||
      value === "warn" || value === "error"
    ? value
    : DEFAULT_LOG_LEVEL_FILTER;
}

export default define.page(async function LogsPage(ctx) {
  const channel = parseChannel(ctx.url.searchParams.get("channel"));
  const scope = parseScope(ctx.url.searchParams.get("scope"));
  const level = parseLevel(ctx.url.searchParams.get("level"));
  const eventFilter = ctx.url.searchParams.get("event") ?? undefined;
  const textFilter = ctx.url.searchParams.get("q") ?? undefined;
  const [pageData, appStatus] = await Promise.all([
    loadLogPageData({
      channel,
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
        <title>Kato Web · Logs</title>
      </Head>
      <LogPageView
        title="Logs"
        description="Daemon and web logs across operational and security-audit channels with shared filtering for channel, scope, level, event, and text."
        currentPath="/logs"
        pageData={pageData}
        appStatus={appStatus}
      />
    </>
  );
});
