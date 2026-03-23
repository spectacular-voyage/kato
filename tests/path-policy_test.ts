import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  resolveDefaultAllowedWriteRoots,
  WritePathPolicyGate,
} from "../apps/daemon/src/mod.ts";
import { withIsolatedEnvironment } from "./test_env.ts";
import { resolveTestTempPath, withTestTempDir } from "./test_temp.ts";

const PATH_POLICY_FALLBACK_ROOT = resolveTestTempPath(
  "path-policy",
  "fallback",
);
const PATH_POLICY_EXPORTS_ROOT = resolveTestTempPath("path-policy", "exports");
const PATH_POLICY_SINGLE_ROOT = resolveTestTempPath(
  "path-policy",
  "single-root",
);

const PATH_POLICY_ENV_KEYS = [
  "KATO_ALLOWED_WRITE_ROOT",
  "KATO_ALLOWED_WRITE_ROOTS_JSON",
] as const;

type PathPolicyEnvKey = (typeof PATH_POLICY_ENV_KEYS)[number];

function snapshotPathPolicyEnv(): Record<PathPolicyEnvKey, string | undefined> {
  return Object.fromEntries(
    PATH_POLICY_ENV_KEYS.map((key) => [key, Deno.env.get(key)]),
  ) as Record<PathPolicyEnvKey, string | undefined>;
}

function setPathPolicyEnv(
  values: Partial<Record<PathPolicyEnvKey, string | undefined>>,
): void {
  for (const key of PATH_POLICY_ENV_KEYS) {
    if (!(key in values)) {
      continue;
    }
    const value = values[key];
    if (value === undefined) {
      Deno.env.delete(key);
      continue;
    }
    Deno.env.set(key, value);
  }
}

function restorePathPolicyEnv(
  snapshot: Record<PathPolicyEnvKey, string | undefined>,
): void {
  setPathPolicyEnv(snapshot);
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  await withTestTempDir("path-policy-", run);
}

Deno.test("resolveDefaultAllowedWriteRoots prefers JSON env and trims entries", async () => {
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotPathPolicyEnv();
    try {
      setPathPolicyEnv({
        KATO_ALLOWED_WRITE_ROOT: PATH_POLICY_FALLBACK_ROOT,
        KATO_ALLOWED_WRITE_ROOTS_JSON: JSON.stringify([
          " ./notes ",
          "",
          7,
          PATH_POLICY_EXPORTS_ROOT,
        ]),
      });

      assertEquals(resolveDefaultAllowedWriteRoots(), [
        "./notes",
        PATH_POLICY_EXPORTS_ROOT,
      ]);
    } finally {
      restorePathPolicyEnv(snapshot);
    }
  });
});

Deno.test("resolveDefaultAllowedWriteRoots fails closed on invalid JSON env", async () => {
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotPathPolicyEnv();
    try {
      setPathPolicyEnv({
        KATO_ALLOWED_WRITE_ROOT: PATH_POLICY_FALLBACK_ROOT,
        KATO_ALLOWED_WRITE_ROOTS_JSON: "not-json",
      });

      assertEquals(resolveDefaultAllowedWriteRoots(), []);
    } finally {
      restorePathPolicyEnv(snapshot);
    }
  });
});

Deno.test("resolveDefaultAllowedWriteRoots falls back to single-root env or cwd", async () => {
  await withIsolatedEnvironment(() => {
    const snapshot = snapshotPathPolicyEnv();
    try {
      setPathPolicyEnv({
        KATO_ALLOWED_WRITE_ROOT: PATH_POLICY_SINGLE_ROOT,
        KATO_ALLOWED_WRITE_ROOTS_JSON: undefined,
      });
      assertEquals(resolveDefaultAllowedWriteRoots(), [
        PATH_POLICY_SINGLE_ROOT,
      ]);

      setPathPolicyEnv({
        KATO_ALLOWED_WRITE_ROOT: undefined,
        KATO_ALLOWED_WRITE_ROOTS_JSON: undefined,
      });
      assertEquals(resolveDefaultAllowedWriteRoots(), ["."]);
    } finally {
      restorePathPolicyEnv(snapshot);
    }
  });
});

Deno.test("WritePathPolicyGate allows targets inside allowed root", async () => {
  await withTempDir(async (dir) => {
    const allowedRoot = join(dir, "allowed");
    await Deno.mkdir(allowedRoot, { recursive: true });

    const gate = new WritePathPolicyGate({
      allowedRoots: [allowedRoot],
    });
    const decision = await gate.evaluateWritePath(
      join(allowedRoot, "exports", "session.md"),
    );

    assertEquals(decision.decision, "allow");
    assertEquals(decision.reason, "Target path is within allowed write roots");
    assertEquals(
      decision.canonicalTargetPath,
      join(await Deno.realPath(allowedRoot), "exports", "session.md"),
    );
    assertEquals(decision.matchedRoot, await Deno.realPath(allowedRoot));
  });
});

Deno.test("WritePathPolicyGate allows the allowed root itself", async () => {
  await withTempDir(async (dir) => {
    const allowedRoot = join(dir, "allowed");
    await Deno.mkdir(allowedRoot, { recursive: true });

    const gate = new WritePathPolicyGate({
      allowedRoots: [allowedRoot],
    });
    const decision = await gate.evaluateWritePath(allowedRoot);

    assertEquals(decision.decision, "allow");
    assertEquals(
      decision.canonicalTargetPath,
      await Deno.realPath(allowedRoot),
    );
  });
});

Deno.test("WritePathPolicyGate denies traversal outside allowed root", async () => {
  await withTempDir(async (dir) => {
    const allowedRoot = join(dir, "allowed");
    await Deno.mkdir(allowedRoot, { recursive: true });

    const gate = new WritePathPolicyGate({
      allowedRoots: [allowedRoot],
    });
    const decision = await gate.evaluateWritePath(
      join(allowedRoot, "..", "outside.md"),
    );

    assertEquals(decision.decision, "deny");
    assertEquals(
      decision.canonicalTargetPath,
      join(await Deno.realPath(dir), "outside.md"),
    );
    assertEquals(decision.reason, "Target path is outside allowed write roots");
  });
});

Deno.test("WritePathPolicyGate denies empty and null-byte target paths", async () => {
  await withTempDir(async (dir) => {
    const allowedRoot = join(dir, "allowed");
    await Deno.mkdir(allowedRoot, { recursive: true });

    const gate = new WritePathPolicyGate({
      allowedRoots: [allowedRoot],
    });

    const emptyDecision = await gate.evaluateWritePath("   ");
    assertEquals(emptyDecision, {
      decision: "deny",
      targetPath: "   ",
      reason: "Target path is empty",
    });

    const nullByteDecision = await gate.evaluateWritePath("bad\0path.md");
    assertEquals(nullByteDecision, {
      decision: "deny",
      targetPath: "bad\0path.md",
      reason: "Target path contains null bytes",
    });
  });
});

Deno.test("WritePathPolicyGate denies symlink escape targets", async () => {
  await withTempDir(async (dir) => {
    const allowedRoot = join(dir, "allowed");
    const outsideRoot = join(dir, "outside");
    const symlinkPath = join(allowedRoot, "link");

    await Deno.mkdir(allowedRoot, { recursive: true });
    await Deno.mkdir(outsideRoot, { recursive: true });

    try {
      const outsideCanonical = await Deno.realPath(outsideRoot);
      await Deno.symlink(outsideCanonical, symlinkPath, { type: "dir" });
    } catch (error) {
      if (
        error instanceof Deno.errors.NotCapable ||
        error instanceof Deno.errors.PermissionDenied ||
        error instanceof Deno.errors.NotSupported
      ) {
        return;
      }
      throw error;
    }

    const gate = new WritePathPolicyGate({
      allowedRoots: [allowedRoot],
    });
    const decision = await gate.evaluateWritePath(
      join(symlinkPath, "escape.md"),
    );

    assertEquals(decision.decision, "deny");
    assertEquals(decision.reason, "Target path is outside allowed write roots");
  });
});

Deno.test("WritePathPolicyGate denies when no valid roots are configured", async () => {
  const gate = new WritePathPolicyGate({
    allowedRoots: ["/definitely-not-a-real-root-kato-test"],
  });
  const decision = await gate.evaluateWritePath("notes/file.md");

  assertEquals(decision.decision, "deny");
  assertEquals(decision.reason, "No valid allowed write roots configured");
});

Deno.test("WritePathPolicyGate handles Windows separators and traversal", async () => {
  if (Deno.build.os !== "windows") {
    return;
  }

  await withTempDir(async (dir) => {
    const allowedRoot = join(dir, "allowed");
    await Deno.mkdir(allowedRoot, { recursive: true });

    const gate = new WritePathPolicyGate({
      allowedRoots: [allowedRoot],
    });

    const insideDecision = await gate.evaluateWritePath(
      `${allowedRoot}\\sub\\session.md`,
    );
    assertEquals(insideDecision.decision, "allow");

    const traversalDecision = await gate.evaluateWritePath(
      `${allowedRoot}\\..\\outside.md`,
    );
    assertEquals(traversalDecision.decision, "deny");

    const mixedTraversalDecision = await gate.evaluateWritePath(
      `${allowedRoot}/..\\outside-mixed.md`,
    );
    assertEquals(mixedTraversalDecision.decision, "deny");
  });
});
