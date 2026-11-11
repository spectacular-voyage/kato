import { clearSessionCookie, loadWebConfigState } from "../src/auth.ts";
import type { RouteContext } from "../src/route_context.ts";

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

export function GET(): Response {
  return new Response("logout requires POST", { status: 405 });
}

export async function POST(ctx: RouteContext): Promise<Response> {
  return await clearSessionAndRedirectToLogin(ctx.req);
}
