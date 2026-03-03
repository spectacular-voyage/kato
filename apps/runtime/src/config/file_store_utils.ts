import { dirname } from "@std/path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isYamlConfigPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith(".yaml");
}

export async function writeTextAtomically(
  path: string,
  value: string,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tempPath, value);
  await Deno.rename(tempPath, path);
}
