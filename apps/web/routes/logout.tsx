import { clearSessionCookie, loadWebConfigState } from "../src/auth.ts";
import { define } from "../utils.ts";

async function redirectToLogin(): Promise<Response> {
  const { config } = await loadWebConfigState();
  const headers = new Headers();
  if (config) {
    clearSessionCookie(headers, config);
  }
  headers.set("location", "/login");
  return new Response(null, { status: 302, headers });
}

export const handler = define.handlers({
  async GET() {
    return await redirectToLogin();
  },
  async POST() {
    return await redirectToLogin();
  },
});
