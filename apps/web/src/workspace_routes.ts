export function buildWorkspaceConfigEditHref(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/edit`;
}
