import { assertEquals } from "@std/assert";
import {
  canonicalTimestamp,
  formatRelativeTimestamp,
  formatTimestamp,
  parseTimestampMs,
} from "../apps/web/src/time.ts";

Deno.test("formatTimestamp returns stable ISO fallback when no time zone is provided", () => {
  assertEquals(
    formatTimestamp("2026-03-12T04:45:00.123-07:00"),
    "2026-03-12T11:45:00.123Z",
  );
  assertEquals(formatTimestamp(undefined), "n/a");
  assertEquals(formatTimestamp("not-a-timestamp"), "not-a-timestamp");
});

Deno.test("formatTimestamp renders fixed-width local time when a time zone is provided", () => {
  assertEquals(
    formatTimestamp("2026-03-12T04:45:00.123-07:00", {
      timeZone: "America/Los_Angeles",
    }),
    "2026-03-12 04:45:00",
  );
  assertEquals(
    formatTimestamp("2026-03-12T04:45:00.123-07:00", {
      timeZone: "UTC",
    }),
    "2026-03-12 11:45:00",
  );
});

Deno.test("canonicalTimestamp returns normalized ISO strings", () => {
  assertEquals(
    canonicalTimestamp("2026-03-12T04:45:00.123-07:00"),
    "2026-03-12T11:45:00.123Z",
  );
  assertEquals(canonicalTimestamp("not-a-timestamp"), undefined);
  assertEquals(canonicalTimestamp(undefined), undefined);
});

Deno.test("parseTimestampMs returns milliseconds for valid timestamps", () => {
  assertEquals(
    parseTimestampMs("2026-03-12T04:45:00.000Z"),
    Date.parse("2026-03-12T04:45:00.000Z"),
  );
  assertEquals(parseTimestampMs("not-a-timestamp"), undefined);
  assertEquals(parseTimestampMs(undefined), undefined);
});

Deno.test("formatRelativeTimestamp formats age buckets and clamps future times", () => {
  const nowMs = Date.parse("2026-03-12T05:00:00.000Z");

  assertEquals(
    formatRelativeTimestamp("2026-03-12T04:59:55.000Z", nowMs),
    "5s ago",
  );
  assertEquals(
    formatRelativeTimestamp("2026-03-12T04:57:00.000Z", nowMs),
    "3m ago",
  );
  assertEquals(
    formatRelativeTimestamp("2026-03-12T03:00:00.000Z", nowMs),
    "2h ago",
  );
  assertEquals(
    formatRelativeTimestamp("2026-03-10T05:00:00.000Z", nowMs),
    "2d ago",
  );
  assertEquals(
    formatRelativeTimestamp("2026-03-12T05:00:10.000Z", nowMs),
    "0s ago",
  );
});

Deno.test("formatRelativeTimestamp preserves invalid values and handles missing values", () => {
  const nowMs = Date.parse("2026-03-12T05:00:00.000Z");

  assertEquals(
    formatRelativeTimestamp("not-a-timestamp", nowMs),
    "not-a-timestamp",
  );
  assertEquals(formatRelativeTimestamp(undefined, nowMs), "n/a");
});
