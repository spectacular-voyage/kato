import { assertEquals } from "@std/assert";
import {
  formatWorkspaceLabel,
  normalizeWorkspaceDisplayName,
} from "../shared/src/mod.ts";

Deno.test("normalizeWorkspaceDisplayName trims values and drops alias duplicates", () => {
  assertEquals(normalizeWorkspaceDisplayName("alpha", undefined), undefined);
  assertEquals(normalizeWorkspaceDisplayName("alpha", "   "), undefined);
  assertEquals(normalizeWorkspaceDisplayName("alpha", " alpha "), undefined);
  assertEquals(
    normalizeWorkspaceDisplayName("alpha", " Alpha Workspace "),
    "Alpha Workspace",
  );
});

Deno.test("formatWorkspaceLabel falls back to alias when displayName is absent", () => {
  assertEquals(formatWorkspaceLabel("alpha"), "alpha");
  assertEquals(formatWorkspaceLabel("alpha", "alpha"), "alpha");
  assertEquals(
    formatWorkspaceLabel("alpha", "Alpha Workspace"),
    "alpha (Alpha Workspace)",
  );
});
