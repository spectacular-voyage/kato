import { assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { incrementVersion, releaseNotesPath } from "../scripts/bump-version.ts";

Deno.test("incrementVersion bumps patch version", () => {
  assertEquals(incrementVersion("0.2.4", "patch"), "0.2.5");
});

Deno.test("incrementVersion bumps minor version and resets patch", () => {
  assertEquals(incrementVersion("0.2.4", "minor"), "0.3.0");
});

Deno.test("incrementVersion bumps major version and resets minor/patch", () => {
  assertEquals(incrementVersion("0.2.4", "major"), "1.0.0");
});

Deno.test("incrementVersion rejects invalid versions", () => {
  try {
    incrementVersion("v0.2.4", "patch");
  } catch (error) {
    assertMatch(String(error), /Invalid semver version/);
    return;
  }
  throw new Error("expected invalid semver error");
});

Deno.test("releaseNotesPath targets the internal documentation vault", () => {
  assertEquals(
    releaseNotesPath("repo-root", "0.2.12"),
    join("repo-root", "documentation", "notes", "release-notes.v0.2.12.md"),
  );
});
