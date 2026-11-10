import SummaryLive from "../islands/SummaryLive.tsx";
import AppHeader from "../src/app_header.tsx";
import {
  loadSummaryPageData,
  toAppChromeStatus,
} from "../src/loaders/status.ts";
import type { RouteContext } from "../src/route_context.ts";
import type { PageResult } from "./page.ts";

export async function page(ctx: RouteContext): Promise<PageResult> {
  const summary = await loadSummaryPageData();

  return {
    title: "Kato Web · Summary",
    body: (
      <>
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
    ),
  };
}
