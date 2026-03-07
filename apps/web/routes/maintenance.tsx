import { Head } from "fresh/runtime";
import AppHeader from "../src/app_header.tsx";
import { loadAppChromeStatus } from "../src/loaders/status.ts";
import { createWebLoggers } from "../src/logging.ts";
import { define } from "../utils.ts";
import { runMaintenanceClean } from "../../runtime/src/maintenance/clean.ts";

const DEFAULT_SESSIONS_DAYS = 30;

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

function parseSessionsDays(value: FormDataEntryValue | null): number {
  const raw = String(value ?? "").trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Session cleanup days must be a positive integer");
  }
  return parsed;
}

function resolveSessionsDaysParam(raw: string | null): number {
  const parsed = Number(raw ?? "");
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_SESSIONS_DAYS;
  }
  return parsed;
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
    case "sessions-dry-run":
      return `Session cleanup dry-run: ${summary}`;
    case "sessions-execute":
      return `Session cleanup executed: ${summary}`;
    default:
      return summary;
  }
}

function buildRedirectUrl(
  reqUrl: string,
  options: {
    notice?: string;
    error?: string;
    sessionsDays?: number;
  },
): URL {
  const url = new URL("/maintenance", reqUrl);
  if (options.notice) {
    url.searchParams.set("notice", options.notice);
  }
  if (options.error) {
    url.searchParams.set("error", options.error);
  }
  if (options.sessionsDays !== undefined) {
    url.searchParams.set("sessionsDays", String(options.sessionsDays));
  }
  return url;
}

export const handler = define.handlers({
  async POST(ctx) {
    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
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
          }),
          303,
        );
      }

      if (action === "sessions-dry-run" || action === "sessions-execute") {
        const sessionsDays = parseSessionsDays(form.get("sessionsDays"));
        if (action === "sessions-execute") {
          requireConfirmation(
            form,
            "confirmSessions",
            "Explicit confirmation is required before deleting old session artifacts.",
          );
        }
        const result = await runMaintenanceClean({
          all: false,
          dryRun: action === "sessions-dry-run",
          sessionsDays,
          operationalLogger,
          auditLogger,
          source: "web",
        });
        return Response.redirect(
          buildRedirectUrl(ctx.req.url, {
            notice: buildMaintenanceNotice(action, result.summary),
            sessionsDays,
          }),
          303,
        );
      }

      return new Response("unsupported maintenance action", { status: 400 });
    } catch (error) {
      const sessionsDays = Number.parseInt(
        String(form.get("sessionsDays") ?? ""),
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
          sessionsDays: Number.isInteger(sessionsDays) && sessionsDays > 0
            ? sessionsDays
            : undefined,
        }),
        303,
      );
    }
  },
});

export default define.page(async function MaintenancePage(ctx) {
  const appStatus = await loadAppChromeStatus();
  const notice = decodeMessage(ctx.url.searchParams.get("notice"));
  const error = decodeMessage(ctx.url.searchParams.get("error"));
  const sessionsDays = resolveSessionsDaysParam(
    ctx.url.searchParams.get("sessionsDays"),
  );

  return (
    <>
      <Head>
        <title>Kato Web · Maintenance</title>
      </Head>
      <div class="shell">
        <AppHeader
          title="Maintenance"
          description="Run guided truncation for daemon, web, and exports logs on disk, plus cleanup for old derived session artifacts. Dry-run first, then execute with explicit confirmation."
          currentPath="/maintenance"
          showLogout
          appStatus={appStatus}
        />

        {notice ? <p class="notice-banner ok">{notice}</p> : null}
        {error ? <p class="notice-banner stale">{error}</p> : null}

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
            <h2>Session Artifacts</h2>
            <p class="muted">
              Deletes persisted session metadata and twin files older than the
              selected age in days. This removes Kato-derived artifacts only;
              provider source files remain untouched.
            </p>

            <form method="post" class="login-form">
              <input type="hidden" name="action" value="sessions-dry-run" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <label class="form-label" for="sessionsDaysDryRun">
                Delete sessions older than (days)
              </label>
              <input
                class="form-input"
                id="sessionsDaysDryRun"
                name="sessionsDays"
                type="number"
                min="1"
                step="1"
                defaultValue={sessionsDays}
                required
              />
              <button class="secondary-button" type="submit">
                Dry-Run Session Cleanup
              </button>
            </form>

            <form method="post" class="login-form inline-form">
              <input type="hidden" name="action" value="sessions-execute" />
              <input
                type="hidden"
                name="csrfToken"
                value={ctx.state.csrfToken ?? ""}
              />
              <label class="form-label" for="sessionsDaysExecute">
                Delete sessions older than (days)
              </label>
              <input
                class="form-input"
                id="sessionsDaysExecute"
                name="sessionsDays"
                type="number"
                min="1"
                step="1"
                defaultValue={sessionsDays}
                required
              />
              <label class="checkbox-line">
                <input type="checkbox" name="confirmSessions" required />
                <span class="mono">
                  I understand this will delete old session artifacts now
                </span>
              </label>
              <button class="secondary-button danger-button" type="submit">
                Execute Session Cleanup
              </button>
            </form>
          </article>
        </section>
      </div>
    </>
  );
});
