import { define } from "../../utils.ts";
import {
  redirectLegacyBrandAsset,
} from "../../src/brand_assets.ts";

export const handler = define.handlers({
  GET(ctx: { params: Record<string, string>; req: Request }) {
    return redirectLegacyBrandAsset(ctx.req.url, ctx.params.asset ?? "");
  },
});
