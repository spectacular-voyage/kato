import { assertEquals } from "@std/assert";
import {
  BRAND_ASSET_PUBLIC_PATHS,
  redirectLegacyBrandAsset,
  isBrandAsset,
  resolveBrandAssetPublicPath,
} from "../apps/web/src/brand_assets.ts";

Deno.test("brand asset helpers expose stable static paths", () => {
  assertEquals(BRAND_ASSET_PUBLIC_PATHS.logo, "/brand/logo.png");
  assertEquals(BRAND_ASSET_PUBLIC_PATHS.wordmark, "/brand/wordmark.png");
  assertEquals(resolveBrandAssetPublicPath("logo"), "/brand/logo.png");
  assertEquals(resolveBrandAssetPublicPath("wordmark"), "/brand/wordmark.png");
  assertEquals(isBrandAsset("logo"), true);
  assertEquals(isBrandAsset("wordmark"), true);
  assertEquals(isBrandAsset("wordmark.png"), false);
});

Deno.test("brand route redirects legacy asset paths to static files", async () => {
  const response = await redirectLegacyBrandAsset(
    "http://localhost/brand/wordmark",
    "wordmark",
  );

  assertEquals(response.status, 307);
  assertEquals(
    response.headers.get("location"),
    "http://localhost/brand/wordmark.png",
  );
});

Deno.test("brand route rejects unknown assets", async () => {
  const response = await redirectLegacyBrandAsset(
    "http://localhost/brand/wordmark.png",
    "wordmark.png",
  );

  assertEquals(response.status, 404);
});
