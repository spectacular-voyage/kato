import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { withLockedEnvironment } from "./test_env.ts";
import { removePathIfPresent } from "./test_temp.ts";

Deno.test("withLockedEnvironment clears a stale env lock before running", async () => {
  const lockDir = join(Deno.cwd(), ".test-tmp", ".env-lock");
  const lockMetadataPath = join(lockDir, "lock.json");

  await removePathIfPresent(lockDir);
  try {
    await Deno.mkdir(lockDir, { recursive: true });
    await Deno.writeTextFile(
      lockMetadataPath,
      JSON.stringify({
        heartbeatAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    let callCount = 0;
    await withLockedEnvironment(() => {
      callCount += 1;
    });

    assertEquals(callCount, 1);
    await Deno.stat(lockDir).then(
      () => {
        throw new Error("expected env lock directory to be removed");
      },
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      },
    );
  } finally {
    await removePathIfPresent(lockDir);
  }
});
