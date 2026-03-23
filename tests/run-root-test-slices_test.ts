import { assertArrayIncludes, assertEquals } from "@std/assert";
import {
  buildCommands,
  DEFAULT_PARALLEL_SAFE_TEST_TARGETS,
  ENV_TEST_FILES,
} from "../scripts/run-root-test-slices.ts";

Deno.test("buildCommands uses the default parallel-safe targets when no targets are forwarded", () => {
  const commands = buildCommands("parallel-safe", []);

  assertEquals(commands.length, 1);
  assertEquals(commands[0]?.name, "test:parallel-safe");
  assertArrayIncludes(
    commands[0]?.args ?? [],
    [...DEFAULT_PARALLEL_SAFE_TEST_TARGETS],
  );
});

Deno.test("buildCommands skips the env slice when forwarded targets only hit parallel-safe tests", () => {
  const commands = buildCommands("standard", [
    "--filter",
    "dead stored web status",
    "tests/improved-status_test.ts",
  ]);

  assertEquals(commands.length, 1);
  assertEquals(commands[0]?.name, "test:parallel-safe");
  assertArrayIncludes(commands[0]?.args ?? [], [
    "--filter",
    "dead stored web status",
    "tests/improved-status_test.ts",
  ]);
});

Deno.test("buildCommands keeps the env slice when a forwarded target includes env-boundary tests", () => {
  const commands = buildCommands("standard", ["tests"]);
  const envCommand = commands.find((command) => command.name === "test:env");

  assertEquals(commands.length, 2);
  assertEquals(envCommand?.args.slice(-ENV_TEST_FILES.length), [
    ...ENV_TEST_FILES,
  ]);
});

Deno.test("buildCommands narrows env mode to matching env files", () => {
  const commands = buildCommands("env", ["tests/path-policy_test.ts"]);

  assertEquals(commands.length, 1);
  assertEquals(commands[0]?.name, "test:env");
  assertEquals(commands[0]?.args.at(-1), "tests/path-policy_test.ts");
});
