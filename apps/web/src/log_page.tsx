import LogsResultsLive from "../islands/LogsResultsLive.tsx";
import AppHeader from "./app_header.tsx";
import { DEFAULT_LOG_LEVEL_FILTER } from "./loaders/logs.ts";
import type { AppChromeStatus } from "./loaders/status.ts";
import type {
  LogChannel,
  LogChannelFilter,
  LogLevelFilter,
  LogPageData,
  LogScopeFilter,
} from "./loaders/logs.ts";
import { buildLogHref, LogResults } from "./log_results.tsx";

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
  csrfToken?: string;
  liveResultsEndpoint?: string;
  appStatus: AppChromeStatus;
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
        csrfToken={props.csrfToken}
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

        {props.liveResultsEndpoint
          ? (
            <LogsResultsLive
              currentPath={props.currentPath}
              endpoint={props.liveResultsEndpoint}
              initialData={props.pageData}
            />
          )
          : (
            <LogResults
              currentPath={props.currentPath}
              pageData={props.pageData}
            />
          )}
      </section>
    </div>
  );
}
