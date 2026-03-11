import { getLogsResponse } from "../../src/live_routes.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  GET(ctx: { url: URL }) {
    return getLogsResponse(ctx.url);
  },
});
