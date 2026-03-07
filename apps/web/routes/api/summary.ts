import { loadSummaryPageData } from "../../src/loaders/status.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET() {
    const summary = await loadSummaryPageData();
    return Response.json(summary);
  },
});
