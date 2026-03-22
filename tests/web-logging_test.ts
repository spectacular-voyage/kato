import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { logUnhandledWebRequestError } from "../apps/web/src/logging.ts";
import { withTestTempDir } from "./test_temp.ts";

Deno.test("logUnhandledWebRequestError writes an operational log record", async () => {
  await withTestTempDir("web-logging-", async (homeDir) => {
    const katoDir = join(homeDir, ".kato");

    await logUnhandledWebRequestError(
      new Request("http://127.0.0.1:5173/api/summary?poll=1", {
        method: "GET",
      }),
      new Error("summary loader exploded"),
      { katoDir },
    );

    const logPath = join(
      homeDir,
      ".kato",
      "web",
      "logs",
      "operational.jsonl",
    );
    const lines = (await Deno.readTextFile(logPath)).trim().split("\n");
    assertEquals(lines.length, 1);

    const record = JSON.parse(lines[0]!) as {
      channel: string;
      level: string;
      event: string;
      message: string;
      attributes?: Record<string, unknown>;
    };

    assertEquals(record.channel, "operational");
    assertEquals(record.level, "error");
    assertEquals(record.event, "web.request.unhandled_error");
    assertEquals(record.message, "Unhandled web request error");
    assertEquals(record.attributes?.["method"], "GET");
    assertEquals(record.attributes?.["pathname"], "/api/summary");
    assertEquals(record.attributes?.["search"], "?poll=1");
    assertEquals(record.attributes?.["error"], "summary loader exploded");
    assertExists(record.attributes?.["stack"]);
  });
});
