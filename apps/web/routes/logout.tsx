import { clearSessionCookie, loadWebConfigState } from "../src/auth.ts";
import { define } from "../utils.ts";

async function clearSessionAndRedirectToLogin(
  request: Request,
): Promise<Response> {
  const { config } = await loadWebConfigState();
  const headers = new Headers();
  if (config) {
    clearSessionCookie(headers, request, config);
  }
  headers.set("location", "/login");
  return new Response(null, { status: 302, headers });
}

export const handler = define.handlers({
  GET() {
    return new Response("logout requires POST", { status: 405 });
  },
  async POST(ctx) {
    return await clearSessionAndRedirectToLogin(ctx.req);
  },
});
