export interface SessionRouteOptions {
  includeStale?: boolean;
  workspaceFilter?: string;
}

function applySessionRouteOptions(
  url: URL,
  options: SessionRouteOptions,
): void {
  if (options.includeStale === false) {
    url.searchParams.set("view", "active");
  } else {
    url.searchParams.delete("view");
  }

  const workspaceFilter = options.workspaceFilter?.trim();
  if (workspaceFilter) {
    url.searchParams.set("workspace", workspaceFilter);
  } else {
    url.searchParams.delete("workspace");
  }
}

export function buildSessionInventoryHref(
  options: SessionRouteOptions = {},
): string {
  const url = new URL("http://kato.local/sessions");
  applySessionRouteOptions(url, options);
  return `${url.pathname}${url.search}`;
}

export function buildSessionInventorySessionHref(
  sessionId: string,
  options: SessionRouteOptions = {},
): string {
  return `${buildSessionInventoryHref(options)}#session-${sessionId}`;
}

export function buildMaintenanceHref(
  options: SessionRouteOptions = {},
): string {
  const url = new URL("http://kato.local/maintenance");
  applySessionRouteOptions(url, options);
  return `${url.pathname}${url.search}`;
}
