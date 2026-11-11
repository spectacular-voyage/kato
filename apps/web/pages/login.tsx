import {
  loadWebConfigState,
  setSessionCookie,
  verifyPassword,
} from "../src/auth.ts";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import type { RouteContext } from "../src/route_context.ts";
import type { PageResult } from "./page.ts";

const WEB_CONFIG_ERROR_MESSAGE =
  "Kato Web is unconfigured. Run `kato web init --username <username>` in an interactive terminal, or provide `KATO_WEB_PASSWORD` / `--password-stdin`.";

export async function POST(ctx: RouteContext): Promise<Response> {
  const { config, error } = await loadWebConfigState();
  if (!config) {
    if (error) {
      console.error("Kato Web login config load failed", error);
    }
    return new Response(
      WEB_CONFIG_ERROR_MESSAGE,
      { status: 503 },
    );
  }

  const form = await ctx.req.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const valid = await verifyPassword(config, username, password);
  if (!valid) {
    return Response.redirect(new URL("/login?error=1", ctx.req.url), 302);
  }

  const headers = new Headers();
  await setSessionCookie(headers, ctx.req, config);
  headers.set("location", "/");
  return new Response(null, { status: 302, headers });
}

export function LoginForm({ error }: { error: boolean }) {
  return (
    <>
      <h2>Sign In</h2>
      {error ? <p class="danger">Invalid username or password.</p> : null}
      <form method="post" class="login-form">
        <label class="form-label" for="username">Username</label>
        <input
          class="form-input"
          id="username"
          name="username"
          type="text"
          autocomplete="username"
          autofocus
          required
        />
        <label class="form-label" for="password">Password</label>
        <input
          class="form-input"
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
        />
        <button class="form-button" type="submit">Sign In</button>
      </form>
    </>
  );
}

export async function page(ctx: RouteContext): Promise<PageResult> {
  const error = ctx.url.searchParams.get("error") === "1";
  const appStatus = await loadAppChromeStatus();

  return {
    body: (
      <div class="shell">
        <AppHeader
          title="Login"
          description="Authenticate to access conversation data and operator state."
          showLogout
          showBrandLogo={false}
          csrfToken={ctx.state.csrfToken}
          liveAppStatus={false}
          appStatus={appStatus}
        />

        <section class="grid login-grid">
          <article class="card login-card">
            <LoginForm error={error} />
          </article>
        </section>
      </div>
    ),
  };
}
