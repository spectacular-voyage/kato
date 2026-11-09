import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  computeJsonlGuard,
  GUARD_WINDOW_BYTES,
  type JsonlLine,
  jsonlReaderStats,
  openJsonlLineReader,
} from "../apps/daemon/src/utils/jsonl_line_reader.ts";
import { withTestTempDir } from "./test_temp.ts";

const encoder = new TextEncoder();

/** Reference split matching the pre-streaming parsers' `split("\n")` walk. */
function referenceLines(content: string): JsonlLine[] {
  const parts = content.split("\n");
  const lines: JsonlLine[] = [];
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const text = parts[index]!;
    const terminated = index < parts.length - 1;
    const end = offset + encoder.encode(text).length + (terminated ? 1 : 0);
    if (terminated || text.length > 0) {
      lines.push({ text, start: offset, end, terminated });
    }
    offset = end;
  }
  return lines;
}

async function readAll(
  path: string,
  startOffset: number,
  chunkBytes: number,
): Promise<{
  lines: JsonlLine[];
  checkpoint: { offset: number; guard: string } | undefined;
}> {
  const opened = await openJsonlLineReader(path, { startOffset, chunkBytes });
  assert(!opened.guardMismatch);
  const lines: JsonlLine[] = [];
  for await (const line of opened.reader.lines()) {
    lines.push(line);
  }
  return { lines, checkpoint: opened.reader.checkpoint() };
}

function guardBefore(bytes: Uint8Array, offset: number): string {
  return computeJsonlGuard(
    bytes.subarray(Math.max(0, offset - GUARD_WINDOW_BYTES), offset),
  );
}

const MIXED_CONTENT = [
  '{"type":"a","text":"plain"}',
  "",
  '{"type":"b","text":"café \u{1F680} 中文"}',
  '{"type":"c","text":"windows"}\r',
  `{"type":"d","text":"${"x".repeat(90)}"}`,
  '{"type":"e"}',
].join("\n");

Deno.test("JsonlLineReader matches the reference split for every start offset and chunk size", async () => {
  await withTestTempDir("jsonl-reader-", async (dir) => {
    for (
      const content of [
        MIXED_CONTENT,
        `${MIXED_CONTENT}\n`,
        `${MIXED_CONTENT}\n{"partial":`,
        "\n\n",
        "",
      ]
    ) {
      const path = join(dir, "t.jsonl");
      await Deno.writeTextFile(path, content);
      const bytes = encoder.encode(content);
      const reference = referenceLines(content);
      for (const chunkBytes of [1, 7, 4096]) {
        for (let start = 0; start <= bytes.length + 2; start += 1) {
          const { lines, checkpoint } = await readAll(path, start, chunkBytes);
          assertEquals(
            lines,
            reference.filter((line) => line.start >= start),
            `content#${content.length} chunk=${chunkBytes} start=${start}`,
          );
          const lastTerminated = [...reference].reverse().find((line) =>
            line.terminated && line.end > start
          );
          const startsAtBoundary = start === 0 ||
            (start <= bytes.length && bytes[start - 1] === 0x0a);
          const expectedOffset = lastTerminated?.end ??
            (startsAtBoundary ? start : undefined);
          assertEquals(checkpoint?.offset, expectedOffset);
          if (checkpoint) {
            assertEquals(
              checkpoint.guard,
              guardBefore(bytes, checkpoint.offset),
            );
          }
        }
      }
    }
  });
});

Deno.test("JsonlLineReader verifies the guard before a resume offset", async () => {
  await withTestTempDir("jsonl-reader-", async (dir) => {
    const path = join(dir, "t.jsonl");
    const head = `${'{"n":1}\n'.repeat(80)}`;
    await Deno.writeTextFile(path, head);
    const first = await readAll(path, 0, 64);
    const checkpoint = first.checkpoint!;
    assertEquals(checkpoint.offset, encoder.encode(head).length);

    await Deno.writeTextFile(path, '{"n":2}\n', { append: true });
    const resumed = await openJsonlLineReader(path, {
      startOffset: checkpoint.offset,
      expectedGuard: checkpoint.guard,
    });
    assert(!resumed.guardMismatch);
    const resumedLines: string[] = [];
    for await (const line of resumed.reader.lines()) {
      resumedLines.push(line.text);
    }
    assertEquals(resumedLines, ['{"n":2}']);

    // Rewrite a byte inside the guard window: the resume must be refused.
    const rewritten = head.slice(0, head.length - 3) + "9}\n" + '{"n":2}\n';
    await Deno.writeTextFile(path, rewritten);
    const refused = await openJsonlLineReader(path, {
      startOffset: checkpoint.offset,
      expectedGuard: checkpoint.guard,
    });
    assertEquals(refused.guardMismatch, true);

    // Truncated below the offset: also refused.
    await Deno.writeTextFile(path, '{"n":1}\n');
    const truncated = await openJsonlLineReader(path, {
      startOffset: checkpoint.offset,
      expectedGuard: checkpoint.guard,
    });
    assertEquals(truncated.guardMismatch, true);
  });
});

Deno.test("JsonlLineReader reads only the bytes after a resume offset", async () => {
  await withTestTempDir("jsonl-reader-", async (dir) => {
    const path = join(dir, "big.jsonl");
    const line = `{"payload":"${"y".repeat(1000)}"}\n`;
    await Deno.writeTextFile(path, line.repeat(2000));
    const size = (await Deno.stat(path)).size;
    const appended = '{"tail":true}\n';
    await Deno.writeTextFile(path, appended, { append: true });

    const before = jsonlReaderStats.bytesRead;
    const opened = await openJsonlLineReader(path, { startOffset: size });
    assert(!opened.guardMismatch);
    const texts: string[] = [];
    for await (const entry of opened.reader.lines()) {
      texts.push(entry.text);
    }
    const bytesRead = jsonlReaderStats.bytesRead - before;
    assertEquals(texts, ['{"tail":true}']);
    assertEquals(bytesRead, GUARD_WINDOW_BYTES + appended.length);
  });
});

Deno.test("JsonlLineReader handles a single line spanning many chunks", async () => {
  await withTestTempDir("jsonl-reader-", async (dir) => {
    const path = join(dir, "long.jsonl");
    const longLine = `{"big":"${"é".repeat(5000)}"}`;
    await Deno.writeTextFile(path, `${longLine}\n{"after":1}\n`);
    const { lines } = await readAll(path, 0, 17);
    assertEquals(lines.map((entry) => entry.text), [longLine, '{"after":1}']);
    assertEquals(lines[0]!.end, encoder.encode(longLine).length + 1);
  });
});

Deno.test("JsonlLineReader closes the file when iteration stops early", async () => {
  await withTestTempDir("jsonl-reader-", async (dir) => {
    const path = join(dir, "early.jsonl");
    await Deno.writeTextFile(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const opened = await openJsonlLineReader(path);
    assert(!opened.guardMismatch);
    for await (const _line of opened.reader.lines()) {
      break;
    }
    // Removing the file must succeed on every platform once it is closed.
    await Deno.remove(path);
  });
});
