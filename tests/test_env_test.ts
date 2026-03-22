import { assertEquals, assertRejects } from "@std/assert";
import { withIsolatedEnvironment } from "./test_env.ts";

Deno.test("withIsolatedEnvironment restores process env after async work", async () => {
  const previous = Deno.env.get("KATO_WEB_PASSWORD");

  await withIsolatedEnvironment(async () => {
    Deno.env.set("KATO_WEB_PASSWORD", "temp-password");
    assertEquals(Deno.env.get("KATO_WEB_PASSWORD"), "temp-password");
    await Promise.resolve();
  });

  assertEquals(Deno.env.get("KATO_WEB_PASSWORD"), previous);
});

Deno.test("withIsolatedEnvironment restores process env after errors", async () => {
  const previous = Deno.env.get("KATO_WEB_PASSWORD");

  await assertRejects(
    () =>
      withIsolatedEnvironment(() => {
        Deno.env.set("KATO_WEB_PASSWORD", "temp-password");
        throw new Error("boom");
      }),
    Error,
    "boom",
  );

  assertEquals(Deno.env.get("KATO_WEB_PASSWORD"), previous);
});
