import { assertEquals, assertThrows } from "@std/assert";
import { parseWebBinaryServeOptions } from "../apps/web/src/binary_entry.ts";

Deno.test("parseWebBinaryServeOptions uses defaults when args and env are empty", () => {
  assertEquals(parseWebBinaryServeOptions([], {}), {
    hostname: "127.0.0.1",
    port: 5173,
  });
});

Deno.test("parseWebBinaryServeOptions accepts env overrides", () => {
  assertEquals(
    parseWebBinaryServeOptions([], {
      KATO_WEB_HOSTNAME: "0.0.0.0",
      PORT: "45175",
    }),
    {
      hostname: "0.0.0.0",
      port: 45175,
    },
  );
});

Deno.test("parseWebBinaryServeOptions lets args override env", () => {
  assertEquals(
    parseWebBinaryServeOptions([
      "--host",
      "127.0.0.1",
      "--port",
      "4123",
    ], {
      KATO_WEB_HOSTNAME: "0.0.0.0",
      PORT: "45175",
    }),
    {
      hostname: "127.0.0.1",
      port: 4123,
    },
  );
});

Deno.test("parseWebBinaryServeOptions ignores ambient HOSTNAME", () => {
  assertEquals(
    parseWebBinaryServeOptions([], {
      HOSTNAME: "ambient-hostname",
    }),
    {
      hostname: "127.0.0.1",
      port: 5173,
    },
  );
});

Deno.test("parseWebBinaryServeOptions rejects invalid ports", () => {
  assertThrows(
    () => parseWebBinaryServeOptions(["--port", "0"], {}),
    Error,
    "--port must be an integer between 1 and 65535",
  );
});

Deno.test("parseWebBinaryServeOptions rejects unsupported args", () => {
  assertThrows(
    () => parseWebBinaryServeOptions(["--wat"], {}),
    Error,
    "Unsupported kato-web argument: --wat",
  );
});
