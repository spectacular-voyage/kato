import type {
  MarkdownFrontmatterConfig,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
} from "@kato/shared";
import type { AuditLogger, StructuredLogger } from "@kato/runtime";
import { updateWorkspaceConfig } from "@kato/runtime";
import { createWebLoggers } from "./logging.ts";
import {
  WORKSPACE_MARKDOWN_FRONTMATTER_EDIT_FIELDS,
  WORKSPACE_WRITER_FEATURE_FLAG_EDIT_FIELDS,
} from "./workspace_config_edit_fields.ts";
import { buildWorkspaceConfigEditHref } from "./workspace_routes.ts";

export interface HandleWorkspaceConfigEditPostOptions {
  katoDir?: string;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

function readRequiredTextField(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string") {
    throw new Error(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function readCheckboxField(form: FormData, name: string): boolean {
  const value = form.get(name);
  if (value === null) {
    return false;
  }
  if (value === "on") {
    return true;
  }
  throw new Error(`${name} must be a checkbox value`);
}

function buildRedirectUrl(
  reqUrl: string,
  selector: string,
  options: { notice?: string; error?: string },
): URL {
  const url = new URL(buildWorkspaceConfigEditHref(selector), reqUrl);
  if (options.notice) {
    url.searchParams.set("notice", options.notice);
  }
  if (options.error) {
    url.searchParams.set("error", options.error);
  }
  return url;
}

function buildEditInput(form: FormData) {
  const markdownFrontmatter: Partial<MarkdownFrontmatterConfig> = {};
  for (const field of WORKSPACE_MARKDOWN_FRONTMATTER_EDIT_FIELDS) {
    markdownFrontmatter[field.key] = readCheckboxField(form, field.name);
  }

  const writerFeatureFlags: Partial<
    SessionWorkspaceAttachmentWriterFeatureFlagsV1
  > = {};
  for (const field of WORKSPACE_WRITER_FEATURE_FLAG_EDIT_FIELDS) {
    writerFeatureFlags[field.key] = readCheckboxField(form, field.name);
  }

  return {
    defaultOutputDir: readRequiredTextField(form, "defaultOutputDir"),
    filenameTemplate: readRequiredTextField(form, "filenameTemplate"),
    workspaceTimezone: readRequiredTextField(form, "workspaceTimezone"),
    markdownFrontmatter,
    writerFeatureFlags,
  };
}

export async function handleWorkspaceConfigEditPost(
  req: Request,
  selector: string,
  options: HandleWorkspaceConfigEditPostOptions = {},
): Promise<Response> {
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  if (action !== "save-workspace-config") {
    return new Response("unsupported workspace config action", { status: 400 });
  }

  const defaultLoggers = options.operationalLogger && options.auditLogger
    ? undefined
    : createWebLoggers({ katoDir: options.katoDir });
  const operationalLogger = options.operationalLogger ??
    defaultLoggers?.operationalLogger;
  const auditLogger = options.auditLogger ?? defaultLoggers?.auditLogger;
  if (!operationalLogger || !auditLogger) {
    throw new Error("Workspace config edit loggers were not initialized");
  }

  try {
    const result = await updateWorkspaceConfig({
      selector,
      edits: buildEditInput(form),
      katoDir: options.katoDir,
      operationalLogger,
      auditLogger,
    });
    const notice = result.changed
      ? `workspace config saved: ${result.entry.alias}`
      : `workspace config unchanged: ${result.entry.alias}`;
    return Response.redirect(
      buildRedirectUrl(req.url, result.entry.workspaceId, { notice }),
      303,
    );
  } catch (error) {
    await operationalLogger.error(
      "web.workspace-config.mutation.failed",
      "Workspace config mutation failed",
      {
        selector,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    const message = error instanceof Error ? error.message : String(error);
    return Response.redirect(
      buildRedirectUrl(req.url, selector, { error: message }),
      303,
    );
  }
}
