import { assertEquals } from "@std/assert";
import { withSessionMutationLock } from "../apps/web/src/session_mutation_lock.ts";

Deno.test("withSessionMutationLock serializes work for the same session", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withSessionMutationLock("sess-lock-001", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    return "first";
  });

  await Promise.resolve();

  const second = withSessionMutationLock("sess-lock-001", () => {
    order.push("second:start");
    order.push("second:end");
    return "second";
  });

  await Promise.resolve();
  assertEquals(order, ["first:start"]);

  releaseFirst();

  assertEquals(await Promise.all([first, second]), ["first", "second"]);
  assertEquals(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

Deno.test("withSessionMutationLock releases the session after a failure", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withSessionMutationLock("sess-lock-002", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:throw");
    throw new Error("boom");
  });

  await Promise.resolve();

  const second = withSessionMutationLock("sess-lock-002", () => {
    order.push("second:start");
    order.push("second:end");
    return "second";
  });

  await Promise.resolve();
  assertEquals(order, ["first:start"]);

  releaseFirst();

  let firstError: unknown;
  try {
    await first;
  } catch (error) {
    firstError = error;
  }
  assertEquals(firstError instanceof Error, true);
  assertEquals((firstError as Error).message, "boom");
  assertEquals(await second, "second");
  assertEquals(order, [
    "first:start",
    "first:throw",
    "second:start",
    "second:end",
  ]);
});
