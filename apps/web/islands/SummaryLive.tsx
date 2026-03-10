import { useEffect, useState } from "preact/hooks";
import AppHeader from "../src/app_header.tsx";
import type { SummaryPageData } from "../src/loaders/status.ts";

const POLL_INTERVAL_MS = 2_000;

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

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
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
  const path = error.channel === "security-audit"
    ? "/security"
    : "/operational";
  const params = new URLSearchParams();
  params.set("scope", error.scope);
  params.set("level", error.level);
  params.set("event", error.event);
  return `${path}?${params.toString()}`;
}

function metricPrimaryStateClass(
  state: "active" | "stale" | "inactive" | "neutral",
): string {
  return `metric-primary activity-${state}`;
}

export default function SummaryLive(
  { initialData }: { initialData: SummaryPageData },
) {
  const [data, setData] = useState(initialData);
  const activeSessionsByProvider = new Map(
    data.providers.map((p) => [p.provider, p.activeSessions]),
  );
  const workspaceCount = data.workspaceSummary.unavailableReason
    ? "n/a"
    : String(data.workspaceSummary.activeCount);
  const workspacePrimaryState = data.workspaceSummary.unavailableReason
    ? "neutral"
    : "active";

  useEffect(() => {
    let cancelled = false;
    let polling = false;

    const load = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        const response = await fetch("/api/summary", { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const next = await response.json() as SummaryPageData;
        if (!cancelled) {
          setData(next);
        }
      } catch {
        // Keep the previous snapshot rendered.
      } finally {
        polling = false;
      }
    };

    void load();
    const interval = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div class="shell">
      <AppHeader
        title="Summary"
        description="Browser access to the daemon status with live polling, workspace health, and recent operator-visible errors."
        currentPath="/"
        showLogout
        appStatus={{
          daemon: data.daemon,
          snapshot: data.stale ? "stale" : "current",
        }}
      />

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
                <span class="metric-primary-label">active</span>
              </span>
              <span class="metric-note mono">
                {data.staleGeneratingSessionCount} stale
              </span>
              <span class="metric-note mono">
                {data.inactiveSessionCount} inactive
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
              <span class="metric-note mono">
                {data.staleRecordingCount} stale
              </span>
              <span class="metric-note mono">
                {data.stoppedRecordingCount} inactive
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
              <span class="metric-note mono">
                {data.workspaceSummary.unavailableReason
                  ? "unavailable"
                  : `${data.workspaceSummary.staleCount} stale`}
              </span>
              <span class="metric-note mono">
                {data.workspaceSummary.unavailableReason
                  ? data.workspaceSummary.unavailableReason
                  : `${data.workspaceSummary.inactiveCount} inactive`}
              </span>
              {data.workspaceSummary.unavailableReason
                ? null
                : (
                  <span class="metric-note mono">
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
                    {activeSessionsByProvider.get(provider.provider) ?? 0}{" "}
                    active session(s)
                  </div>
                  <div class="muted">
                    Automatic Twin Generation:{" "}
                    {provider.autoGenerateSnapshots ? "on" : "off"}
                  </div>
                </li>
              ))}
          </ul>
        </article>

        <article class="card span-8">
          <h3>Sessions</h3>
          <ul class="session-list">
            {data.sessions.length === 0
              ? (
                <li class="muted">
                  No active sessions in the current snapshot.
                </li>
              )
              : data.sessions.map((session) => (
                <li key={`${session.provider}:${session.sessionId}`}>
                  <div class="mono">
                    {session.stale ? "○" : "●"} {session.provider}:{" "}
                    {session.sessionShortId ?? session.sessionId}
                  </div>
                  <div>{session.snippet ?? "(no snippet)"}</div>
                  <div class="muted">
                    Updated {formatTimestamp(session.updatedAt)}
                  </div>
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
                      <div class={row.valid ? "ok" : "stale"}>
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
    </div>
  );
}
