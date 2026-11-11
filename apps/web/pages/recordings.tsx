import RecordingsLive from "../islands/RecordingsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadRecordingsPageData } from "../src/loaders/recordings.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { parseRecordingsPageQuery } from "../src/page_queries.ts";
import { handleRecordingsPagePost } from "../src/recordings_page_post.ts";
import type { RouteContext } from "../src/route_context.ts";
import type { PageResult } from "./page.ts";

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

export async function POST(ctx: RouteContext): Promise<Response> {
  return await handleRecordingsPagePost(ctx.req);
}

export async function page(ctx: RouteContext): Promise<PageResult> {
  const query = parseRecordingsPageQuery(ctx.url);
  const [pageData, appStatus] = await Promise.all([
    loadRecordingsPageData(query),
    loadAppChromeStatus(),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));

  return {
    title: "Kato Web · Recordings",
    body: (
      <>
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
    ),
  };
}
