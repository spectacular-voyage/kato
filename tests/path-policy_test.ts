import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { WritePathPolicyGate } from "../apps/daemon/src/mod.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  await Deno.mkdir(".kato/test-tmp", { recursive: true });
  const dir = await Deno.makeTempDir({
    dir: ".kato/test-tmp",
    prefix: "path-policy-",
  });

  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

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
    assertEquals(decision.matchedRoot, await Deno.realPath(allowedRoot));
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
    assertEquals(decision.reason, "Target path is outside allowed write roots");
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
