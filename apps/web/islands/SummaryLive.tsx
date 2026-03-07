import { useEffect, useState } from "preact/hooks";
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

export default function SummaryLive(
  {
    initialData,
    csrfToken,
  }: { initialData: SummaryPageData; csrfToken?: string },
) {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/summary");
        if (!response.ok) {
          return;
        }
        const next = await response.json() as SummaryPageData;
        if (!cancelled) {
          setData(next);
        }
      } catch {
        // Keep the previous snapshot rendered.
      }
    };

    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div class="shell">
      <section class="hero">
        <div>
          <p class="mono muted">localhost operator console</p>
          <h1>Kato Web</h1>
          <p>
            Browser access to the daemon snapshot with live polling, workspace
            health, and recent operator-visible errors.
          </p>
        </div>
        <div class="hero-actions">
          <a class="secondary-button" href="/workspaces">Workspaces</a>
          <a class="secondary-button" href="/settings">Settings</a>
          <div class="status-chip">
            <span>{data.stale ? "degraded" : "live"}</span>
            <strong>{data.daemon}</strong>
          </div>
          <form method="post" action="/logout">
            <input type="hidden" name="csrfToken" value={csrfToken ?? ""} />
            <button class="form-button logout-button" type="submit">
              Log Out
            </button>
          </form>
        </div>
      </section>

      <section class="grid">
        <article class="card span-7">
          <h2>Summary</h2>
          <div class="metrics">
            <div class="metric">
              <span class="label">Sessions</span>
              <span class="value mono">{data.sessionCount}</span>
            </div>
            <div class="metric">
              <span class="label">Recordings</span>
              <span class="value mono">{data.recordingCount}</span>
            </div>
            <div class="metric">
              <span class="label">Memory RSS</span>
              <span class="value mono">
                {formatBytes(data.memory?.process.rss)}
              </span>
            </div>
          </div>
          <div class="summary-line-grid">
            <p class="mono">
              Active: <strong>{data.activeSessionCount}</strong>
            </p>
            <p class="mono">
              Stale: <strong>{data.staleSessionCount}</strong>
            </p>
            <p class="mono">
              Workspace health:{" "}
              <strong>
                {data.workspaceSummary.unavailableReason
                  ? "unavailable"
                  : `${data.workspaceSummary.activeCount} active / ${data.workspaceSummary.invalidCount} invalid`}
              </strong>
            </p>
          </div>
        </article>

        <article class="card span-5">
          <h2>Daemon</h2>
          <p class={data.stale ? "mono stale" : "mono ok"}>
            {data.stale
              ? "Snapshot is stale or daemon heartbeat is unavailable."
              : "Snapshot heartbeat is current."}
          </p>
          <p class="mono">Generated: {formatTimestamp(data.generatedAt)}</p>
          <p class="mono">Heartbeat: {formatTimestamp(data.heartbeatAt)}</p>
          <p class="mono">PID: {data.daemonPid ?? "n/a"}</p>
          <p class="mono">Source: {data.statusPath}</p>
        </article>

        <article class="card span-4">
          <h3>Providers</h3>
          <ul class="provider-list">
            {data.providers.length === 0
              ? <li class="muted">No provider activity recorded.</li>
              : data.providers.map((provider) => (
                <li key={provider.provider}>
                  <div class="mono">{provider.provider}</div>
                  <div class="muted">
                    {provider.activeSessions} active session(s)
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
                  <div class="mono">
                    {error.level} · {error.channel} · {error.event}
                  </div>
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
