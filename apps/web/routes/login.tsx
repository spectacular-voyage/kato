import {
  loadWebConfigState,
  setSessionCookie,
  verifyPassword,
} from "../src/auth.ts";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { define } from "../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const { config, error } = await loadWebConfigState();
    if (!config) {
      return new Response(
        error
          ? `Kato Web config is invalid: ${error}\nRe-run \`kato web init --username <username> --password <password>\` with a fresh config.`
          : "Kato Web is unconfigured. Run `kato web init --username <username> --password <password>` first.",
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
    await setSessionCookie(headers, config);
    headers.set("location", "/");
    return new Response(null, { status: 302, headers });
  },
});

export default define.page(async function LoginPage(ctx) {
  const error = ctx.url.searchParams.get("error") === "1";
  const appStatus = await loadAppChromeStatus();

  return (
    <div class="shell">
      <AppHeader
        title="Login"
        description="Authenticate to access conversation data and operator state."
        showLogout
        appStatus={appStatus}
      />

      <section class="grid">
        <article class="card span-5">
          <h2>Sign In</h2>
          {error ? <p class="danger">Invalid username or password.</p> : null}
          <form method="post" class="login-form">
            <label class="form-label" for="username">Username</label>
            <input
              class="form-input"
              id="username"
              name="username"
              type="text"
              required
            />
            <label class="form-label" for="password">Password</label>
            <input
              class="form-input"
              id="password"
              name="password"
              type="password"
              required
            />
            <button class="form-button" type="submit">Sign In</button>
          </form>
        </article>
      </section>
    </div>
  );
});
