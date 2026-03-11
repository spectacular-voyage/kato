import { DEFAULT_LOG_LEVEL_FILTER } from "./loaders/logs.ts";
import type {
  LogChannelFilter,
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

export function buildLogHref(options: {
  basePath: string;
  channel: LogChannelFilter;
  scope: LogScopeFilter;
  level: LogLevelFilter;
  eventFilter?: string;
  textFilter?: string;
}) {
  const url = new URL(`http://kato.local${options.basePath}`);
  if (options.channel !== "all") {
    url.searchParams.set("channel", options.channel);
  }
  if (options.scope !== "all") {
    url.searchParams.set("scope", options.scope);
  }
  if (options.level !== DEFAULT_LOG_LEVEL_FILTER) {
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

export function LogResults(props: {
  currentPath: string;
  pageData: LogPageData;
}) {
  return (
    <article class="card span-12">
      <p class="page-toolbar-summary muted mono log-entry-summary">
        Showing {props.pageData.rows.length} of {props.pageData.matchedCount}
        {" "}
        entries
      </p>
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
                    channel: props.pageData.channel,
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
  );
}
