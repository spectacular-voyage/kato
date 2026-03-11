interface AppHeaderProps {
  title: string;
  description: string;
  currentPath?: string;
  showLogout?: boolean;
  appStatus?: {
    daemon: "running" | "stopped";
    snapshot: "current" | "stale";
  };
}

const NAV_ITEMS = [
  { href: "/", label: "Summary" },
  { href: "/ingestion", label: "Ingestion" },
  { href: "/sessions", label: "Sessions" },
  { href: "/recordings", label: "Recordings" },
  { href: "/workspaces", label: "Workspaces" },
  { href: "/logs", label: "Logs" },
  { href: "/settings", label: "Settings" },
  { href: "/maintenance", label: "Maintenance" },
];

function getTabClass(href: string, currentPath: string | undefined): string {
  return href === currentPath ? "page-tab current" : "page-tab";
}

export default function AppHeader(props: AppHeaderProps) {
  return (
    <section class="app-header">
      <div class="app-header-top">
        <div class="app-header-identity">
          <a class="brand-link" href="/" aria-label="Kato Web home">
            <img
              class="brand-logo"
              src="/brand/logo"
              alt="Kato logo"
              width="56"
              height="56"
            />
          </a>
          <div class="app-header-copy">
            <p class="mono muted app-eyebrow">kato operator console</p>
            <h1>{props.title}</h1>
            <p class="app-description">{props.description}</p>
          </div>
        </div>
        {(props.appStatus || props.showLogout)
          ? (
            <div class="app-header-side">
              {props.showLogout
                ? <a class="logout-link" href="/logout">Log Out</a>
                : null}
              {props.appStatus
                ? (
                  <div
                    class="status-stack mono"
                    aria-label="Application status"
                  >
                    <div class="status-stack-item">
                      <span class="status-stack-label">DAEMON:</span>{" "}
                      <span
                        class={props.appStatus.daemon === "running"
                          ? "ok"
                          : "stale"}
                      >
                        {props.appStatus.daemon}
                      </span>
                    </div>
                    <div class="status-stack-item">
                      <span
                        class="status-stack-label"
                        title="Snapshot current means the latest daemon heartbeat in status.json is fresh. It does not describe the web app process."
                      >
                        SNAPSHOT:
                      </span>{" "}
                      <span
                        class={props.appStatus.snapshot === "current"
                          ? "ok"
                          : "stale"}
                      >
                        {props.appStatus.snapshot}
                      </span>
                    </div>
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>
      {props.currentPath
        ? (
          <div class="app-toolbar">
            <nav class="page-tabs" aria-label="Primary">
              {NAV_ITEMS.map((item) => (
                <a
                  key={item.href}
                  class={getTabClass(item.href, props.currentPath)}
                  href={item.href}
                  aria-current={item.href === props.currentPath
                    ? "page"
                    : undefined}
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>
        )
        : null}
    </section>
  );
}
