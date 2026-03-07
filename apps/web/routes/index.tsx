import { Head } from "fresh/runtime";
import { define } from "../utils.ts";
import { loadSummaryPageData } from "../src/loaders/status.ts";

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

export default define.page(async function Home() {
  const summary = await loadSummaryPageData();

  return (
    <div class="shell">
      <Head>
        <title>Kato Web</title>
      </Head>
      <section class="hero">
        <div>
          <p class="mono muted">localhost operator console</p>
          <h1>Kato Web</h1>
          <p>
            Browser access to the daemon snapshot with the same source model as
            `kato status`, ready for deeper route-backed pages.
          </p>
        </div>
        <div class="status-chip">
          <span>{summary.stale ? "degraded" : "live"}</span>
          <strong>{summary.daemon}</strong>
        </div>
      </section>

      <section class="grid">
        <article class="card span-7">
          <h2>Summary</h2>
          <div class="metrics">
            <div class="metric">
              <span class="label">Sessions</span>
              <span class="value mono">{summary.sessionCount}</span>
            </div>
            <div class="metric">
              <span class="label">Recordings</span>
              <span class="value mono">{summary.recordingCount}</span>
            </div>
            <div class="metric">
              <span class="label">Memory RSS</span>
              <span class="value mono">
                {formatBytes(summary.memory?.process.rss)}
              </span>
            </div>
          </div>
        </article>

        <article class="card span-5">
          <h2>Daemon</h2>
          <p class={summary.stale ? "mono stale" : "mono ok"}>
            {summary.stale
              ? "Snapshot is stale or daemon heartbeat is unavailable."
              : "Snapshot heartbeat is current."}
          </p>
          <p class="mono">Generated: {formatTimestamp(summary.generatedAt)}</p>
          <p class="mono">Heartbeat: {formatTimestamp(summary.heartbeatAt)}</p>
          <p class="mono">
            PID: {summary.daemonPid === undefined ? "n/a" : summary.daemonPid}
          </p>
          <p class="mono">Source: {summary.statusPath}</p>
        </article>

        <article class="card span-4">
          <h3>Providers</h3>
          <ul class="provider-list">
            {summary.providers.length === 0
              ? <li class="muted">No provider activity recorded.</li>
              : summary.providers.map((provider) => (
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
            {summary.sessions.length === 0
              ? (
                <li class="muted">
                  No active sessions in the current snapshot.
                </li>
              )
              : summary.sessions.map((session) => (
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
      </section>
    </div>
  );
});
