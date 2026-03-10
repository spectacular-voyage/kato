import AppHeader from "./app_header.tsx";
import type {
  LogChannel,
  LogLevelFilter,
  LogPageData,
  LogScopeFilter,
} from "./loaders/logs.ts";

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function relativeTimestamp(value: string): string {
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

function buildLogHref(options: {
  basePath: string;
  scope: LogScopeFilter;
  level: LogLevelFilter;
  eventFilter?: string;
  textFilter?: string;
}) {
  const url = new URL(`http://kato.local${options.basePath}`);
  if (options.scope !== "all") {
    url.searchParams.set("scope", options.scope);
  }
  if (options.level !== "all") {
    url.searchParams.set("level", options.level);
  }
  if (options.eventFilter) {
    url.searchParams.set("event", options.eventFilter);
  }
  if (options.textFilter) {
    url.searchParams.set("q", options.textFilter);
  }
  return `${url.pathname}${url.search}`;
}

function channelLabel(channel: LogChannel): string {
  return channel === "security-audit" ? "Security" : "Operational";
}

export interface LogPageViewProps {
  title: string;
  description: string;
  currentPath: string;
  pageData: LogPageData;
  appStatus: {
    daemon: "running" | "stopped";
    snapshot: "current" | "stale";
  };
}

export default function LogPageView(props: LogPageViewProps) {
  return (
    <div class="shell">
      <AppHeader
        title={props.title}
        description={props.description}
        currentPath={props.currentPath}
        showLogout
        appStatus={props.appStatus}
      />

      <section class="grid">
        <article class="card span-12">
          <div class="page-toolbar">
            <div>
              <h2>{channelLabel(props.pageData.channel)} Log</h2>
              <p class="page-toolbar-summary muted mono">
                Showing {props.pageData.rows.length} of{" "}
                {props.pageData.matchedCount} entries
              </p>
            </div>
          </div>

          <form method="get" class="log-filter-form">
            <label class="form-label">
              Scope
              <select
                class="form-input"
                name="scope"
                value={props.pageData.scope}
              >
                <option value="all">all</option>
                <option value="daemon">daemon</option>
                <option value="web">web</option>
              </select>
            </label>
            <label class="form-label">
              Level
              <select
                class="form-input"
                name="level"
                value={props.pageData.level}
              >
                <option value="all">all</option>
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </label>
            <label class="form-label">
              Event
              <input
                class="form-input"
                name="event"
                type="text"
                value={props.pageData.eventFilter ?? ""}
              />
            </label>
            <label class="form-label">
              Text
              <input
                class="form-input"
                name="q"
                type="text"
                value={props.pageData.textFilter ?? ""}
              />
            </label>
            <div class="page-actions">
              <button class="secondary-button" type="submit">
                Apply Filters
              </button>
              <a
                class="secondary-button"
                href={props.currentPath}
              >
                Reset
              </a>
            </div>
          </form>
        </article>

        <article class="card span-12">
          <ul class="log-entry-list">
            {props.pageData.rows.length === 0
              ? <li class="muted">No log entries match the current filters.</li>
              : props.pageData.rows.map((row) => (
                <li
                  key={`${row.timestamp}:${row.scope}:${row.event}:${row.message}`}
                  class="log-entry-row"
                >
                  <div class="log-entry-top">
                    <div class="mono">
                      {formatTimestamp(row.timestamp)} ·{" "}
                      {relativeTimestamp(row.timestamp)}
                    </div>
                    <div class="log-entry-badges">
                      <span class={`log-badge ${row.scope}`}>{row.scope}</span>
                      <span class={`log-badge ${row.level}`}>{row.level}</span>
                    </div>
                  </div>
                  <div class="mono log-entry-event">{row.event}</div>
                  <div>{row.message}</div>
                  {row.attributes && Object.keys(row.attributes).length > 0
                    ? (
                      <details class="log-entry-details">
                        <summary>Attributes</summary>
                        <pre class="log-attributes">
                          {JSON.stringify(row.attributes, null, 2)}
                        </pre>
                      </details>
                    )
                    : null}
                  <div class="muted mono log-entry-links">
                    <a
                      href={buildLogHref({
                        basePath: props.currentPath,
                        scope: row.scope,
                        level: props.pageData.level,
                        eventFilter: row.event,
                        textFilter: props.pageData.textFilter,
                      })}
                    >
                      filter to event
                    </a>
                  </div>
                </li>
              ))}
          </ul>
        </article>
      </section>
    </div>
  );
}
