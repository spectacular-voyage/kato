import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { h } from "preact";
import { renderToString } from "npm:preact-render-to-string@6.6.6";
import AppHeader from "../src/app_header.tsx";
import { HeaderStatusStack } from "../src/header_status.tsx";
import { WEB_APP_VERSION } from "../src/version.ts";

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

Deno.test("AppHeader renders the web console version eyebrow", () => {
  const html = renderToString(
    h(AppHeader, {
      title: "Summary",
      description: "Overview",
      showBrandLogo: false,
    }),
  );

  assertStringIncludes(html, `kato web console v${WEB_APP_VERSION}`);
});
