import { formatWorkspaceLabel } from "@kato/shared";
import { Head } from "fresh/runtime";
import AppHeader from "../../../src/app_header.tsx";
import { loadAppChromeStatus } from "../../../src/loaders/status.ts";
import {
  loadWorkspaceConfigEditPageData,
  type WorkspaceConfigEditDiagnostics,
} from "../../../src/loaders/workspace_config_edit.ts";
import { handleWorkspaceConfigEditPost } from "../../../src/workspace_config_edit_actions.ts";
import {
  WORKSPACE_MARKDOWN_FRONTMATTER_EDIT_FIELDS,
  WORKSPACE_WRITER_FEATURE_FLAG_EDIT_FIELDS,
} from "../../../src/workspace_config_edit_fields.ts";
import { define } from "../../../utils.ts";

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

function renderDiagnostics(diagnostics: WorkspaceConfigEditDiagnostics) {
  return (
    <article class="card span-4">
      <h2>Wikilink Diagnostics</h2>
      {diagnostics.wikilinkContextMode
        ? (
          <div class="workspace-config-diagnostics">
            <div>
              <span class="form-label">Scope</span>
              <div class="mono">
                {diagnostics.wikilinkContextMode === "dendron-config"
                  ? "dendron config"
                  : "output dir fallback"}
              </div>
            </div>
            {diagnostics.dendronConfigPath
              ? (
                <div>
                  <span class="form-label">Dendron Config</span>
                  <div class="mono workspace-config-path">
                    {diagnostics.dendronConfigPath}
                  </div>
                </div>
              )
              : null}
            {diagnostics.wikilinkifiableRoots &&
                diagnostics.wikilinkifiableRoots.length > 0
              ? (
                <div>
                  <span class="form-label">Roots</span>
                  <ul class="provider-list workspace-config-roots">
                    {diagnostics.wikilinkifiableRoots.map((root) => (
                      <li key={root} class="mono">{root}</li>
                    ))}
                  </ul>
                </div>
              )
              : null}
          </div>
        )
        : <p class="muted">No wikilink diagnostics available.</p>}
    </article>
  );
}

export const handler = define.handlers({
  async POST(ctx) {
    return await handleWorkspaceConfigEditPost(
      ctx.req,
      ctx.params.workspaceId ?? "",
    );
  },
});

export default define.page(async function WorkspaceConfigEditPage(ctx) {
  const selector = ctx.params.workspaceId ?? "";
  const [pageData, appStatus] = await Promise.all([
    loadWorkspaceConfigEditPageData(selector),
    loadAppChromeStatus(),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));

  if (!pageData) {
    return (
      <>
        <Head>
          <title>Kato Web · Workspace Config</title>
        </Head>
        <div class="shell">
          <AppHeader
            title="Workspace Config"
            description="Shared workspace config editor."
            currentPath="/workspaces"
            showLogout
            csrfToken={ctx.state.csrfToken}
            appStatus={appStatus}
          />
          <p class="notice-banner danger">workspace not found: {selector}</p>
          <a class="secondary-button" href="/workspaces">Back</a>
        </div>
      </>
    );
  }

  const workspaceLabel = formatWorkspaceLabel(
    pageData.workspace.alias,
    pageData.workspace.displayName,
  );
  const effective = pageData.effective;

  return (
    <>
      <Head>
        <title>Kato Web · Workspace Config</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Workspace Config"
          description={`Shared .kato-workspace-config.yaml settings for ${workspaceLabel}.`}
          currentPath="/workspaces"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}

        <section class="grid">
          <article class="card span-8">
            <div class="page-toolbar">
              <div>
                <h2>{workspaceLabel}</h2>
                <p class="page-toolbar-summary muted mono">
                  {pageData.workspace.workspaceId}
                </p>
              </div>
              <div class="page-actions">
                <a class="secondary-button" href="/workspaces">Back</a>
              </div>
            </div>
            <div class="workspace-config-meta">
              <div>
                <span class="form-label">Workspace Root</span>
                <div class="mono workspace-config-path">
                  {pageData.workspace.workspaceRoot}
                </div>
              </div>
              <div>
                <span class="form-label">Config Path</span>
                <div class="mono workspace-config-path">
                  {pageData.workspace.configPath}
                </div>
              </div>
            </div>
          </article>

          {renderDiagnostics(pageData.diagnostics)}

          {pageData.configError
            ? (
              <article class="card span-12">
                <h2>Config Error</h2>
                <p class="danger">{pageData.configError}</p>
              </article>
            )
            : effective
            ? (
              <article class="card span-12">
                <form method="post" class="workspace-config-form">
                  <input
                    type="hidden"
                    name="action"
                    value="save-workspace-config"
                  />
                  <input
                    type="hidden"
                    name="csrfToken"
                    value={ctx.state.csrfToken ?? ""}
                  />

                  <section class="workspace-config-layout">
                    <div class="workspace-config-section">
                      <h2>Output</h2>
                      <label class="checkbox-line">
                        <input
                          type="checkbox"
                          name="autoRecordConversations"
                          checked={Boolean(effective.autoRecordConversations)}
                        />
                        <span>Auto-record conversations</span>
                      </label>
                      <label class="form-label" for="defaultOutputDir">
                        Default Output Dir
                      </label>
                      <input
                        class="form-input mono"
                        id="defaultOutputDir"
                        name="defaultOutputDir"
                        type="text"
                        value={effective.defaultOutputDir}
                        required
                      />
                      <label class="form-label" for="filenameTemplate">
                        Filename Template
                      </label>
                      <input
                        class="form-input mono"
                        id="filenameTemplate"
                        name="filenameTemplate"
                        type="text"
                        value={effective.filenameTemplate}
                        required
                      />
                      <label class="form-label" for="workspaceTimezone">
                        Workspace Timezone
                      </label>
                      <input
                        class="form-input mono"
                        id="workspaceTimezone"
                        name="workspaceTimezone"
                        type="text"
                        value={effective.workspaceTimezone}
                        required
                      />
                      <label class="form-label" for="defaultTags">
                        Default Tags
                      </label>
                      <textarea
                        class="form-input mono workspace-config-tag-field"
                        id="defaultTags"
                        name="defaultTags"
                        rows={4}
                      >
                        {effective.defaultTags.join("\n")}
                      </textarea>
                      <label class="form-label" for="tagSuggestions">
                        Tag Suggestions
                      </label>
                      <textarea
                        class="form-input mono workspace-config-tag-field"
                        id="tagSuggestions"
                        name="tagSuggestions"
                        rows={4}
                      >
                        {effective.tagSuggestions.join("\n")}
                      </textarea>
                    </div>

                    <fieldset class="workspace-config-fieldset">
                      <legend>Markdown Frontmatter</legend>
                      <div class="workspace-config-toggle-grid">
                        {WORKSPACE_MARKDOWN_FRONTMATTER_EDIT_FIELDS.map((
                          field,
                        ) => (
                          <label class="checkbox-line" key={field.name}>
                            <input
                              type="checkbox"
                              name={field.name}
                              checked={Boolean(
                                effective.markdownFrontmatter[field.key],
                              )}
                            />
                            <span>{field.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset class="workspace-config-fieldset">
                      <legend>Writer Flags</legend>
                      <div class="workspace-config-toggle-grid">
                        {WORKSPACE_WRITER_FEATURE_FLAG_EDIT_FIELDS.map((
                          field,
                        ) => (
                          <label class="checkbox-line" key={field.name}>
                            <input
                              type="checkbox"
                              name={field.name}
                              checked={Boolean(
                                effective.writerFeatureFlags[field.key],
                              )}
                            />
                            <span>{field.label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </section>

                  <div class="workspace-config-actions">
                    <button class="form-button" type="submit">Save</button>
                    <a class="secondary-button" href="/workspaces">Cancel</a>
                  </div>
                </form>
              </article>
            )
            : null}
        </section>
      </div>
    </>
  );
});
