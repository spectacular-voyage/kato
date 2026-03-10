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

export default define.page(async function SecurityPage(ctx) {
  const scope = parseScope(ctx.url.searchParams.get("scope"));
  const level = parseLevel(ctx.url.searchParams.get("level"));
  const eventFilter = ctx.url.searchParams.get("event") ?? undefined;
  const textFilter = ctx.url.searchParams.get("q") ?? undefined;
  const [pageData, appStatus] = await Promise.all([
    loadLogPageData({
      channel: "security-audit",
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
        <title>Kato Web · Security</title>
      </Head>
      <LogPageView
        title="Security"
        description="Daemon and web security-audit logs with shared filtering for scope, level, event, and text."
        currentPath="/security"
        pageData={pageData}
        appStatus={appStatus}
      />
    </>
  );
});
