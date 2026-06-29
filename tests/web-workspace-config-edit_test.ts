import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  AuditLogger,
  loadWorkspaceConfigOverrides,
  NoopSink,
  resolveDefaultWorkspaceRegistryPath,
  StructuredLogger,
  WorkspaceRegistryFileStore,
} from "../apps/runtime/src/mod.ts";
import { loadWorkspaceConfigEditPageData } from "../apps/web/src/loaders/workspace_config_edit.ts";
import { handleWorkspaceConfigEditPost } from "../apps/web/src/workspace_config_edit_actions.ts";
import {
  WORKSPACE_MARKDOWN_FRONTMATTER_EDIT_FIELDS,
  WORKSPACE_WRITER_FEATURE_FLAG_EDIT_FIELDS,
} from "../apps/web/src/workspace_config_edit_fields.ts";
import { withTestTempDir } from "./test_temp.ts";

function makeNoopLoggers(): {
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
} {
  const operationalLogger = new StructuredLogger([new NoopSink()], {
    channel: "operational",
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([new NoopSink()], {
      channel: "security-audit",
    }),
  );
  return { operationalLogger, auditLogger };
}

async function setupWorkspaceFixture(
  homeDir: string,
  configLines: string[],
): Promise<{ katoDir: string; workspaceRoot: string; configPath: string }> {
  const katoDir = join(homeDir, ".kato");
  const workspaceRoot = join(homeDir, "alpha");
  const configPath = join(workspaceRoot, ".kato-workspace-config.yaml");
  await Deno.mkdir(join(katoDir, "shared"), { recursive: true });
  await Deno.mkdir(join(workspaceRoot, "notes"), { recursive: true });
  await Deno.writeTextFile(configPath, configLines.join("\n") + "\n");
  await new WorkspaceRegistryFileStore(
    resolveDefaultWorkspaceRegistryPath(katoDir),
  ).save([{
    workspaceId: "ws-alpha",
    alias: "alpha",
    displayName: "Alpha Workspace",
    workspaceRoot,
    configPath,
    registeredAt: "2026-03-07T15:00:00.000Z",
  }]);
  return { katoDir, workspaceRoot, configPath };
}

function setCheckboxes(
  form: FormData,
  values: Record<string, boolean>,
): void {
  for (
    const field of [
      ...WORKSPACE_MARKDOWN_FRONTMATTER_EDIT_FIELDS,
      ...WORKSPACE_WRITER_FEATURE_FLAG_EDIT_FIELDS,
    ]
  ) {
    if (values[field.name]) {
      form.set(field.name, "on");
    }
  }
}

function makeEditForm(options: {
  defaultOutputDir?: string;
  filenameTemplate?: string;
  workspaceTimezone?: string;
  defaultTags?: string;
  tagSuggestions?: string;
  checkboxValues?: Record<string, boolean>;
} = {}): FormData {
  const form = new FormData();
  form.set("action", "save-workspace-config");
  form.set("defaultOutputDir", options.defaultOutputDir ?? "notes");
  form.set(
    "filenameTemplate",
    options.filenameTemplate ?? "{provider}-{sessionShortId}.md",
  );
  form.set("workspaceTimezone", options.workspaceTimezone ?? "UTC");
  form.set("defaultTags", options.defaultTags ?? "");
  form.set("tagSuggestions", options.tagSuggestions ?? "");
  setCheckboxes(form, options.checkboxValues ?? {});
  return form;
}

Deno.test("loadWorkspaceConfigEditPageData exposes raw, effective, and wikilink diagnostics", async () => {
  await withTestTempDir(
    "web-workspace-config-edit-loader-",
    async (homeDir) => {
      const { katoDir, workspaceRoot } = await setupWorkspaceFixture(homeDir, [
        "workspaceId: ws-alpha",
        "defaultOutputDir: notes",
        'filenameTemplate: "{provider}.md"',
        'workspaceTimezone: "UTC"',
        "defaultTags:",
        "  - workspace",
        "  - research",
        "tagSuggestions:",
        "  - research",
        "  - journal",
        "markdownFrontmatter:",
        "  includeSessionIds: true",
        "workspaceFeatureFlags:",
        "  writerRelativizeLocalLinks: false",
        "  writerUseDendronStyleWikilinks: true",
      ]);
      await Deno.writeTextFile(
        join(workspaceRoot, "dendron.yml"),
        [
          "workspace:",
          "  vaults:",
          "    - fsPath: .",
          "      selfContained: true",
        ].join("\n") + "\n",
      );

      const data = await loadWorkspaceConfigEditPageData("alpha", { katoDir });

      assertExists(data);
      assertEquals(data.workspace.workspaceId, "ws-alpha");
      assertEquals(data.raw?.defaultOutputDir, "notes");
      assertEquals(data.raw?.workspaceTimezone, "UTC");
      assertEquals(data.raw?.defaultTags, ["workspace", "research"]);
      assertEquals(data.raw?.tagSuggestions, ["research", "journal"]);
      assertEquals(data.raw?.markdownFrontmatter?.includeSessionIds, true);
      assertEquals(
        data.raw?.writerFeatureFlags.writerRelativizeLocalLinks,
        false,
      );
      assertEquals(data.effective?.filenameTemplate, "{provider}.md");
      assertEquals(data.effective?.defaultTags, ["workspace", "research"]);
      assertEquals(data.effective?.tagSuggestions, ["research", "journal"]);
      assertEquals(
        data.effective?.markdownFrontmatter
          .includeFrontmatterInMarkdownRecordings,
        true,
      );
      assertEquals(
        data.effective?.writerFeatureFlags.writerIncludeCommentary,
        true,
      );
      assertEquals(
        data.effective?.writerFeatureFlags.writerUseDendronStyleWikilinks,
        true,
      );
      assertEquals(data.diagnostics.wikilinkContextMode, "dendron-config");
      assertEquals(
        data.diagnostics.dendronConfigPath,
        join(workspaceRoot, "dendron.yml"),
      );
      assertEquals(
        data.diagnostics.wikilinkifiableRoots?.includes(
          join(workspaceRoot, "notes"),
        ),
        true,
      );
    },
  );
});

Deno.test("loadWorkspaceConfigEditPageData returns invalid config errors as page data", async () => {
  await withTestTempDir(
    "web-workspace-config-edit-loader-invalid-",
    async (homeDir) => {
      const { katoDir } = await setupWorkspaceFixture(homeDir, [
        "workspaceId: ws-alpha",
        "featureFlags:",
        "  writerIncludeCommentary: true",
      ]);

      const data = await loadWorkspaceConfigEditPageData("ws-alpha", {
        katoDir,
      });

      assertExists(data);
      assertStringIncludes(
        data.configError ?? "",
        "Unsupported workspace config key 'featureFlags'",
      );
      assertEquals(data.effective, undefined);
    },
  );
});

Deno.test("handleWorkspaceConfigEditPost saves workspace config edits and redirects with notice", async () => {
  await withTestTempDir("web-workspace-config-edit-post-", async (homeDir) => {
    const { katoDir, configPath } = await setupWorkspaceFixture(homeDir, [
      "workspaceId: ws-alpha",
      "defaultOutputDir: notes",
      'filenameTemplate: "{provider}.md"',
    ]);
    const { operationalLogger, auditLogger } = makeNoopLoggers();
    const form = makeEditForm({
      defaultOutputDir: "notes/{provider}",
      filenameTemplate: "{YYYY}-{MM}-{DD}-{provider}.md",
      workspaceTimezone: "America/Los_Angeles",
      defaultTags: " workspace, research\nresearch ",
      tagSuggestions: "research\njournal",
      checkboxValues: {
        "markdownFrontmatter.includeFrontmatterInMarkdownRecordings": true,
        "markdownFrontmatter.includeWorkspaceIds": true,
        "workspaceFeatureFlags.writerIncludeCommentary": true,
        "workspaceFeatureFlags.writerRelativizeLocalLinks": true,
        "workspaceFeatureFlags.writerUseDendronStyleWikilinks": true,
      },
    });

    const response = await handleWorkspaceConfigEditPost(
      new Request("http://kato.local/workspaces/ws-alpha/edit", {
        method: "POST",
        body: form,
      }),
      "ws-alpha",
      { katoDir, operationalLogger, auditLogger },
    );

    assertEquals(response.status, 303);
    const location = response.headers.get("location");
    assertExists(location);
    const redirectUrl = new URL(location, "http://kato.local");
    assertEquals(redirectUrl.pathname, "/workspaces/ws-alpha/edit");
    assertStringIncludes(
      redirectUrl.searchParams.get("notice") ?? "",
      "workspace config saved",
    );

    const loaded = await loadWorkspaceConfigOverrides(configPath);
    assertEquals(loaded.defaultOutputDir, "notes/{provider}");
    assertEquals(loaded.filenameTemplate, "{YYYY}-{MM}-{DD}-{provider}.md");
    assertEquals(loaded.workspaceTimezone, "America/Los_Angeles");
    assertEquals(loaded.defaultTags, ["workspace", "research"]);
    assertEquals(loaded.tagSuggestions, ["research", "journal"]);
    assertEquals(loaded.markdownFrontmatter?.includeWorkspaceIds, true);
    assertEquals(loaded.markdownFrontmatter?.includeSessionIds, false);
    assertEquals(
      loaded.writerFeatureFlags.writerUseDendronStyleWikilinks,
      true,
    );
    assertEquals(loaded.writerFeatureFlags.writerIncludeThinking, false);
  });
});

Deno.test("handleWorkspaceConfigEditPost redirects with error and preserves config for invalid edits", async () => {
  await withTestTempDir(
    "web-workspace-config-edit-post-invalid-",
    async (homeDir) => {
      const { katoDir, configPath } = await setupWorkspaceFixture(homeDir, [
        "workspaceId: ws-alpha",
        "defaultOutputDir: notes",
        'filenameTemplate: "{provider}.md"',
      ]);
      const { operationalLogger, auditLogger } = makeNoopLoggers();
      const before = await Deno.readTextFile(configPath);

      const response = await handleWorkspaceConfigEditPost(
        new Request("http://kato.local/workspaces/ws-alpha/edit", {
          method: "POST",
          body: makeEditForm({
            filenameTemplate: "{timestampUtc}-{provider}.md",
          }),
        }),
        "ws-alpha",
        { katoDir, operationalLogger, auditLogger },
      );

      assertEquals(response.status, 303);
      const location = response.headers.get("location");
      assertExists(location);
      const redirectUrl = new URL(location, "http://kato.local");
      assertEquals(redirectUrl.pathname, "/workspaces/ws-alpha/edit");
      assertStringIncludes(
        redirectUrl.searchParams.get("error") ?? "",
        "filenameTemplate token '{timestampUtc}' is no longer supported",
      );
      assertEquals(await Deno.readTextFile(configPath), before);
    },
  );
});

Deno.test("handleWorkspaceConfigEditPost rejects unsupported actions", async () => {
  const form = new FormData();
  form.set("action", "unknown-action");

  const response = await handleWorkspaceConfigEditPost(
    new Request("http://kato.local/workspaces/ws-alpha/edit", {
      method: "POST",
      body: form,
    }),
    "ws-alpha",
  );

  assertEquals(response.status, 400);
});
