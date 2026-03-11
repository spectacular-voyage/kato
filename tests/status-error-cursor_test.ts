import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  loadSuppressedRecentErrorKeys,
  resolveStatusErrorCursorPath,
  saveSuppressedRecentErrorKeys,
} from "../apps/cli/src/commands/status_error_cursor.ts";
import {
  makeTestTempDir,
  removePathIfPresent,
  resolveTestTempPath,
} from "./test_temp.ts";

Deno.test("resolveStatusErrorCursorPath uses runtime dir", () => {
  const runtimeDir = resolveTestTempPath("kato-runtime");
  assertEquals(
    resolveStatusErrorCursorPath(runtimeDir),
    join(runtimeDir, "status-error-cursor.json"),
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

Deno.test("loadSuppressedRecentErrorKeys ignores non-object and invalid field shapes", async () => {
  const dir = await makeTestTempDir("status-error-cursor-invalid-shape-");
  try {
    const cursorPath = resolveStatusErrorCursorPath(dir);

    await Deno.writeTextFile(cursorPath, JSON.stringify(["not-a-document"]));
    let loaded = await loadSuppressedRecentErrorKeys(cursorPath);
    assertEquals([...loaded], []);

    await Deno.writeTextFile(
      cursorPath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: 123,
        suppressedRecentErrorKeys: ["log|A"],
      }),
    );
    loaded = await loadSuppressedRecentErrorKeys(cursorPath);
    assertEquals([...loaded], []);

    await Deno.writeTextFile(
      cursorPath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-03-02T00:00:00.000Z",
        suppressedRecentErrorKeys: ["log|A", 123],
      }),
    );
    loaded = await loadSuppressedRecentErrorKeys(cursorPath);
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
  "saveSuppressedRecentErrorKeys creates parent directories and caps normalized keys",
  async () => {
    const dir = await makeTestTempDir("status-error-cursor-cap-");
    try {
      const runtimeDir = join(dir, "nested", "runtime");
      const cursorPath = resolveStatusErrorCursorPath(runtimeDir);
      const rawKeys = new Set(
        Array.from({ length: 300 }, (_, index) => `  log|${index}  `),
      );

      await saveSuppressedRecentErrorKeys(
        cursorPath,
        rawKeys,
        new Date("2026-03-04T00:00:00.000Z"),
      );

      const loaded = await loadSuppressedRecentErrorKeys(cursorPath);
      const normalizedKeys = [...loaded];
      assertEquals(normalizedKeys.length, 256);
      assertEquals(normalizedKeys[0], "log|0");
      assertEquals(normalizedKeys[255], "log|255");
    } finally {
      await removePathIfPresent(dir);
    }
  },
);

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
