import { getWorkspacesResponse } from "../../src/live_routes.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  GET() {
    return getWorkspacesResponse();
  },
});
