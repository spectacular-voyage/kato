import { define } from "../../utils.ts";

const ASSET_PATHS = {
  logo: new URL(
    "../../../../shared/assets/2026-03_kato-logo_256.png",
    import.meta.url,
  ),
  wordmark: new URL(
    "../../../../shared/assets/2026-03_kato-wordmark_v2_black-outline.png",
    import.meta.url,
  ),
} as const;

type BrandAsset = keyof typeof ASSET_PATHS;

function isBrandAsset(value: string): value is BrandAsset {
  return value === "logo" || value === "wordmark";
}

export const handler = define.handlers({
  async GET(ctx) {
    const asset = ctx.params.asset;
    if (!isBrandAsset(asset)) {
      return new Response("not found", { status: 404 });
    }

    const bytes = await Deno.readFile(ASSET_PATHS[asset]);
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      },
    });
  },
});
