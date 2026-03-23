import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { h } from "preact";
import { renderToString } from "npm:preact-render-to-string@6.6.6";
import { HeaderStatusStack } from "../src/header_status.tsx";

Deno.test("HeaderStatusStack renders unresponsive daemon state without a heartbeat row", () => {
  const html = renderToString(
    h(HeaderStatusStack, {
      status: {
        daemon: "unresponsive",
        snapshot: "stale",
      },
    }),
  );

  assertStringIncludes(html, "DAEMON:");
  assertStringIncludes(html, ">unresponsive<");
  assertEquals(html.includes("HEARTBEAT:"), false);
});
