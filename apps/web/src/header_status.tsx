import type { AppChromeStatus } from "./loaders/status.ts";

export function HeaderStatusStack(
  { status }: { status: AppChromeStatus },
) {
  return (
    <div
      class="status-stack mono"
      aria-label="Application status"
    >
      <div class="status-stack-item">
        <span class="status-stack-label">DAEMON:</span>{" "}
        <span class={status.daemon === "running" ? "ok" : "stale"}>
          {status.daemon}
        </span>
      </div>
      <div class="status-stack-item">
        <span
          class="status-stack-label"
          title="Snapshot current means the latest daemon heartbeat in status.json is fresh. It does not describe the web app process."
        >
          SNAPSHOT:
        </span>{" "}
        <span class={status.snapshot === "current" ? "ok" : "stale"}>
          {status.snapshot}
        </span>
      </div>
    </div>
  );
}
