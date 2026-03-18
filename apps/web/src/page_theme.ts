export function resolvePageThemeRoot(pathname: string | undefined): string {
  const normalizedPathname = pathname?.trim() ?? "";
  if (normalizedPathname.length === 0 || normalizedPathname === "/") {
    return "summary";
  }

  const [firstSegment] = normalizedPathname.split("/")
    .filter((segment) => segment.length > 0);
  return firstSegment ?? "summary";
}
