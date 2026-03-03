import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  loadSuppressedRecentErrorKeys,
  resolveStatusErrorCursorPath,
  saveSuppressedRecentErrorKeys,
} from "../apps/cli/src/commands/status_error_cursor.ts";
import { makeTestTempDir, removePathIfPresent } from "./test_temp.ts";

Deno.test("resolveStatusErrorCursorPath uses runtime dir", () => {
  assertEquals(
    resolveStatusErrorCursorPath("/tmp/kato-runtime"),
    "/tmp/kato-runtime/status-error-cursor.json",
  );
});

Deno.test("loadSuppressedRecentErrorKeys returns empty set for missing file", async () => {
  const dir = await makeTestTempDir("status-error-cursor-missing-");
  try {
    const cursorPath = resolveStatusErrorCursorPath(dir);
    const loaded = await loadSuppressedRecentErrorKeys(cursorPath);
    assertEquals([...loaded], []);
  } finally {
    await removePathIfPresent(dir);
  }
});

Deno.test(
  "saveSuppressedRecentErrorKeys round-trips normalized keys and limits size",
  async () => {
    const dir = await makeTestTempDir("status-error-cursor-roundtrip-");
    try {
      const cursorPath = resolveStatusErrorCursorPath(dir);
      const rawKeys = new Set<string>([
        "  log|A  ",
        "",
        "workspace|B",
        "log|A",
        "   ",
      ]);
      await saveSuppressedRecentErrorKeys(
        cursorPath,
        rawKeys,
        new Date("2026-03-02T00:00:00.000Z"),
      );

      const loaded = await loadSuppressedRecentErrorKeys(cursorPath);
      assertEquals([...loaded], ["log|A", "workspace|B"]);
    } finally {
      await removePathIfPresent(dir);
    }
  },
);

Deno.test("loadSuppressedRecentErrorKeys ignores invalid document schema", async () => {
  const dir = await makeTestTempDir("status-error-cursor-invalid-schema-");
  try {
    const cursorPath = resolveStatusErrorCursorPath(dir);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      cursorPath,
      JSON.stringify({
        schemaVersion: 999,
        updatedAt: "2026-03-02T00:00:00.000Z",
        suppressedRecentErrorKeys: ["log|A"],
      }),
    );

    const loaded = await loadSuppressedRecentErrorKeys(cursorPath);
    assertEquals([...loaded], []);
  } finally {
    await removePathIfPresent(dir);
  }
});

Deno.test("loadSuppressedRecentErrorKeys ignores malformed JSON", async () => {
  const dir = await makeTestTempDir("status-error-cursor-malformed-");
  try {
    const cursorPath = join(dir, "status-error-cursor.json");
    await Deno.writeTextFile(cursorPath, "{not-json");

    const loaded = await loadSuppressedRecentErrorKeys(cursorPath);
    assertEquals([...loaded], []);
  } finally {
    await removePathIfPresent(dir);
  }
});

Deno.test(
  "saveSuppressedRecentErrorKeys overwrites existing cursor file without leaving temp files",
  async () => {
    const dir = await makeTestTempDir("status-error-cursor-overwrite-");
    try {
      const cursorPath = resolveStatusErrorCursorPath(dir);
      await Deno.writeTextFile(
        cursorPath,
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-03-02T00:00:00.000Z",
          suppressedRecentErrorKeys: ["workspace|old"],
        }),
      );

      await saveSuppressedRecentErrorKeys(
        cursorPath,
        new Set(["log|new"]),
        new Date("2026-03-03T00:00:00.000Z"),
      );

      const loaded = await loadSuppressedRecentErrorKeys(cursorPath);
      assertEquals([...loaded], ["log|new"]);

      const tmpPrefix = `${cursorPath}.tmp-`;
      for await (const entry of Deno.readDir(dir)) {
        const entryPath = join(dir, entry.name);
        assertEquals(entryPath.startsWith(tmpPrefix), false);
      }
    } finally {
      await removePathIfPresent(dir);
    }
  },
);
