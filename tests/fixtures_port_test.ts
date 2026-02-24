import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

type JsonMap = Record<string, unknown>;

const THIS_DIR = dirname(fromFileUrl(import.meta.url));
const FIXTURE_DIR = join(THIS_DIR, "fixtures");

async function readJsonl(relativePath: string): Promise<JsonMap[]> {
  const filePath = join(FIXTURE_DIR, relativePath);
  const content = await Deno.readTextFile(filePath);
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as JsonMap);
}

async function readJson(relativePath: string): Promise<JsonMap> {
  const filePath = join(FIXTURE_DIR, relativePath);
  return JSON.parse(await Deno.readTextFile(filePath)) as JsonMap;
}

Deno.test("ported fixtures parse as valid JSONL", async () => {
  const files = [
    "claude-session.jsonl",
    "codex-session-aborted.jsonl",
    "codex-session-vscode-new.jsonl",
    "codex-session-legacy.jsonl",
    "codex-session-exec.jsonl",
  ];

  for (const fixture of files) {
    const rows = await readJsonl(fixture);
    assert(rows.length > 0, `fixture ${fixture} should contain entries`);
  }
});

Deno.test("Claude fixture preserves parser edge cases", async () => {
  const rows = await readJsonl("claude-session.jsonl");

  const types = rows.map((row) => String(row.type ?? ""));
  assert(types.includes("progress"));
  assert(types.includes("file-history-snapshot"));

  const sidechainRows = rows.filter((row) => row.isSidechain === true);
  assertEquals(sidechainRows.length, 1);

  const toolResultRows = rows.filter((row) => {
    const message = row.message as
      | { content?: Array<{ type?: string }> }
      | undefined;
    return message?.content?.some((item) => item.type === "tool_result") ??
      false;
  });
  assertEquals(toolResultRows.length, 2);
});

Deno.test("Codex VSCode fixture keeps preamble and final answer flow", async () => {
  const rows = await readJsonl("codex-session-vscode-new.jsonl");

  const userMessageRow = rows.find((row) => {
    const payload = row.payload as
      | { type?: string; message?: string }
      | undefined;
    return row.type === "event_msg" && payload?.type === "user_message";
  });
  assert(userMessageRow, "expected at least one user_message event");

  const userMessage = String(
    (userMessageRow.payload as { message?: string } | undefined)?.message ?? "",
  );
  assertStringIncludes(userMessage, "## My request for Codex:");
  assertStringIncludes(userMessage, "::record @documentation/notes/test.md");

  const finalAnswerCount = rows.filter((row) => {
    const payload = row.payload as
      | { type?: string; phase?: string }
      | undefined;
    return row.type === "response_item" &&
      payload?.type === "message" &&
      payload?.phase === "final_answer";
  }).length;
  assertEquals(finalAnswerCount, 2);
});

Deno.test("Codex legacy fixture keeps EOF-flush scenario inputs", async () => {
  const rows = await readJsonl("codex-session-legacy.jsonl");

  const hasTaskComplete = rows.some((row) => {
    const payload = row.payload as { type?: string } | undefined;
    return row.type === "event_msg" && payload?.type === "task_complete";
  });
  assertEquals(hasTaskComplete, false);

  const lastEntry = rows.at(-1) as { payload?: { type?: string } } | undefined;
  assertEquals(lastEntry?.payload?.type, "agent_message");
});

Deno.test("Codex exec fixture remains minimal for smoke testing", async () => {
  const rows = await readJsonl("codex-session-exec.jsonl");
  assertEquals(rows.length, 2);
  assertEquals(rows[0]?.type, "session_meta");
  assertEquals(rows[1]?.type, "event_msg");
});

Deno.test("Gemini fixture keeps JSON session-message shape", async () => {
  const session = await readJson("gemini-session.json");
  assertEquals(session["sessionId"], "gemini-fixture-session-1");
  const messages = session["messages"];
  assert(Array.isArray(messages));
  assert((messages as unknown[]).length > 0);
});
