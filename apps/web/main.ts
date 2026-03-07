import { App, staticFiles } from "fresh";
import type { State } from "./utils.ts";
import {
  createCsrfToken,
  isAuthenticatedRequest,
  isSameOriginRequest,
  loadWebConfigState,
  readCsrfTokenFromRequest,
  verifyCsrfToken,
} from "./src/auth.ts";
import { logUnhandledWebRequestError } from "./src/logging.ts";
import { startWebServerStatusHeartbeat } from "./src/server_status.ts";

export const app = new App<State>();

startWebServerStatusHeartbeat();

app.use(async (ctx) => {
  try {
    return await ctx.next();
  } catch (error) {
    try {
      await logUnhandledWebRequestError(ctx.req, error);
    } catch {
      // Keep the original request failure as the primary error path.
    }
    throw error;
  }
});

app.use(staticFiles());

app.use(async (ctx) => {
  ctx.state.appName = "Kato Web";
  ctx.state.authenticated = false;
  ctx.state.csrfToken = undefined;
  return await ctx.next();
});

app.use(async (ctx) => {
  const pathname = new URL(ctx.req.url).pathname;
  if (
    pathname.startsWith("/_fresh/") ||
    pathname === "/login"
  ) {
    const { config } = await loadWebConfigState();
    ctx.state.webConfig = config;
    ctx.state.authenticated = pathname === "/login"
      ? await isAuthenticatedRequest(ctx.req, ctx.state.webConfig)
      : false;
    ctx.state.csrfToken = ctx.state.authenticated && config
      ? await createCsrfToken(ctx.req, config)
      : undefined;
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
      if (!isSameOriginRequest(ctx.req)) {
        return new Response("same-origin request required", { status: 403 });
      }
    }
    return await ctx.next();
  }

  const { config: webConfig, error } = await loadWebConfigState();
  ctx.state.webConfig = webConfig;
  const authenticated = await isAuthenticatedRequest(ctx.req, webConfig);
  ctx.state.authenticated = authenticated;
  ctx.state.csrfToken = authenticated && webConfig
    ? await createCsrfToken(ctx.req, webConfig)
    : undefined;

  if (!webConfig) {
    return new Response(
      error
        ? `Kato Web config is invalid: ${error}\nRe-run \`kato web init --username <username> --password <password>\` with a fresh config.`
        : "Kato Web is unconfigured. Run `kato web init --username <username> --password <password>` first.",
      { status: 503 },
    );
  }

  if (authenticated) {
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
      if (!isSameOriginRequest(ctx.req)) {
        return new Response("same-origin request required", { status: 403 });
      }
      const csrfToken = await readCsrfTokenFromRequest(ctx.req);
      const validCsrf = await verifyCsrfToken(ctx.req, webConfig, csrfToken);
      if (!validCsrf) {
        return new Response("csrf token required", { status: 403 });
      }
    }
    return await ctx.next();
  }

  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "authentication required" }, { status: 401 });
  }

  return Response.redirect(new URL("/login", ctx.req.url), 302);
});

app.fsRoutes();
