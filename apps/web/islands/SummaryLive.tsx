import type { SummaryPageData } from "../src/loaders/status.ts";
import { buildSessionInventorySessionHref } from "../src/session_routes.ts";
import { formatTimestamp } from "../src/time.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "n/a";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function relativeTimestamp(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const diffSeconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 1000),
  );
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m ago`;
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h ago`;
  }
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

function buildLogHref(
  error: SummaryPageData["recentErrors"][number],
): string {
  const params = new URLSearchParams();
  params.set("channel", error.channel);
  params.set("scope", error.scope);
  params.set("level", error.level);
  params.set("event", error.event);
  return `/logs?${params.toString()}`;
}

function metricPrimaryStateClass(
  state: "active" | "stale" | "inactive" | "neutral",
): string {
  return `metric-primary activity-${state}`;
}

function activityStateDot(state: "active" | "stale" | "inactive"): string {
  return state === "inactive" ? "○" : "●";
}

export default function SummaryLive(
  props: { initialData: SummaryPageData; endpoint: string },
) {
  const data = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  const activeSessionsByProvider = new Map(
    data.providers.map((
      provider,
    ) => [provider.provider, provider.activeSessions]),
  );
  const workspaceCount = data.workspaceSummary.unavailableReason
    ? "n/a"
    : String(data.workspaceSummary.activeCount);
  const workspacePrimaryState = data.workspaceSummary.unavailableReason
    ? "neutral"
    : "active";
  const activeSessionRows = data.summarySessions
    .filter((session) => session.state === "active")
    .slice(0, 10);

  return (
    <section class="grid">
      <article class="card span-7">
        <h2>Activity</h2>
        <div class="metrics">
          <div class="metric">
            <span class="label">Sessions</span>
            <span class={metricPrimaryStateClass("active")}>
              <span class="metric-primary-count mono">
                {data.generatingSessionCount}
              </span>
              <span class="metric-primary-label">generating</span>
            </span>
            <span class="metric-note mono activity-stale">
              {data.staleGeneratingSessionCount} idle
            </span>
            <span class="metric-note mono">
              {data.inactiveSessionCount} not generating
            </span>
          </div>
          <div class="metric">
            <span class="label">Recordings</span>
            <span class={metricPrimaryStateClass("active")}>
              <span class="metric-primary-count mono">
                {data.recordingCount}
              </span>
              <span class="metric-primary-label">active</span>
            </span>
            <span class="metric-note mono activity-stale">
              {data.staleRecordingCount} idle
            </span>
            <span class="metric-note mono">
              {data.stoppedRecordingCount} stopped
            </span>
          </div>
          <div class="metric">
            <span class="label">Workspaces</span>
            <span class={metricPrimaryStateClass(workspacePrimaryState)}>
              <span class="metric-primary-count mono">{workspaceCount}</span>
              <span class="metric-primary-label">
                {data.workspaceSummary.unavailableReason
                  ? "unavailable"
                  : "active"}
              </span>
            </span>
            <span class="metric-note mono activity-stale">
              {data.workspaceSummary.unavailableReason
                ? "unavailable"
                : `${data.workspaceSummary.staleCount} idle`}
            </span>
            {data.workspaceSummary.unavailableReason
              ? null
              : (
                <span class="metric-note mono danger">
                  {data.workspaceSummary.invalidCount} invalid
                </span>
              )}
          </div>
        </div>
      </article>

      <article class="card span-5">
        <h2>Daemon</h2>
        <p class={data.stale ? "mono stale" : "mono ok"}>
          {data.stale
            ? "Snapshot is stale or daemon heartbeat is unavailable."
            : "Snapshot heartbeat is current."}
        </p>
        <p class="mono">Heartbeat: {formatTimestamp(data.heartbeatAt)}</p>
        <p class="mono">
          Memory RSS: {formatBytes(data.memory?.process.rss)}
        </p>
        <p class="mono">PID: {data.daemonPid ?? "n/a"}</p>
        <p class="mono">Source: {data.statusPath}</p>
      </article>

      <article class="card span-4">
        <h3>Providers</h3>
        <ul class="provider-list">
          {data.configuredProviders.length === 0
            ? <li class="muted">No providers configured.</li>
            : data.configuredProviders.map((provider) => (
              <li key={provider.provider}>
                <div class="mono">{provider.provider}</div>
                <div class="muted">
                  {activeSessionsByProvider.get(provider.provider) ?? 0} active
                  {" "}
                  session(s)
                </div>
                <div class="muted">
                  Automatic Twin Generation:{" "}
                  {provider.autoGenerateTwins ? "on" : "off"}
                </div>
              </li>
            ))}
        </ul>
      </article>

      <article class="card span-8">
        <h3>Generating Sessions</h3>
        <ul class="session-list">
          {activeSessionRows.length === 0
            ? (
              <li class="muted">
                No provider sessions are currently generating twins.
              </li>
            )
            : activeSessionRows.map((session) => (
              <li key={`${session.provider}:${session.sessionId}`}>
                <a
                  class="mono summary-ingestion-link"
                  href={buildSessionInventorySessionHref(session.sessionId)}
                  title={`${session.provider}: ${
                    session.snippet ?? "(no snippet)"
                  }`}
                >
                  <span
                    class={`activity-state-dot ${session.state}`}
                    aria-hidden="true"
                  >
                    {activityStateDot(session.state)}
                  </span>{" "}
                  <span class="summary-ingestion-provider">
                    {session.provider}:
                  </span>{" "}
                  <span class="summary-ingestion-snippet">
                    {session.snippet ?? "(no snippet)"}
                  </span>
                </a>
              </li>
            ))}
        </ul>
      </article>

      <article class="card span-5">
        <h3>Workspaces</h3>
        {data.workspaceSummary.unavailableReason
          ? <p class="muted">{data.workspaceSummary.unavailableReason}</p>
          : (
            <ul class="provider-list">
              {data.workspaceSummary.rows.length === 0
                ? <li class="muted">No workspaces registered.</li>
                : data.workspaceSummary.rows.map((row) => (
                  <li key={row.workspaceId}>
                    <div class="mono">{row.alias}</div>
                    <div class={row.valid ? "ok" : "danger"}>
                      {row.valid ? "valid" : row.invalidReason ?? "invalid"}
                    </div>
                  </li>
                ))}
            </ul>
          )}
      </article>

      <article class="card span-7">
        <h3>Recent Errors</h3>
        <ul class="session-list">
          {data.recentErrors.length === 0
            ? <li class="muted">No recent operational or security errors.</li>
            : data.recentErrors.map((error) => (
              <li key={`${error.timestamp}:${error.event}:${error.message}`}>
                <a class="mono summary-log-link" href={buildLogHref(error)}>
                  {error.level} · {error.scope} · {error.channel} ·{" "}
                  {error.event}
                </a>
                <div>{error.message}</div>
                <div class="muted">
                  {formatTimestamp(error.timestamp)} ·{" "}
                  {relativeTimestamp(error.timestamp)}
                </div>
              </li>
            ))}
        </ul>
      </article>
    </section>
  );
}
