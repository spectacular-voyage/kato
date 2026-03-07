import { clearSessionCookie, loadWebConfigState } from "../src/auth.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async POST(_ctx) {
    const { config } = await loadWebConfigState();
    const headers = new Headers();
    if (config) {
      clearSessionCookie(headers, config);
    }
    headers.set("location", "/login");
    return new Response(null, { status: 302, headers });
  },
});
