import { registerWorkspace, unregisterWorkspace } from "@kato/runtime";
import { Head } from "fresh/runtime";
import AppHeader from "../src/app_header.tsx";
import {
  type ActivityState,
  activityStateDot,
  recordingActivityStateLabel,
} from "../src/loaders/activity_state.ts";
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

function recordingState(
  state: "engaged-active" | "engaged-stale" | "stopped",
): ActivityState {
  switch (state) {
    case "engaged-active":
      return "active";
    case "engaged-stale":
      return "stale";
    case "stopped":
      return "inactive";
  }
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

  return (
    <>
      <Head>
        <title>Kato Web · Workspaces</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Workspaces"
          description="Register, review, and remove workspace aliases, then inspect the recordings currently or historically writing into each workspace."
          currentPath="/workspaces"
          showLogout
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}

        <section class="grid">
          <article class="card span-5">
            <h2>Register Workspace</h2>
            <p class="muted">
              Workspace Path is required and must be an absolute path containing
              `.kato-workspace-config.yaml`. Alias is optional here. If you
              leave it blank, Kato will use the workspace folder name.
            </p>
            <form method="post" class="login-form">
              <input type="hidden" name="action" value="register" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <label class="form-label" for="alias">Alias</label>
              <input
                class="form-input"
                id="alias"
                name="alias"
                type="text"
                placeholder="defaults to workspace folder name"
              />
              <label class="form-label" for="workspacePath">
                Workspace Path
              </label>
              <input
                class="form-input"
                id="workspacePath"
                name="workspacePath"
                type="text"
                placeholder="/abs/path/to/workspace"
                required
              />
              <button class="form-button" type="submit">Register</button>
            </form>
          </article>

          <article class="card span-7">
            <h2>Write Root Coverage</h2>
            {pageData.sharedConfigError
              ? <p class="danger">{pageData.sharedConfigError}</p>
              : (
                <>
                  <p class="muted">
                    Registered workspaces are also checked against shared
                    `allowedWriteRoots`.
                  </p>
                  <ul class="provider-list">
                    {pageData.allowedWriteRoots.length === 0
                      ? <li class="muted">No shared write roots configured.</li>
                      : pageData.allowedWriteRoots.map((root) => (
                        <li key={root} class="mono">{root}</li>
                      ))}
                  </ul>
                </>
              )}
          </article>

          <article class="card span-12">
            <h2>Registered Workspaces</h2>
            {pageData.workspaceSummary.unavailableReason
              ? (
                <p class="danger">
                  {pageData.workspaceSummary.unavailableReason}
                </p>
              )
              : (
                <ul class="workspace-list">
                  {pageData.rows.length === 0
                    ? <li class="muted">No workspaces registered.</li>
                    : pageData.rows.map((row) => (
                      <li key={row.workspaceId} class="workspace-row">
                        <div
                          class="workspace-row-main"
                          id={`workspace-${row.workspaceId}`}
                        >
                          <div class="mono workspace-row-title">
                            {row.alias} ({row.workspaceId})
                          </div>
                          <div class="muted">{row.workspaceRoot}</div>
                          <div class="muted">{row.configPath}</div>
                          <div class="workspace-recording-summary mono">
                            recordings: {row.activeRecordingCount} active ·{" "}
                            {row.staleRecordingCount} idle ·{" "}
                            {row.stoppedRecordingCount} stopped
                          </div>
                          <div class="muted">
                            {row.latestRecordingAt
                              ? `Latest recording activity ${
                                new Date(
                                  row.latestRecordingAt,
                                ).toLocaleString()
                              }`
                              : "No recordings associated with this workspace yet."}
                          </div>
                          {row.recordings.length > 0
                            ? (
                              <ul class="recording-list workspace-recordings">
                                {row.recordings.map((recording) => {
                                  const uiState = recordingState(
                                    recording.state,
                                  );
                                  return (
                                    <li
                                      key={recording.key}
                                      class="recording-row"
                                    >
                                      <div class="recording-row-top">
                                        <div class="mono recording-state-line">
                                          <span
                                            class={`activity-state-dot ${uiState}`}
                                            aria-hidden="true"
                                          >
                                            {activityStateDot(uiState)}
                                          </span>
                                          <span>
                                            {recordingActivityStateLabel(
                                              uiState,
                                            )}
                                          </span>
                                        </div>
                                        <a
                                          class="mono workspace-session-link"
                                          href={recording.sessionLink}
                                        >
                                          {recording.provider}:{" "}
                                          {recording.sessionShortId}
                                        </a>
                                      </div>
                                      <div>
                                        {recording.snippet ?? "(no snippet)"}
                                      </div>
                                      <div class="mono recording-path">
                                        {recording.outputPath}
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            )
                            : null}
                        </div>
                        <div class="workspace-row-meta">
                          <div class={row.valid ? "ok mono" : "danger mono"}>
                            {row.valid
                              ? "config valid"
                              : row.invalidReason ?? "invalid"}
                          </div>
                          <div
                            class={row.writePathCovered === false
                              ? "danger mono"
                              : "muted mono"}
                          >
                            {row.writePathCovered === undefined
                              ? "write coverage unavailable"
                              : row.writePathCovered
                              ? "write root covered"
                              : "write root not covered"}
                          </div>
                          <a
                            class="secondary-button"
                            href={`/sessions?workspace=${
                              encodeURIComponent(row.workspaceId)
                            }`}
                          >
                            View Sessions
                          </a>
                          <form method="post">
                            <input
                              type="hidden"
                              name="action"
                              value="unregister"
                            />
                            <input
                              type="hidden"
                              name="csrfToken"
                              value={ctx.state.csrfToken ?? ""}
                            />
                            <input
                              type="hidden"
                              name="selector"
                              value={row.workspaceId}
                            />
                            <button
                              class="secondary-button danger-button"
                              type="submit"
                            >
                              Unregister
                            </button>
                          </form>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
          </article>
        </section>
      </div>
    </>
  );
});
