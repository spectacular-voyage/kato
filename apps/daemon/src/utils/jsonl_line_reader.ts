/**
 * Streaming, seekable JSONL line reader for provider transcripts.
 *
 * Provider transcripts grow to hundreds of megabytes (and past V8's ~512 MiB
 * string limit), so they must never be read into one string. This reader
 * seeks to a byte offset, scans fixed-size chunks for `\n`, and decodes one
 * complete line at a time. Byte offsets come straight from the bytes, so no
 * line is re-encoded to measure it.
 *
 * Checkpoints: `checkpoint()` reports the end offset of the last
 * newline-terminated line consumed, plus a guard (a hash of up to
 * {@link GUARD_WINDOW_BYTES} bytes ending at that offset). Reopening with that
 * offset and `expectedGuard` verifies the bytes before the offset are
 * unchanged, which detects a transcript that was rewritten rather than
 * appended.
 */

/** Bytes hashed immediately before a checkpoint offset. */
export const GUARD_WINDOW_BYTES = 256;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

export interface JsonlLine {
  /** Decoded line text without the trailing `\n`. */
  text: string;
  /** Byte offset of the line's first byte. */
  start: number;
  /** Byte offset just past the line, including its `\n` when terminated. */
  end: number;
  /** False only for a final segment with no trailing newline (yet). */
  terminated: boolean;
}

export interface JsonlCheckpoint {
  /** End offset of the last newline-terminated line consumed. */
  offset: number;
  /** Hash of the bytes immediately before `offset`; see `GUARD_WINDOW_BYTES`. */
  guard: string;
}

export interface OpenJsonlLineReaderOptions {
  /** Byte offset to start reading at. Defaults to 0. */
  startOffset?: number;
  /**
   * When set, the bytes before `startOffset` must hash to this guard;
   * otherwise `openJsonlLineReader` returns `{ guardMismatch: true }`.
   */
  expectedGuard?: string;
  /**
   * How to treat a `startOffset` that falls inside a line: `"skip-partial"`
   * (default) discards bytes through the next `\n` so the first yielded line
   * starts at a line boundary.
   */
  alignment?: "skip-partial";
  /** Read chunk size; small values are for tests. */
  chunkBytes?: number;
}

export type OpenJsonlLineReaderResult =
  | { reader: JsonlLineReader; guardMismatch?: false }
  | { reader?: undefined; guardMismatch: true };

/** Process-wide diagnostics; used by regression tests to bound I/O. */
export const jsonlReaderStats = { bytesRead: 0 };

function fnv1aBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function computeJsonlGuard(windowBytes: Uint8Array): string {
  return `${windowBytes.length}:${fnv1aBytes(windowBytes)}`;
}

function parseGuardLength(guard: string): number | undefined {
  const separator = guard.indexOf(":");
  if (separator <= 0) return undefined;
  const length = Number(guard.slice(0, separator));
  return Number.isSafeInteger(length) && length >= 0 &&
      length <= GUARD_WINDOW_BYTES
    ? length
    : undefined;
}

async function readFully(
  file: Deno.FsFile,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const read = await file.read(out.subarray(filled));
    if (read === null) break;
    filled += read;
    jsonlReaderStats.bytesRead += read;
  }
  return filled === length ? out : out.subarray(0, filled);
}

function concatBytes(parts: Uint8Array[], totalLength: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(totalLength);
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

/** Keeps the last `GUARD_WINDOW_BYTES` bytes ending at a line boundary. */
class GuardTail {
  private bytes: Uint8Array;

  constructor(initial: Uint8Array) {
    this.bytes = initial.length > GUARD_WINDOW_BYTES
      ? initial.slice(initial.length - GUARD_WINDOW_BYTES)
      : initial.slice();
  }

  push(segment: Uint8Array): void {
    if (segment.length >= GUARD_WINDOW_BYTES) {
      this.bytes = segment.slice(segment.length - GUARD_WINDOW_BYTES);
      return;
    }
    const keep = Math.min(
      this.bytes.length,
      GUARD_WINDOW_BYTES - segment.length,
    );
    const next = new Uint8Array(keep + segment.length);
    next.set(this.bytes.subarray(this.bytes.length - keep), 0);
    next.set(segment, keep);
    this.bytes = next;
  }

  guard(): string {
    return computeJsonlGuard(this.bytes);
  }
}

export class JsonlLineReader {
  private readonly decoder = new TextDecoder();
  private closed = false;
  /** Undefined until a line boundary is known (mid-line start). */
  private checkpointOffset: number | undefined;
  private readonly tail: GuardTail;

  constructor(
    private readonly file: Deno.FsFile,
    private position: number,
    private readonly chunkBytes: number,
    initialTail: Uint8Array,
    private skipPartial: boolean,
  ) {
    this.checkpointOffset = skipPartial ? undefined : position;
    this.tail = new GuardTail(initialTail);
  }

  /**
   * End of the last newline-terminated line consumed, with its guard.
   * Undefined when the reader started mid-line and never reached a boundary.
   */
  checkpoint(): JsonlCheckpoint | undefined {
    return this.checkpointOffset === undefined
      ? undefined
      : { offset: this.checkpointOffset, guard: this.tail.guard() };
  }

  async *lines(): AsyncGenerator<JsonlLine> {
    const buffer = new Uint8Array(this.chunkBytes);
    const pendingParts: Uint8Array[] = [];
    let pendingLength = 0;
    let lineStart = this.position;

    try {
      while (true) {
        const read = await this.file.read(buffer);
        if (read === null || read === 0) break;
        jsonlReaderStats.bytesRead += read;
        const chunk = buffer.subarray(0, read);
        let scanFrom = 0;

        while (scanFrom < chunk.length) {
          const newlineIndex = chunk.indexOf(NEWLINE, scanFrom);
          if (newlineIndex === -1) {
            // Copy: `buffer` is reused by the next read.
            const rest = chunk.slice(scanFrom);
            pendingParts.push(rest);
            pendingLength += rest.length;
            break;
          }

          const piece = chunk.subarray(scanFrom, newlineIndex + 1);
          const lineBytes = pendingLength === 0 ? piece : concatBytes(
            [...pendingParts, piece],
            pendingLength + piece.length,
          );
          pendingParts.length = 0;
          pendingLength = 0;
          scanFrom = newlineIndex + 1;

          const end = lineStart + lineBytes.length;
          const start = lineStart;
          lineStart = end;
          this.position = end;
          this.checkpointOffset = end;
          this.tail.push(lineBytes);

          if (this.skipPartial) {
            // Remainder of a line that began before `startOffset`.
            this.skipPartial = false;
            continue;
          }
          yield {
            text: this.decoder.decode(
              lineBytes.subarray(0, lineBytes.length - 1),
            ),
            start,
            end,
            terminated: true,
          };
        }
      }

      if (pendingLength > 0 && !this.skipPartial) {
        const lineBytes = concatBytes(pendingParts, pendingLength);
        this.position = lineStart + lineBytes.length;
        yield {
          text: this.decoder.decode(lineBytes),
          start: lineStart,
          end: this.position,
          terminated: false,
        };
      }
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.file.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Opens `path` for line reading at `startOffset`. Throws on open/seek errors
 * (including `Deno.errors.NotFound` / `PermissionDenied`), like
 * `Deno.readTextFile` did.
 */
export async function openJsonlLineReader(
  path: string,
  options: OpenJsonlLineReaderOptions = {},
): Promise<OpenJsonlLineReaderResult> {
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));
  const chunkBytes = Math.max(1, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const file = await Deno.open(path, { read: true });
  try {
    let windowBytes: Uint8Array = new Uint8Array(0);
    let windowComplete = true;
    if (startOffset > 0) {
      const expectedLength = options.expectedGuard !== undefined
        ? parseGuardLength(options.expectedGuard)
        : undefined;
      if (options.expectedGuard !== undefined && expectedLength === undefined) {
        file.close();
        return { guardMismatch: true };
      }
      const windowLength = Math.min(
        startOffset,
        expectedLength ?? GUARD_WINDOW_BYTES,
      );
      await file.seek(startOffset - windowLength, Deno.SeekMode.Start);
      windowBytes = await readFully(file, windowLength);
      windowComplete = windowBytes.length === windowLength;
      if (
        options.expectedGuard !== undefined &&
        (!windowComplete ||
          computeJsonlGuard(windowBytes) !== options.expectedGuard)
      ) {
        file.close();
        return { guardMismatch: true };
      }
      // Reading the window leaves the file positioned at `startOffset` unless
      // the file is shorter than that; seek explicitly to be exact.
      await file.seek(startOffset, Deno.SeekMode.Start);
    }
    // A short window read means `startOffset` is past EOF: no boundary there.
    const atLineStart = startOffset === 0 ||
      (windowComplete && windowBytes.length > 0 &&
        windowBytes[windowBytes.length - 1] === NEWLINE);
    return {
      reader: new JsonlLineReader(
        file,
        startOffset,
        chunkBytes,
        windowBytes,
        !atLineStart,
      ),
    };
  } catch (error) {
    try {
      file.close();
    } catch {
      // Ignore close failures while surfacing the original error.
    }
    throw error;
  }
}
