import { assertEquals } from "@std/assert";
import { formatBytes } from "../apps/web/src/format_bytes.ts";

Deno.test("formatBytes uses stable web byte units and precision", () => {
  assertEquals(formatBytes(undefined), "n/a");
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(1023), "1023 B");
  assertEquals(formatBytes(1024), "1.0 KB");
  assertEquals(formatBytes(12_345), "12.1 KB");
  assertEquals(formatBytes(100 * 1024), "100 KB");
  assertEquals(formatBytes(1024 * 1024), "1.0 MB");
});
