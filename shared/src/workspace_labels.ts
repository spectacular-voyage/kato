function trimOptionalDisplayName(
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeWorkspaceDisplayName(
  alias: string,
  displayName?: string,
): string | undefined {
  const trimmedAlias = alias.trim();
  const trimmedDisplayName = trimOptionalDisplayName(displayName);
  if (!trimmedDisplayName || trimmedDisplayName === trimmedAlias) {
    return undefined;
  }
  return trimmedDisplayName;
}

export function formatWorkspaceLabel(
  alias: string,
  displayName?: string,
): string {
  const normalizedDisplayName = normalizeWorkspaceDisplayName(
    alias,
    displayName,
  );
  return normalizedDisplayName ? `${alias} (${normalizedDisplayName})` : alias;
}
