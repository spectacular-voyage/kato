import { registerWorkspace, unregisterWorkspace } from "@kato/runtime";
import { Head } from "fresh/runtime";
import WorkspacesLive from "../islands/WorkspacesLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { loadWorkspacesPageData } from "../src/loaders/workspaces.ts";
import { createWebLoggers } from "../src/logging.ts";
import { define } from "../utils.ts";

function decodeMessage(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function workspacePathPlaceholder(): string {
  return Deno.build.os === "windows"
    ? "C:\\abs\\path\\to\\workspace"
    : "/abs/path/to/workspace";
}

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const { operationalLogger, auditLogger } = createWebLoggers();

    try {
      if (action === "register") {
        const alias = String(form.get("alias") ?? "");
        const workspacePath = String(form.get("workspacePath") ?? "");
        const result = await registerWorkspace({
          alias,
          workspacePath,
          operationalLogger,
          auditLogger,
        });
        const notice = encodeURIComponent(
          result.created
            ? `workspace registered: ${result.entry.alias}`
            : result.changed
            ? `workspace registration updated: ${result.entry.alias}`
            : `workspace already registered: ${result.entry.alias}`,
        );
        return Response.redirect(
          new URL(`/workspaces?notice=${notice}`, ctx.req.url),
          303,
        );
      }

      if (action === "unregister") {
        const selector = String(form.get("selector") ?? "");
        const result = await unregisterWorkspace({
          selector,
          operationalLogger,
          auditLogger,
        });
        return Response.redirect(
          new URL(
            `/workspaces?notice=${
              encodeURIComponent(
                `workspace unregistered: ${result.entry.alias}`,
              )
            }`,
            ctx.req.url,
          ),
          303,
        );
      }

      return new Response("unsupported workspace action", { status: 400 });
    } catch (error) {
      await operationalLogger.error(
        "web.workspaces.mutation.failed",
        "Workspace mutation failed",
        {
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      const message = error instanceof Error ? error.message : String(error);
      return Response.redirect(
        new URL(
          `/workspaces?error=${encodeURIComponent(message)}`,
          ctx.req.url,
        ),
        303,
      );
    }
  },
});

export default define.page(async function WorkspacesPage(ctx) {
  const [pageData, appStatus] = await Promise.all([
    loadWorkspacesPageData(),
    loadAppChromeStatus(),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));
  const workspacePathSample = workspacePathPlaceholder();

  return (
    <>
      <Head>
        <title>Kato Web · Workspaces</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Workspaces"
          description="Register, review, and remove workspace aliases, then inspect the latest recording per destination writing into each workspace."
          currentPath="/workspaces"
          showLogout
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}

        <section class="grid">
          <article class="card span-12">
            <div class="card-split">
              <div>
                <h2>Register Workspace</h2>
                <form method="post" class="login-form register-workspace-form">
                  <input type="hidden" name="action" value="register" />
                  <input
                    type="hidden"
                    name="csrfToken"
                    value={ctx.state.csrfToken ?? ""}
                  />
                  <label class="form-label" for="workspacePath">
                    Workspace Path{" "}
                    <span class="required-indicator" aria-hidden="true">*</span>
                  </label>
                  <input
                    class="form-input"
                    id="workspacePath"
                    name="workspacePath"
                    type="text"
                    placeholder={workspacePathSample}
                    required
                  />
                  <label class="form-label" for="alias">Alias</label>
                  <input
                    class="form-input"
                    id="alias"
                    name="alias"
                    type="text"
                    placeholder="defaults to workspace folder name"
                  />
                  <button class="form-button" type="submit">Register</button>
                </form>
              </div>
              <div class="card-split-aside muted">
                <p>
                  Registration will extend shared `allowedWriteRoots` when
                  needed.
                </p>
                <p>
                  Workspace Path must be an absolute path containing
                  `.kato-workspace-config.yaml`.
                </p>
                <p>
                  Alias is optional. If you leave it blank, Kato uses the
                  workspace folder name.
                </p>
              </div>
            </div>
          </article>
        </section>

        <WorkspacesLive
          initialData={pageData}
          endpoint="/api/workspaces"
          csrfToken={ctx.state.csrfToken}
        />
      </div>
    </>
  );
});
