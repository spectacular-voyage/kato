import { loadSummaryPageData } from "../../src/loaders/status.ts";
import { summaryApiResponse } from "../../src/summary_api.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET() {
    const summary = await loadSummaryPageData();
    return summaryApiResponse(summary);
  },
});
