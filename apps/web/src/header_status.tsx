import type { AppChromeStatus } from "./loaders/status.ts";

export function HeaderStatusStack(
  { status }: { status: AppChromeStatus },
) {
  const daemonClass = status.daemon === "running"
    ? "ok"
    : status.daemon === "unknown"
    ? "stale"
    : "muted";

  return (
    <div
      class="status-stack mono"
      aria-label="Application status"
    >
      <div class="status-stack-item">
        <span class="status-stack-label">DAEMON:</span>{" "}
        <span
          class={daemonClass}
          title={status.daemon === "unknown"
            ? "Unknown means the last status snapshot said the daemon was running, but its heartbeat is stale."
            : undefined}
        >
          {status.daemon}
        </span>
      </div>
      <div class="status-stack-item">
        <span
          class="status-stack-label"
          title="Heartbeat current means the latest daemon heartbeat in status.json is fresh. It does not describe the web app process."
        >
          HEARTBEAT:
        </span>{" "}
        <span class={status.snapshot === "current" ? "ok" : "stale"}>
          {status.snapshot}
        </span>
      </div>
    </div>
  );
}
