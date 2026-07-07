import { Head } from "fresh/runtime";
import MaintenanceTwinsLive from "../islands/MaintenanceTwinsLive.tsx";
import AppHeader from "../src/app_header.tsx";
import { loadMaintenanceTwinsData } from "../src/loaders/maintenance_twins.ts";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { createWebLoggers } from "../src/logging.ts";
import {
  buildMaintenanceHiddenFields,
  parseTwinsDays,
  resolveTwinsDaysParam,
} from "../src/maintenance_state.ts";
import { parseSessionPageQuery } from "../src/page_queries.ts";
import { buildMaintenanceHref } from "../src/session_routes.ts";
import { ingestPersistedSession } from "../src/session_ingestion.ts";
import { define } from "../utils.ts";
import { runMaintenanceClean } from "../../runtime/src/maintenance/clean.ts";
import {
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
} from "@kato/runtime";

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

function parseDeleteTwinMetadata(value: FormDataEntryValue | null): boolean {
  return value === "on";
}

function resolveDeleteTwinMetadataParam(raw: string | null): boolean {
  return raw === "true";
}

function requireConfirmation(
  form: FormData,
  fieldName: string,
  message: string,
): void {
  if (form.get(fieldName) !== "on") {
    throw new Error(message);
  }
}

function buildMaintenanceNotice(
  action: string,
  summary: string,
): string {
  switch (action) {
    case "logs-dry-run":
      return `Log truncation dry-run: ${summary}`;
    case "logs-execute":
      return `Log truncation executed: ${summary}`;
    case "twins-dry-run":
      return `Twin cleanup dry-run: ${summary}`;
    case "twins-execute":
      return `Twin cleanup executed: ${summary}`;
    default:
      return summary;
  }
}

function buildRedirectUrl(
  reqUrl: string,
  options: {
    notice?: string;
    error?: string;
    twinsDays?: number;
    deleteTwinMetadata?: boolean;
    includeStale?: boolean;
    workspaceFilter?: string;
  },
): URL {
  const url = new URL(
    buildMaintenanceHref({
      includeStale: options.includeStale,
      workspaceFilter: options.workspaceFilter,
    }),
    reqUrl,
  );
  if (options.notice) {
    url.searchParams.set("notice", options.notice);
  }
  if (options.error) {
    url.searchParams.set("error", options.error);
  }
  if (options.twinsDays !== undefined) {
    url.searchParams.set("twinsDays", String(options.twinsDays));
  }
  if (options.deleteTwinMetadata) {
    url.searchParams.set("deleteTwinMetadata", "true");
  }
  return url;
}

function buildMaintenanceTwinsEndpoint(options: {
  includeStale: boolean;
  workspaceFilter?: string;
}): string {
  const params = new URLSearchParams();
  if (!options.includeStale) {
    params.set("view", "active");
  }
  if (options.workspaceFilter) {
    params.set("workspace", options.workspaceFilter);
  }
  const query = params.toString();
  return query.length > 0
    ? `/api/maintenance-twins?${query}`
    : "/api/maintenance-twins";
}

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const includeStale = String(form.get("includeStale") ?? "true") !== "false";
    const workspaceFilter = String(form.get("workspaceFilter") ?? "").trim() ||
      undefined;
    const deleteTwinMetadata = parseDeleteTwinMetadata(
      form.get("deleteTwinMetadata"),
    );
    const { operationalLogger, auditLogger } = createWebLoggers();

    try {
      if (action === "logs-dry-run" || action === "logs-execute") {
        if (action === "logs-execute") {
          requireConfirmation(
            form,
            "confirmLogs",
            "Explicit confirmation is required before flushing logs.",
          );
        }
        const result = await runMaintenanceClean({
          all: true,
          dryRun: action === "logs-dry-run",
          operationalLogger,
          auditLogger,
          source: "web",
        });
        return Response.redirect(
          buildRedirectUrl(ctx.req.url, {
            notice: buildMaintenanceNotice(action, result.summary),
            twinsDays: resolveTwinsDaysParam(
              String(form.get("twinsDays") ?? ""),
            ),
            deleteTwinMetadata,
            includeStale,
            workspaceFilter,
          }),
          303,
        );
      }

      if (action === "twins-dry-run" || action === "twins-execute") {
        const twinsDays = parseTwinsDays(form.get("twinsDays"));
        if (action === "twins-execute") {
          requireConfirmation(
            form,
            "confirmTwins",
            "Explicit confirmation is required before deleting old twins.",
          );
        }
        const result = await runMaintenanceClean({
          all: false,
          dryRun: action === "twins-dry-run",
          twinsDays,
          deleteTwinMetadata,
          operationalLogger,
          auditLogger,
          source: "web",
        });
        return Response.redirect(
          buildRedirectUrl(ctx.req.url, {
            notice: buildMaintenanceNotice(action, result.summary),
            twinsDays,
            deleteTwinMetadata,
            includeStale,
            workspaceFilter,
          }),
          303,
        );
      }

      if (action === "twin-ingest") {
        const sessionId = String(form.get("sessionId") ?? "").trim();
        if (sessionId.length === 0) {
          throw new Error("Session id is required");
        }
        const result = await ingestPersistedSession({
          sessionId,
          operationalLogger,
          auditLogger,
        });
        const notice = result.appendedTwinEvents > 0
          ? `${result.twinAction} twin completed: ${result.provider} (${result.sessionShortId})`
          : result.parsedEvents > 0
          ? `${result.twinAction} twin already current: ${result.provider} (${result.sessionShortId})`
          : `no twin events found: ${result.provider} (${result.sessionShortId})`;
        return Response.redirect(
          buildRedirectUrl(ctx.req.url, {
            notice,
            twinsDays: resolveTwinsDaysParam(
              String(form.get("twinsDays") ?? ""),
            ),
            deleteTwinMetadata,
            includeStale,
            workspaceFilter,
          }),
          303,
        );
      }

      if (action === "twin-delete") {
        const sessionId = String(form.get("sessionId") ?? "").trim();
        if (sessionId.length === 0) {
          throw new Error("Session id is required");
        }
        const katoDir = resolveDefaultKatoDir();
        const sessionStore = new PersistentSessionStateStore({ katoDir });
        const metadata = (await sessionStore.listSessionMetadata()).find((
          entry,
        ) => entry.sessionId === sessionId);
        if (!metadata) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        await sessionStore.resetSessionTwinPersistence(metadata, {
          deleteTwinFile: true,
        });
        const attributes = {
          sessionId: metadata.sessionId,
          sessionShortId: metadata.sessionId.slice(0, 8),
          provider: metadata.provider,
          providerSessionId: metadata.providerSessionId,
          twinPath: metadata.twinPath,
        };
        await operationalLogger.info(
          "web.maintenance.twin.deleted",
          "Twin deleted from maintenance view",
          attributes,
        );
        await auditLogger.record(
          "web.maintenance.twin.deleted",
          "Twin deleted from maintenance view",
          attributes,
        );
        return Response.redirect(
          buildRedirectUrl(ctx.req.url, {
            notice: `deleted twin: ${metadata.provider} (${
              metadata.sessionId.slice(0, 8)
            })`,
            twinsDays: resolveTwinsDaysParam(
              String(form.get("twinsDays") ?? ""),
            ),
            deleteTwinMetadata,
            includeStale,
            workspaceFilter,
          }),
          303,
        );
      }

      return new Response("unsupported maintenance action", { status: 400 });
    } catch (error) {
      const twinsDays = Number.parseInt(
        String(form.get("twinsDays") ?? ""),
        10,
      );
      await operationalLogger.error(
        "web.maintenance.mutation.failed",
        "Maintenance mutation failed",
        {
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return Response.redirect(
        buildRedirectUrl(ctx.req.url, {
          error: error instanceof Error ? error.message : String(error),
          twinsDays: Number.isInteger(twinsDays) && twinsDays >= 0
            ? twinsDays
            : undefined,
          deleteTwinMetadata,
          includeStale,
          workspaceFilter,
        }),
        303,
      );
    }
  },
});

export default define.page(async function MaintenancePage(ctx) {
  const query = parseSessionPageQuery(ctx.url);
  const [appStatus, twinsData] = await Promise.all([
    loadAppChromeStatus(),
    loadMaintenanceTwinsData(query),
  ]);
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));
  const twinsDays = resolveTwinsDaysParam(
    ctx.url.searchParams.get("twinsDays"),
  );
  const deleteTwinMetadata = resolveDeleteTwinMetadataParam(
    ctx.url.searchParams.get("deleteTwinMetadata"),
  );

  return (
    <>
      <Head>
        <title>Kato Web · Maintenance</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Maintenance"
          description="Run guided cleanup for logs and old twins, and troubleshoot persisted twin state when cleanup or reconstruction is needed."
          currentPath="/maintenance"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner danger">{error}</p> : null}

        <section class="grid">
          <article class="card span-6">
            <h2>Logs</h2>
            <p class="muted">
              Truncates daemon, web, and exports log files on disk. Dry-run
              reports how many files would be truncated without changing them.
            </p>

            <form method="post" class="login-form">
              <input type="hidden" name="action" value="logs-dry-run" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              {buildMaintenanceHiddenFields({
                includeStale: query.includeStale,
                workspaceFilter: query.workspaceFilter,
                twinsDays,
                deleteTwinMetadata,
              }).map((field) => (
                <input
                  key={`logs-dry-run-${field.name}`}
                  type="hidden"
                  name={field.name}
                  value={field.value}
                />
              ))}
              <button class="secondary-button" type="submit">
                Dry-Run Log Truncation
              </button>
            </form>

            <form method="post" class="login-form inline-form">
              <input type="hidden" name="action" value="logs-execute" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              {buildMaintenanceHiddenFields({
                includeStale: query.includeStale,
                workspaceFilter: query.workspaceFilter,
                twinsDays,
                deleteTwinMetadata,
              }).map((field) => (
                <input
                  key={`logs-execute-${field.name}`}
                  type="hidden"
                  name={field.name}
                  value={field.value}
                />
              ))}
              <label class="checkbox-line">
                <input type="checkbox" name="confirmLogs" required />
                <span class="mono">
                  I understand this will truncate log files on disk now
                </span>
              </label>
              <button class="secondary-button danger-button" type="submit">
                Execute Log Truncation
              </button>
            </form>
          </article>

          <article class="card span-6">
            <h2>Twin Cleanup</h2>
            <p class="muted">
              Deletes persisted twin files older than the selected age in days
              and rewrites matching metadata to canonical no-twin state. Enter
              {" "}
              <span class="mono">0</span>{" "}
              to remove all twins. Provider source files remain untouched unless
              you explicitly opt into deleting twin metadata too.
            </p>

            <form method="post" class="login-form">
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <label class="form-label" for="twinsDays">
                Delete twins older than (days, 0 = all)
              </label>
              <input
                class="form-input"
                id="twinsDays"
                name="twinsDays"
                type="number"
                min="0"
                step="1"
                value={twinsDays}
                required
              />
              <button
                class="secondary-button"
                type="submit"
                name="action"
                value="twins-dry-run"
              >
                Dry-Run Twin Cleanup
              </button>
              <label class="checkbox-line">
                <input
                  type="checkbox"
                  name="deleteTwinMetadata"
                  checked={deleteTwinMetadata}
                />
                <span class="mono">Also delete twin metadata</span>
              </label>
              <label class="checkbox-line">
                <input type="checkbox" name="confirmTwins" />
                <span class="mono">
                  I understand this will delete old twins now
                </span>
              </label>
              <button
                class="secondary-button danger-button"
                type="submit"
                name="action"
                value="twins-execute"
              >
                Execute Twin Cleanup
              </button>
            </form>
          </article>

          <MaintenanceTwinsLive
            initialData={twinsData}
            endpoint={buildMaintenanceTwinsEndpoint(query)}
            csrfToken={ctx.state.csrfToken}
            twinsDays={twinsDays}
            deleteTwinMetadata={deleteTwinMetadata}
          />
        </section>
      </div>
    </>
  );
});
