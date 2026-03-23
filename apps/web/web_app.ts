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

export interface CreateWebAppOptions {
  katoDir?: string;
  startHeartbeat?: boolean;
}

const WEB_CONFIG_ERROR_MESSAGE =
  "Kato Web is unconfigured. Run `kato web init --username <username>` in an interactive terminal, or provide `KATO_WEB_PASSWORD` / `--password-stdin`.";

export function createWebApp(
  options: CreateWebAppOptions = {},
): App<State> {
  if (options.startHeartbeat !== false) {
    startWebServerStatusHeartbeat({ katoDir: options.katoDir });
  }

  const app = new App<State>();

  app.use(async (ctx) => {
    try {
      return await ctx.next();
    } catch (error) {
      try {
        await logUnhandledWebRequestError(ctx.req, error, {
          katoDir: options.katoDir,
        });
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
    ctx.state.pathname = new URL(ctx.req.url).pathname;
    return await ctx.next();
  });

  app.use(async (ctx) => {
    const pathname = new URL(ctx.req.url).pathname;
    if (
      pathname.startsWith("/_fresh/") ||
      pathname === "/login"
    ) {
      const { config } = await loadWebConfigState({ katoDir: options.katoDir });
      ctx.state.authenticated = pathname === "/login"
        ? await isAuthenticatedRequest(ctx.req, config)
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

    const { config: webConfig, error } = await loadWebConfigState({
      katoDir: options.katoDir,
    });
    const authenticated = await isAuthenticatedRequest(ctx.req, webConfig);
    ctx.state.authenticated = authenticated;
    ctx.state.csrfToken = authenticated && webConfig
      ? await createCsrfToken(ctx.req, webConfig)
      : undefined;

    if (!webConfig) {
      if (error) {
        console.error("Kato Web config load failed", error);
      }
      return new Response(
        WEB_CONFIG_ERROR_MESSAGE,
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
      return Response.json({ error: "authentication required" }, {
        status: 401,
      });
    }

    return Response.redirect(new URL("/login", ctx.req.url), 302);
  });

  app.fsRoutes();
  return app;
}
