import { assertEquals } from "@std/assert";
import { parseWebListenArgs } from "../apps/web/src/server_status.ts";

Deno.test("parseWebListenArgs reads split host and port flags", () => {
  const parsed = parseWebListenArgs([
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
  ]);

  assertEquals(parsed.hostname, "127.0.0.1");
  assertEquals(parsed.port, 5173);
});

Deno.test("parseWebListenArgs reads equals-style host and port flags", () => {
  const parsed = parseWebListenArgs([
    "--host=0.0.0.0",
    "--port=3187",
  ]);

  assertEquals(parsed.hostname, "0.0.0.0");
  assertEquals(parsed.port, 3187);
});

Deno.test("parseWebListenArgs ignores invalid port values", () => {
  const parsed = parseWebListenArgs([
    "--host",
    "localhost",
    "--port",
    "not-a-port",
  ]);

  assertEquals(parsed.hostname, "localhost");
  assertEquals(parsed.port, undefined);
});
