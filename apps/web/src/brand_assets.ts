export const BRAND_ASSET_PUBLIC_PATHS = {
  logo: "/brand/logo.png",
  wordmark: "/brand/wordmark.png",
} as const;

export type BrandAsset = keyof typeof BRAND_ASSET_PUBLIC_PATHS;

export function isBrandAsset(value: string): value is BrandAsset {
  return value === "logo" || value === "wordmark";
}

export function resolveBrandAssetPublicPath(asset: BrandAsset): string {
  return BRAND_ASSET_PUBLIC_PATHS[asset];
}

export function redirectLegacyBrandAsset(
  requestUrl: string | URL,
  asset: string,
): Response {
  if (!isBrandAsset(asset)) {
    return new Response("not found", { status: 404 });
  }

  return Response.redirect(
    new URL(resolveBrandAssetPublicPath(asset), requestUrl),
    307,
  );
}
