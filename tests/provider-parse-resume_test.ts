import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ProviderCursor } from "@kato/shared";
import { parseClaudeEvents } from "../apps/daemon/src/providers/claude/parser.ts";
import { parseCodexEvents } from "../apps/daemon/src/providers/codex/parser.ts";
import type { ProviderParseCheckpoint } from "../apps/daemon/src/providers/parse_checkpoint.ts";
import { jsonlReaderStats } from "../apps/daemon/src/utils/jsonl_line_reader.ts";
import { withTestTempDir } from "./test_temp.ts";

type Provider = "codex" | "claude";

interface ParseItem {
  event?: Record<string, unknown>;
  titleUpdate?: unknown;
  cursor: ProviderCursor;
}

const encoder = new TextEncoder();
const FIXTURES_DIR = new URL("./fixtures/", import.meta.url);

function cursorValue(item: ParseItem): number {
  return Number(item.cursor.value);
}

/** Drops fields that legitimately differ between runs (Codex resume time). */
function normalize(items: ParseItem[]): unknown[] {
  return items.map((item) => {
    if (!item.event) return item;
    const { timestamp: _timestamp, ...event } = item.event;
    return { ...item, event };
  });
}

async function parse(
  provider: Provider,
  path: string,
  fromOffset: number,
  resumeFrom?: ProviderParseCheckpoint,
): Promise<{ items: ParseItem[]; checkpoint?: ProviderParseCheckpoint }> {
  let checkpoint: ProviderParseCheckpoint | undefined;
  const ctx = {
    provider,
    sessionId: "sess-resume",
    resumeFrom,
    onCheckpoint: (value: ProviderParseCheckpoint) => {
      checkpoint = value;
    },
  };
  const items: ParseItem[] = [];
  const iterable = provider === "codex"
    ? parseCodexEvents(path, fromOffset, ctx)
    : parseClaudeEvents(path, fromOffset, ctx);
  for await (const item of iterable) {
    items.push(item as unknown as ParseItem);
  }
  return { items, checkpoint };
}

function maxCursor(items: ParseItem[], floor: number): number {
  return items.reduce((max, item) => Math.max(max, cursorValue(item)), floor);
}

function lineEnds(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) ends.push(index + 1);
  }
  return ends;
}

/**
 * Each provider's established inclusion rule for a resume offset: Codex
 * re-processes the line containing the offset (`lineEnd > offset`), Claude
 * only lines that start at or after it (`lineStart >= offset`). They agree
 * on line boundaries and differ only for a line seen unterminated earlier.
 */
function includedAfter(
  provider: Provider,
  bytes: Uint8Array,
  offset: number,
): (item: ParseItem) => boolean {
  if (provider === "codex") {
    return (item) => cursorValue(item) > offset;
  }
  const startByEnd = new Map<number, number>();
  let previous = 0;
  for (const end of [...lineEnds(bytes), bytes.length]) {
    if (!startByEnd.has(end)) startByEnd.set(end, previous);
    previous = end;
  }
  return (item) => (startByEnd.get(cursorValue(item)) ?? 0) >= offset;
}

function splitPoints(bytes: Uint8Array): number[] {
  const points = new Set<number>([0, bytes.length]);
  let previous = 0;
  for (const end of lineEnds(bytes)) {
    points.add(end);
    points.add(previous + Math.floor((end - previous) / 2));
    points.add(end - 1); // complete JSON without its newline yet
    previous = end;
  }
  return [...points].filter((point) => point >= 0 && point <= bytes.length)
    .sort((a, b) => a - b);
}

function codexLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, payload });
}

/** Exercises cross-line Codex state across every resume boundary. */
const SYNTHETIC_CODEX = [
  codexLine("session_meta", { id: "sess-synth", cwd: "/tmp/p" }),
  codexLine("turn_context", { model: "gpt-test" }),
  codexLine("event_msg", { type: "task_started", turn_id: "t1" }),
  codexLine("event_msg", { type: "user_message", message: "Start the loop" }),
  codexLine("response_item", {
    type: "function_call",
    call_id: "c1",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "ls" }),
  }),
  codexLine("event_msg", { type: "token_count" }),
  codexLine("response_item", {
    type: "function_call_output",
    call_id: "c1",
    output: "a.txt",
  }),
  codexLine("response_item", {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "thinking" }],
  }),
  codexLine("event_msg", { type: "agent_message", message: "Working on it" }),
  codexLine("response_item", {
    type: "message",
    phase: "final_answer",
    content: [{ type: "text", text: "Done with turn one" }],
  }),
  codexLine("event_msg", { type: "agent_message", message: "Done again" }),
  codexLine("event_msg", {
    type: "task_complete",
    last_agent_message: "Done with turn one",
  }),
  // Automated turn: no user_message.
  codexLine("event_msg", { type: "task_started", turn_id: "t2" }),
  codexLine("response_item", {
    type: "function_call",
    call_id: "c2",
    name: "request_user_input",
    arguments: JSON.stringify({
      questions: [{ id: "q1", question: "Proceed?", options: [] }],
    }),
  }),
  codexLine("compacted", { message: "summary of earlier work" }),
  codexLine("response_item", {
    type: "function_call_output",
    call_id: "c2",
    output: JSON.stringify({ answers: { q1: { answers: ["yes"] } } }),
  }),
  codexLine("event_msg", {
    type: "task_complete",
    last_agent_message: "Turn two finished",
  }),
  codexLine("event_msg", { type: "task_started", turn_id: "t3" }),
  codexLine("event_msg", {
    type: "task_complete",
    last_agent_message: "Turn three finished",
  }),
].join("\n") + "\n";

async function loadCases(): Promise<
  Array<{
    name: string;
    provider: Provider;
    content: string;
  }>
> {
  const cases: Array<{ name: string; provider: Provider; content: string }> =
    [];
  for await (const entry of Deno.readDir(FIXTURES_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
    const provider: Provider | undefined = entry.name.startsWith("codex-")
      ? "codex"
      : entry.name.startsWith("claude-")
      ? "claude"
      : undefined;
    if (!provider) continue;
    cases.push({
      name: entry.name,
      provider,
      content: await Deno.readTextFile(new URL(entry.name, FIXTURES_DIR)),
    });
  }
  cases.push({
    name: "synthetic-codex",
    provider: "codex",
    content: SYNTHETIC_CODEX,
  });
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

Deno.test("parsing from any line boundary equals the full parse filtered past it", async () => {
  await withTestTempDir("parse-resume-", async (dir) => {
    for (const testCase of await loadCases()) {
      const path = join(dir, testCase.name);
      await Deno.writeTextFile(path, testCase.content);
      const full = (await parse(testCase.provider, path, 0)).items;
      const bytes = encoder.encode(testCase.content);
      for (const boundary of [0, ...lineEnds(bytes)]) {
        const partial = (await parse(testCase.provider, path, boundary)).items;
        assertEquals(
          normalize(partial),
          normalize(full.filter((item) => cursorValue(item) > boundary)),
          `${testCase.name} fromOffset=${boundary}`,
        );
      }
    }
  });
});

Deno.test("resuming a growing file from its checkpoint equals the full parse past the cursor", async () => {
  await withTestTempDir("parse-resume-", async (dir) => {
    for (const testCase of await loadCases()) {
      const bytes = encoder.encode(testCase.content);
      const finalPath = join(dir, `${testCase.name}.final`);
      await Deno.writeFile(finalPath, bytes);
      const full = (await parse(testCase.provider, finalPath, 0)).items;

      for (const split of splitPoints(bytes)) {
        const path = join(dir, `${testCase.name}.grow`);
        await Deno.writeFile(path, bytes.subarray(0, split));
        const first = await parse(testCase.provider, path, 0);
        const cursor = maxCursor(first.items, 0);

        await Deno.writeFile(path, bytes.subarray(split), { append: true });
        const resumed = await parse(
          testCase.provider,
          path,
          cursor,
          first.checkpoint,
        );
        assertEquals(
          normalize(resumed.items),
          normalize(
            full.filter(includedAfter(testCase.provider, bytes, cursor)),
          ),
          `${testCase.name} split=${split} cursor=${cursor}`,
        );

        // A second resume from the new checkpoint emits nothing new.
        const again = await parse(
          testCase.provider,
          path,
          maxCursor(resumed.items, cursor),
          resumed.checkpoint,
        );
        assertEquals(again.items, [], `${testCase.name} split=${split} idle`);
      }
    }
  });
});

Deno.test("a stale checkpoint on a rewritten file falls back to a non-resumed parse", async () => {
  await withTestTempDir("parse-resume-", async (dir) => {
    for (const provider of ["codex", "claude"] as const) {
      const content = provider === "codex"
        ? SYNTHETIC_CODEX
        : await Deno.readTextFile(
          new URL("claude-session.jsonl", FIXTURES_DIR),
        );
      const bytes = encoder.encode(content);
      const ends = lineEnds(bytes);
      const split = ends[Math.floor(ends.length / 2)]!;
      const path = join(dir, `${provider}-rewrite.jsonl`);
      await Deno.writeFile(path, bytes.subarray(0, split));
      const first = await parse(provider, path, 0);
      const cursor = maxCursor(first.items, 0);
      assert(first.checkpoint);

      // Rewrite (same length) inside the guard window, then append the rest.
      const rewritten = new TextDecoder().decode(bytes).replaceAll(
        "e",
        "E",
      );
      await Deno.writeTextFile(path, rewritten);
      const viaStaleCheckpoint = await parse(
        provider,
        path,
        cursor,
        first.checkpoint,
      );
      const withoutCheckpoint = await parse(provider, path, cursor);
      assertEquals(
        normalize(viaStaleCheckpoint.items),
        normalize(withoutCheckpoint.items),
        provider,
      );
    }
  });
});

Deno.test("a resumed Codex parse reads only the appended bytes", async () => {
  await withTestTempDir("parse-resume-", async (dir) => {
    const path = join(dir, "codex-large.jsonl");
    const filler = codexLine("event_msg", {
      type: "token_count",
      padding: "z".repeat(2000),
    });
    await Deno.writeTextFile(
      path,
      SYNTHETIC_CODEX + `${filler}\n`.repeat(500),
    );
    const first = await parse("codex", path, 0);
    const cursor = maxCursor(first.items, 0);
    const appended = codexLine("event_msg", {
      type: "task_started",
      turn_id: "t9",
    }) + "\n" + codexLine("event_msg", {
      type: "task_complete",
      last_agent_message: "Turn nine finished",
    }) + "\n";
    await Deno.writeTextFile(path, appended, { append: true });

    const before = jsonlReaderStats.bytesRead;
    const resumed = await parse("codex", path, cursor, first.checkpoint);
    const bytesRead = jsonlReaderStats.bytesRead - before;
    assertEquals(
      resumed.items.map((item) => item.event?.["content"]),
      ["Turn nine finished"],
    );
    assert(
      bytesRead <= encoder.encode(appended).length + 256,
      `read ${bytesRead} bytes`,
    );
  });
});

Deno.test("Codex emits a final answer for every turn, including turns without a user message", async () => {
  await withTestTempDir("parse-resume-", async (dir) => {
    const path = join(dir, "codex-turns.jsonl");
    await Deno.writeTextFile(path, SYNTHETIC_CODEX);
    const finals = (await parse("codex", path, 0)).items
      .filter((item) =>
        item.event?.["kind"] === "message.assistant" &&
        item.event?.["phase"] === "final"
      )
      .map((item) => item.event?.["content"]);
    assertEquals(finals, [
      "Done with turn one",
      "Turn two finished",
      "Turn three finished",
    ]);
  });
});

Deno.test("Codex does not re-emit a turn's final answer when parsing resumes mid-turn", async () => {
  await withTestTempDir("parse-resume-", async (dir) => {
    const path = join(dir, "codex-midturn.jsonl");
    await Deno.writeTextFile(path, SYNTHETIC_CODEX);
    const bytes = encoder.encode(SYNTHETIC_CODEX);
    const finalAnswerLine = SYNTHETIC_CODEX.split("\n").findIndex((line) =>
      line.includes('"final_answer"')
    );
    const boundary = lineEnds(bytes)[finalAnswerLine]!;
    const partial = (await parse("codex", path, boundary)).items;
    const turnOneMessages = partial.filter((item) =>
      item.event?.["kind"] === "message.assistant" &&
      String(item.event?.["content"]).startsWith("Done")
    );
    assertEquals(turnOneMessages, []);
  });
});
