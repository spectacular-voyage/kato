import HeaderStatusLive from "../islands/HeaderStatusLive.tsx";
import { HeaderStatusStack } from "./header_status.tsx";

interface AppHeaderProps {
  title: string;
  description: string;
  currentPath?: string;
  showLogout?: boolean;
  csrfToken?: string;
  liveAppStatus?: boolean;
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
  const liveAppStatus = props.liveAppStatus ?? true;

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
                ? props.csrfToken
                  ? (
                    <form method="post" action="/logout" class="inline-form">
                      <input
                        type="hidden"
                        name="csrfToken"
                        value={props.csrfToken}
                      />
                      <button class="logout-link" type="submit">
                        Log Out
                      </button>
                    </form>
                  )
                  : null
                : null}
              {props.appStatus
                ? liveAppStatus
                  ? <HeaderStatusLive initialStatus={props.appStatus} />
                  : <HeaderStatusStack status={props.appStatus} />
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
