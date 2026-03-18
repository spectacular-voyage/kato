import { formatWorkspaceLabel } from "@kato/shared";
import {
  clearDefaultUsername,
  deleteWorkspaceUsernameMapping,
  setDefaultUsername,
  setExcludeMeFromParticipantList,
  setWorkspaceUsernameMapping,
} from "@kato/runtime";
import { Head } from "fresh/runtime";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { loadSettingsPageData } from "../src/loaders/settings.ts";
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

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const { operationalLogger, auditLogger } = createWebLoggers();

    try {
      if (action === "set-default") {
        const username = String(form.get("username") ?? "");
        const result = await setDefaultUsername({
          username,
          operationalLogger,
          auditLogger,
        });
        return Response.redirect(
          new URL(
            `/settings?notice=${
              encodeURIComponent(
                `default username set: ${result.username}`,
              )
            }`,
            ctx.req.url,
          ),
          303,
        );
      }

      if (action === "clear-default") {
        await clearDefaultUsername({ operationalLogger, auditLogger });
        return Response.redirect(
          new URL(
            `/settings?notice=${
              encodeURIComponent("default username cleared")
            }`,
            ctx.req.url,
          ),
          303,
        );
      }

      if (action === "set-exclude-me") {
        const value = form.get("excludeMeFromParticipantList") === "on";
        const result = await setExcludeMeFromParticipantList({
          value,
          operationalLogger,
          auditLogger,
        });
        return Response.redirect(
          new URL(
            `/settings?notice=${
              encodeURIComponent(
                `excludeMeFromParticipantList set to ${result.value}`,
              )
            }`,
            ctx.req.url,
          ),
          303,
        );
      }

      if (action === "set-mapping") {
        const selector = String(form.get("selector") ?? "");
        const username = String(form.get("username") ?? "");
        const result = await setWorkspaceUsernameMapping({
          selector,
          username,
          operationalLogger,
          auditLogger,
        });
        return Response.redirect(
          new URL(
            `/settings?notice=${
              encodeURIComponent(
                `user mapping set: ${result.workspaceAlias} -> ${result.username}`,
              )
            }`,
            ctx.req.url,
          ),
          303,
        );
      }

      if (action === "delete-mapping") {
        const selector = String(form.get("selector") ?? "");
        const result = await deleteWorkspaceUsernameMapping({
          selector,
          operationalLogger,
          auditLogger,
        });
        return Response.redirect(
          new URL(
            `/settings?notice=${
              encodeURIComponent(
                result.deleted
                  ? `user mapping deleted: ${result.workspaceAlias}`
                  : `user mapping already absent: ${result.workspaceAlias}`,
              )
            }`,
            ctx.req.url,
          ),
          303,
        );
      }

      return new Response("unsupported settings action", { status: 400 });
    } catch (error) {
      await operationalLogger.error(
        "web.settings.mutation.failed",
        "Settings mutation failed",
        {
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      const message = error instanceof Error ? error.message : String(error);
      return Response.redirect(
        new URL(
          `/settings?error=${encodeURIComponent(message)}`,
          ctx.req.url,
        ),
        303,
      );
    }
  },
});

export default define.page(async function SettingsPage(ctx) {
  const [pageData, appStatus] = await Promise.all([
    loadSettingsPageData(),
    loadAppChromeStatus(),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));

  return (
    <>
      <Head>
        <title>Kato Web · Settings</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Settings"
          description="Manage participant defaults, exclude-me behavior, and workspace username mappings."
          currentPath="/settings"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}

        <section class="grid">
          <article class="card span-5">
            <h2>Default Username</h2>
            <p class="muted">
              Current:{" "}
              <span class="mono">
                {pageData.config.participants.defaultUsername || "(unset)"}
              </span>
            </p>
            <form method="post" class="login-form">
              <input type="hidden" name="action" value="set-default" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <label class="form-label" for="defaultUsername">Username</label>
              <input
                class="form-input"
                id="defaultUsername"
                name="username"
                type="text"
                defaultValue={pageData.config.participants.defaultUsername}
                required
              />
              <button class="form-button" type="submit">Save Default</button>
            </form>
            <form method="post" class="inline-form">
              <input type="hidden" name="action" value="clear-default" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <button class="secondary-button" type="submit">
                Clear Default
              </button>
            </form>
          </article>

          <article class="card span-7">
            <h2>Exclude Me</h2>
            <p class="muted">
              Controls whether the current user is removed from participant
              lists during export and rendering.
            </p>
            <form method="post" class="login-form">
              <input type="hidden" name="action" value="set-exclude-me" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <label class="checkbox-line">
                <input
                  type="checkbox"
                  name="excludeMeFromParticipantList"
                  checked={pageData.config.participants
                    .excludeMeFromParticipantList}
                />
                <span class="mono">Exclude me from participant list</span>
              </label>
              <button class="form-button" type="submit">Save Setting</button>
            </form>
          </article>

          <article class="card span-5">
            <h2>Workspace Mapping</h2>
            <p class="muted">
              Map a registered workspace to a participant username override.
            </p>
            <form method="post" class="login-form">
              <input type="hidden" name="action" value="set-mapping" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <label class="form-label" for="workspaceSelector">
                Workspace
              </label>
              <select
                class="form-input"
                id="workspaceSelector"
                name="selector"
                required
              >
                <option value="">Select a workspace</option>
                {pageData.workspaces.map((workspace) => (
                  <option
                    key={workspace.workspaceId}
                    value={workspace.workspaceId}
                  >
                    {formatWorkspaceLabel(
                      workspace.alias,
                      workspace.displayName,
                    )} ({workspace.workspaceId})
                  </option>
                ))}
              </select>
              <label class="form-label" for="mappingUsername">Username</label>
              <input
                class="form-input"
                id="mappingUsername"
                name="username"
                type="text"
                required
              />
              <button class="form-button" type="submit">Save Mapping</button>
            </form>
          </article>

          <article class="card span-7">
            <h2>Workspace Username Mappings</h2>
            <ul class="workspace-list">
              {pageData.mappings.length === 0
                ? <li class="muted">No workspace username mappings.</li>
                : pageData.mappings.map((mapping) => (
                  <li key={mapping.workspaceId} class="workspace-row">
                    <div class="workspace-row-main">
                      <div class="mono workspace-row-title">
                        {mapping.workspaceAlias
                          ? formatWorkspaceLabel(
                            mapping.workspaceAlias,
                            mapping.workspaceDisplayName,
                          )
                          : "<unregistered>"} ({mapping.workspaceId})
                      </div>
                      <div class="muted">{mapping.username}</div>
                    </div>
                    <div class="workspace-row-meta">
                      <form method="post">
                        <input
                          type="hidden"
                          name="action"
                          value="delete-mapping"
                        />
                        <input
                          type="hidden"
                          name="csrfToken"
                          value={ctx.state.csrfToken ?? ""}
                        />
                        <input
                          type="hidden"
                          name="selector"
                          value={mapping.workspaceId}
                        />
                        <button
                          class="secondary-button danger-button"
                          type="submit"
                        >
                          Delete Mapping
                        </button>
                      </form>
                    </div>
                  </li>
                ))}
            </ul>
          </article>
        </section>
      </div>
    </>
  );
});
