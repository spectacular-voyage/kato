import AppHeader from "./app_header.tsx";
import { DEFAULT_LOG_LEVEL_FILTER } from "./loaders/logs.ts";
import type {
  LogChannel,
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

function buildLogHref(options: {
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

function buildChoiceHref(options: {
  basePath: string;
  kind: "channel" | "scope" | "level";
  value: string;
  pageData: LogPageData;
}) {
  return buildLogHref({
    basePath: options.basePath,
    channel: options.kind === "channel"
      ? options.value as LogChannelFilter
      : options.pageData.channel,
    scope: options.kind === "scope"
      ? options.value as LogScopeFilter
      : options.pageData.scope,
    level: options.kind === "level"
      ? options.value as LogLevelFilter
      : options.pageData.level,
    eventFilter: options.pageData.eventFilter,
    textFilter: options.pageData.textFilter,
  });
}

function buildChipRemoveHref(options: {
  basePath: string;
  pageData: LogPageData;
  kind: "channel" | "scope" | "level" | "event" | "text";
}) {
  return buildLogHref({
    basePath: options.basePath,
    channel: options.kind === "channel" ? "all" : options.pageData.channel,
    scope: options.kind === "scope" ? "all" : options.pageData.scope,
    level: options.kind === "level"
      ? DEFAULT_LOG_LEVEL_FILTER
      : options.pageData.level,
    eventFilter: options.kind === "event"
      ? undefined
      : options.pageData.eventFilter,
    textFilter: options.kind === "text"
      ? undefined
      : options.pageData.textFilter,
  });
}

function channelLabel(channel: LogChannel): string {
  return channel === "security-audit" ? "Security" : "Operational";
}

function hasResettableFilters(pageData: LogPageData): boolean {
  return pageData.channel !== "all" ||
    pageData.scope !== "all" ||
    pageData.level !== DEFAULT_LOG_LEVEL_FILTER ||
    !!pageData.eventFilter ||
    !!pageData.textFilter;
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
  const canReset = hasResettableFilters(props.pageData);

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
          <div class="log-filter-panel">
            <div class="log-filter-header">
              <details class="log-filter-details" open>
                <summary class="log-filter-summary">
                  <span class="log-filter-summary-title">Log Filters</span>
                </summary>

                <div class="log-filter-details-body">
                  <div class="log-filter-layout">
                    <div class="filter-choice-group">
                      <span class="filter-choice-label muted mono">
                        Channel
                      </span>
                      <div class="filter-choice-row">
                        {(["all", "operational", "security-audit"] as const)
                          .map((
                            channel,
                          ) => (
                            <a
                              key={channel}
                              class={props.pageData.channel === channel
                                ? "secondary-button current-filter"
                                : "secondary-button"}
                              href={buildChoiceHref({
                                basePath: props.currentPath,
                                kind: "channel",
                                value: channel,
                                pageData: props.pageData,
                              })}
                            >
                              {channel === "all"
                                ? "all"
                                : channelLabel(channel)}
                            </a>
                          ))}
                      </div>
                    </div>

                    <div class="filter-choice-group">
                      <span class="filter-choice-label muted mono">Scope</span>
                      <div class="filter-choice-row">
                        {(["all", "daemon", "web"] as const).map((scope) => (
                          <a
                            key={scope}
                            class={props.pageData.scope === scope
                              ? "secondary-button current-filter"
                              : "secondary-button"}
                            href={buildChoiceHref({
                              basePath: props.currentPath,
                              kind: "scope",
                              value: scope,
                              pageData: props.pageData,
                            })}
                          >
                            {scope}
                          </a>
                        ))}
                      </div>
                    </div>

                    <div class="filter-choice-group">
                      <span class="filter-choice-label muted mono">Level</span>
                      <div class="filter-choice-row">
                        {(["all", "debug", "info", "warn", "error"] as const)
                          .map((
                            level,
                          ) => (
                            <a
                              key={level}
                              class={props.pageData.level === level
                                ? "secondary-button current-filter"
                                : "secondary-button"}
                              href={buildChoiceHref({
                                basePath: props.currentPath,
                                kind: "level",
                                value: level,
                                pageData: props.pageData,
                              })}
                            >
                              {level}
                            </a>
                          ))}
                      </div>
                    </div>
                  </div>

                  <form method="get" class="log-search-form">
                    {props.pageData.channel !== "all"
                      ? (
                        <input
                          type="hidden"
                          name="channel"
                          value={props.pageData.channel}
                        />
                      )
                      : null}
                    {props.pageData.scope !== "all"
                      ? (
                        <input
                          type="hidden"
                          name="scope"
                          value={props.pageData.scope}
                        />
                      )
                      : null}
                    {props.pageData.level !== DEFAULT_LOG_LEVEL_FILTER
                      ? (
                        <input
                          type="hidden"
                          name="level"
                          value={props.pageData.level}
                        />
                      )
                      : null}
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
                    <div class="log-search-actions">
                      <button class="secondary-button" type="submit">
                        Apply
                      </button>
                    </div>
                  </form>
                </div>
              </details>

              <div class="log-filter-header-actions">
                {canReset
                  ? (
                    <a class="secondary-button" href={props.currentPath}>
                      Reset
                    </a>
                  )
                  : (
                    <button class="secondary-button" type="button" disabled>
                      Reset
                    </button>
                  )}
              </div>
            </div>

            <div class="filter-chip-list">
              {props.pageData.channel !== "all"
                ? (
                  <a
                    class="filter-chip"
                    href={buildChipRemoveHref({
                      basePath: props.currentPath,
                      pageData: props.pageData,
                      kind: "channel",
                    })}
                  >
                    channel: {channelLabel(props.pageData.channel)} x
                  </a>
                )
                : null}
              {props.pageData.scope !== "all"
                ? (
                  <a
                    class="filter-chip"
                    href={buildChipRemoveHref({
                      basePath: props.currentPath,
                      pageData: props.pageData,
                      kind: "scope",
                    })}
                  >
                    scope: {props.pageData.scope} x
                  </a>
                )
                : null}
              {props.pageData.level !== DEFAULT_LOG_LEVEL_FILTER
                ? (
                  <a
                    class="filter-chip"
                    href={buildChipRemoveHref({
                      basePath: props.currentPath,
                      pageData: props.pageData,
                      kind: "level",
                    })}
                  >
                    level: {props.pageData.level} x
                  </a>
                )
                : null}
              {props.pageData.eventFilter
                ? (
                  <a
                    class="filter-chip"
                    href={buildChipRemoveHref({
                      basePath: props.currentPath,
                      pageData: props.pageData,
                      kind: "event",
                    })}
                  >
                    event: {props.pageData.eventFilter} x
                  </a>
                )
                : null}
              {props.pageData.textFilter
                ? (
                  <a
                    class="filter-chip"
                    href={buildChipRemoveHref({
                      basePath: props.currentPath,
                      pageData: props.pageData,
                      kind: "text",
                    })}
                  >
                    text: {props.pageData.textFilter} x
                  </a>
                )
                : null}
            </div>
          </div>
        </article>

        <article class="card span-12">
          <p class="page-toolbar-summary muted mono log-entry-summary">
            Showing {props.pageData.rows.length} of{" "}
            {props.pageData.matchedCount} entries
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
      </section>
    </div>
  );
}
