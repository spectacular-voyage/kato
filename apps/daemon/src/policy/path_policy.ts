import { basename, dirname, isAbsolute, relative, resolve } from "@std/path";

const DEFAULT_ALLOWED_WRITE_ROOT = ".";

export interface WritePathPolicyDecision {
  decision: "allow" | "deny";
  targetPath: string;
  reason: string;
  canonicalTargetPath?: string;
  matchedRoot?: string;
}

export interface WritePathPolicyGateLike {
  evaluateWritePath(targetPath: string): Promise<WritePathPolicyDecision>;
}

export interface WritePathPolicyGateOptions {
  allowedRoots: string[];
}

function readOptionalEnv(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    if (value === undefined || value.length === 0) {
      return undefined;
    }
    return value;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      return undefined;
    }
    throw error;
  }
}

function parseAllowedRootsFromEnv(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function canonicalizeWithNearestAncestor(path: string): Promise<string> {
  let cursor = path;
  const unresolved: string[] = [];

  while (true) {
    try {
      const existing = await Deno.realPath(cursor);
      if (unresolved.length === 0) {
        return existing;
      }
      return resolve(existing, ...unresolved);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }

      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new Error("Unable to resolve existing ancestor for target path");
      }

      unresolved.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function canonicalizeRoot(root: string): Promise<string | undefined> {
  try {
    return await Deno.realPath(resolve(root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

export function resolveDefaultAllowedWriteRoots(): string[] {
  const rootsFromJson = readOptionalEnv("KATO_ALLOWED_WRITE_ROOTS_JSON");
  if (rootsFromJson) {
    const parsed = parseAllowedRootsFromEnv(rootsFromJson);
    if (parsed.length > 0) {
      return parsed;
    }
    return [];
  }

  return [
    readOptionalEnv("KATO_ALLOWED_WRITE_ROOT") ?? DEFAULT_ALLOWED_WRITE_ROOT,
  ];
}

export class WritePathPolicyGate implements WritePathPolicyGateLike {
  constructor(private readonly options: WritePathPolicyGateOptions) {}

  async evaluateWritePath(
    targetPath: string,
  ): Promise<WritePathPolicyDecision> {
    const trimmed = targetPath.trim();
    if (trimmed.length === 0) {
      return {
        decision: "deny",
        targetPath,
        reason: "Target path is empty",
      };
    }

    if (trimmed.includes("\0")) {
      return {
        decision: "deny",
        targetPath,
        reason: "Target path contains null bytes",
      };
    }

    const canonicalRoots: string[] = [];
    for (const allowedRoot of this.options.allowedRoots) {
      const canonicalRoot = await canonicalizeRoot(allowedRoot);
      if (canonicalRoot) {
        canonicalRoots.push(canonicalRoot);
      }
    }

    if (canonicalRoots.length === 0) {
      return {
        decision: "deny",
        targetPath,
        reason: "No valid allowed write roots configured",
      };
    }

    let canonicalTargetPath: string;
    try {
      canonicalTargetPath = await canonicalizeWithNearestAncestor(
        resolve(trimmed),
      );
    } catch (error) {
      return {
        decision: "deny",
        targetPath,
        reason: `Failed to canonicalize target path: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    for (const root of canonicalRoots) {
      if (isWithinRoot(root, canonicalTargetPath)) {
        return {
          decision: "allow",
          targetPath,
          canonicalTargetPath,
          matchedRoot: root,
          reason: "Target path is within allowed write roots",
        };
      }
    }

    return {
      decision: "deny",
      targetPath,
      canonicalTargetPath,
      reason: "Target path is outside allowed write roots",
    };
  }
}
