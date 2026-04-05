import { dirname, join, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { isPathWithinRoots } from "./registry.ts";

const DENDRON_CONFIG_FILENAME = "dendron.yml";
const SELF_CONTAINED_NOTES_DIRNAME = "notes";

export type DendronWikilinkContextMode =
  | "dendron-config"
  | "output-directory-fallback";

export interface DendronWikilinkContext {
  mode: DendronWikilinkContextMode;
  dendronConfigPath?: string;
  wikilinkifiableRoots: string[];
}

interface CachedDendronConfig {
  sourceMtimeMs: number | null;
  noteRoots: string[];
}

const cachedDendronConfigs = new Map<string, CachedDendronConfig>();

interface DendronConfigStat {
  mtimeMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readConfigStat(
  path: string,
): Promise<DendronConfigStat | undefined> {
  try {
    const stat = await Deno.stat(path);
    return {
      mtimeMs: stat.mtime?.getTime() ?? null,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function loadDerivedNoteRoots(
  dendronConfigPath: string,
): Promise<string[] | undefined> {
  const configStat = await readConfigStat(dendronConfigPath);
  if (configStat === undefined) {
    cachedDendronConfigs.delete(dendronConfigPath);
    return undefined;
  }

  const sourceMtimeMs = configStat.mtimeMs;
  const cached = cachedDendronConfigs.get(dendronConfigPath);
  if (sourceMtimeMs !== null && cached?.sourceMtimeMs === sourceMtimeMs) {
    return [...cached.noteRoots];
  }

  let raw: string;
  try {
    raw = await Deno.readTextFile(dendronConfigPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      cachedDendronConfigs.delete(dendronConfigPath);
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    cachedDendronConfigs.set(dendronConfigPath, {
      sourceMtimeMs,
      noteRoots: [],
    });
    return [];
  }

  const workspace = isRecord(parsed) && isRecord(parsed["workspace"])
    ? parsed["workspace"]
    : undefined;
  const vaults = Array.isArray(workspace?.["vaults"])
    ? workspace["vaults"]
    : [];
  const configDir = dirname(dendronConfigPath);
  const noteRoots: string[] = [];

  for (const vault of vaults) {
    if (!isRecord(vault)) {
      continue;
    }
    const fsPath = trimOptionalString(vault["fsPath"]);
    if (!fsPath) {
      continue;
    }

    const vaultRoot = resolve(configDir, fsPath);
    const root = vault["selfContained"] === true
      ? join(vaultRoot, SELF_CONTAINED_NOTES_DIRNAME)
      : vaultRoot;
    if (!(await isExistingDirectory(root))) {
      continue;
    }
    noteRoots.push(root);
  }

  cachedDendronConfigs.set(dendronConfigPath, {
    sourceMtimeMs,
    noteRoots,
  });
  return [...noteRoots];
}

export async function resolveDendronWikilinkContext(
  outputPath: string,
): Promise<DendronWikilinkContext> {
  const resolvedOutputPath = resolve(outputPath);
  let cursor = dirname(resolvedOutputPath);

  while (true) {
    const dendronConfigPath = join(cursor, DENDRON_CONFIG_FILENAME);
    const noteRoots = await loadDerivedNoteRoots(dendronConfigPath);
    if (
      noteRoots !== undefined &&
      isPathWithinRoots(resolvedOutputPath, noteRoots)
    ) {
      return {
        mode: "dendron-config",
        dendronConfigPath,
        wikilinkifiableRoots: [...noteRoots],
      };
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return {
    mode: "output-directory-fallback",
    wikilinkifiableRoots: [dirname(resolvedOutputPath)],
  };
}
