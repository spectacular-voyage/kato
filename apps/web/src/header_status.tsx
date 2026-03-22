import type { AppChromeStatus } from "./loaders/status.ts";

export function HeaderStatusStack(
  { status }: { status: AppChromeStatus },
) {
  const daemonClass = status.daemon === "running"
    ? "ok"
    : status.daemon === "unresponsive"
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
          title={status.daemon === "unresponsive"
            ? "Unresponsive means the last status snapshot said the daemon was running, but its heartbeat is stale."
            : undefined}
        >
          {status.daemon}
        </span>
      </div>
    </div>
  );
}
