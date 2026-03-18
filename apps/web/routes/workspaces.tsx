import { formatWorkspaceLabel } from "@kato/shared";
import {
  deleteWorkspaceUsernameMapping,
  registerWorkspace,
  setWorkspaceDisplayName,
  setWorkspaceUsernameMapping,
  unregisterWorkspace,
} from "@kato/runtime";
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
        const rawDisplayName = String(form.get("displayName") ?? "").trim();
        const displayName = rawDisplayName.length > 0
          ? rawDisplayName
          : undefined;
        const workspacePath = String(form.get("workspacePath") ?? "");
        const result = await registerWorkspace({
          alias,
          displayName,
          workspacePath,
          operationalLogger,
          auditLogger,
        });
        const workspaceLabel = formatWorkspaceLabel(
          result.entry.alias,
          result.entry.displayName,
        );
        const notice = encodeURIComponent(
          result.created
            ? `workspace registered: ${workspaceLabel}`
            : result.changed
            ? `workspace registration updated: ${workspaceLabel}`
            : `workspace already registered: ${workspaceLabel}`,
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

      if (action === "save-display-name") {
        const selector = String(form.get("selector") ?? "");
        const displayName = String(form.get("displayName") ?? "");
        const result = await setWorkspaceDisplayName({
          selector,
          displayName,
          operationalLogger,
          auditLogger,
        });
        const workspaceLabel = formatWorkspaceLabel(
          result.entry.alias,
          result.entry.displayName,
        );
        const notice = encodeURIComponent(
          result.changed
            ? result.entry.displayName
              ? `workspace label saved: ${workspaceLabel}`
              : `workspace label cleared: ${result.entry.alias}`
            : `workspace label unchanged: ${workspaceLabel}`,
        );
        return Response.redirect(
          new URL(`/workspaces?notice=${notice}`, ctx.req.url),
          303,
        );
      }

      if (action === "save-workspace-username") {
        const selector = String(form.get("selector") ?? "");
        const username = String(form.get("username") ?? "").trim();
        if (username.length === 0) {
          const result = await deleteWorkspaceUsernameMapping({
            selector,
            operationalLogger,
            auditLogger,
          });
          const notice = encodeURIComponent(
            result.deleted
              ? `workspace username cleared: ${result.workspaceAlias}`
              : `workspace username already absent: ${result.workspaceAlias}`,
          );
          return Response.redirect(
            new URL(`/workspaces?notice=${notice}`, ctx.req.url),
            303,
          );
        }

        const result = await setWorkspaceUsernameMapping({
          selector,
          username,
          operationalLogger,
          auditLogger,
        });
        const notice = encodeURIComponent(
          `workspace username saved: ${result.workspaceAlias} -> ${result.username}`,
        );
        return Response.redirect(
          new URL(`/workspaces?notice=${notice}`, ctx.req.url),
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
          description="Register, label, and review workspace destinations, then set a preferred username override for each workspace when needed."
          currentPath="/workspaces"
          showLogout
          csrfToken={ctx.state.csrfToken}
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
                  <label class="form-label" for="displayName">
                    Display Label
                  </label>
                  <input
                    class="form-input"
                    id="displayName"
                    name="displayName"
                    type="text"
                    placeholder="optional operator-facing label"
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
                <p>
                  Display Label is optional. If you leave it blank, Kato shows
                  the alias alone.
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
