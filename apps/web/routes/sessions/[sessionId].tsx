import { Head } from "fresh/runtime";
import AppHeader from "../../src/app_header.tsx";
import { loadAppChromeStatus } from "../../src/loaders/status.ts";
import {
  loadSessionTwinViewData,
  type SessionTwinViewEvent,
} from "../../src/loaders/session_twin_view.ts";
import { define } from "../../utils.ts";

function parseSeqParam(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function kindLabel(event: SessionTwinViewEvent): string {
  return event.label ? `${event.kind} · ${event.label}` : event.kind;
}

function renderEvent(event: SessionTwinViewEvent) {
  if (!event.collapsed) {
    return (
      <li key={event.seq} class={`twin-event twin-event-${event.kind}`}>
        <div class="muted mono twin-event-meta">
          #{event.seq} · {event.kind}
          {event.timestamp ? ` · ${event.timestamp}` : ""}
        </div>
        <pre class="twin-event-text">{event.text}</pre>
      </li>
    );
  }
  return (
    <li key={event.seq} class={`twin-event twin-event-${event.kind}`}>
      <details>
        <summary class="muted mono">
          #{event.seq} · {kindLabel(event)}
          {event.timestamp ? ` · ${event.timestamp}` : ""}
        </summary>
        <pre class="twin-event-text">{event.text}</pre>
      </details>
    </li>
  );
}

export default define.page(async function SessionTwinViewPage(ctx) {
  const sessionId = ctx.params.sessionId ?? "";
  const beforeSeq = parseSeqParam(ctx.url.searchParams.get("beforeSeq"));
  const afterSeq = parseSeqParam(ctx.url.searchParams.get("afterSeq"));
  const [data, appStatus] = await Promise.all([
    loadSessionTwinViewData({ sessionId, beforeSeq, afterSeq }),
    loadAppChromeStatus(),
  ]);

  if (data.status !== "ready" || !data.header) {
    return (
      <>
        <Head>
          <title>Kato Web · Session</title>
        </Head>
        <div class="shell">
          <AppHeader
            title="Session"
            description="Persisted session twin content."
            currentPath="/sessions"
            showLogout
            csrfToken={ctx.state.csrfToken}
            appStatus={appStatus}
          />
          <p class="notice-banner danger">
            No persisted session twin found for: {sessionId}
          </p>
          <a class="secondary-button" href="/sessions">Back to Sessions</a>
        </div>
      </>
    );
  }

  const header = data.header;
  const basePath = `/sessions/${encodeURIComponent(sessionId)}`;

  return (
    <>
      <Head>
        <title>Kato Web · Session {header.sessionShortId}</title>
      </Head>
      <div class="shell">
        <AppHeader
          title={`Session ${header.sessionShortId}`}
          description="Persisted session twin content (read-only)."
          currentPath="/sessions"
          showLogout
          csrfToken={ctx.state.csrfToken}
          appStatus={appStatus}
        />

        <section class="grid">
          <article class="card span-12">
            <h2>Conversation</h2>
            <div class="muted mono">
              {header.provider}: {header.providerSessionId}
            </div>
            {header.workingDirectory
              ? (
                <div class="muted mono">
                  working directory: {header.workingDirectory}
                </div>
              )
              : null}
            <div class="muted mono">
              created {header.createdAt} · updated {header.updatedAt} · ~
              {header.eventCountEstimate} events
              {data.skippedLines > 0
                ? ` · ${data.skippedLines} unreadable lines skipped`
                : ""}
            </div>
            {header.workspaceOutputs.length > 0
              ? (
                <ul class="provider-list">
                  {header.workspaceOutputs.map((output) => (
                    <li key={output.outputPath} class="muted mono">
                      {output.desiredState === "on" ? "recording" : "stopped"} →
                      {" "}
                      {output.outputPath}
                    </li>
                  ))}
                </ul>
              )
              : null}

            <div class="twin-event-nav">
              {data.hasOlder && data.oldestSeq !== undefined
                ? (
                  <a
                    class="secondary-button"
                    href={`${basePath}?beforeSeq=${data.oldestSeq}`}
                  >
                    ← Older
                  </a>
                )
                : null}
              {data.hasNewer && data.newestSeq !== undefined
                ? (
                  <a
                    class="secondary-button"
                    href={`${basePath}?afterSeq=${data.newestSeq}`}
                  >
                    Newer →
                  </a>
                )
                : null}
              {beforeSeq !== undefined || afterSeq !== undefined
                ? (
                  <a class="secondary-button" href={basePath}>
                    Latest
                  </a>
                )
                : null}
            </div>

            {data.events.length === 0
              ? (
                <p class="muted">
                  This session's twin has no readable events
                  {data.skippedLines > 0 ? " (all lines unreadable)" : ""}.
                </p>
              )
              : (
                <ul class="recording-list twin-event-list">
                  {data.events.map(renderEvent)}
                </ul>
              )}
          </article>
        </section>
      </div>
    </>
  );
});
