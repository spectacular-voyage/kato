/**
 * Resume points for incremental JSONL provider parsing.
 *
 * A checkpoint records how far a parse got (the end of the last
 * newline-terminated line consumed), a guard over the bytes just before that
 * offset, and any provider parser state needed to continue from there. The
 * ingestion runner keeps the latest checkpoint per session in memory and
 * passes it back as `resumeFrom`; parsers verify the guard and fall back to
 * their non-resumed path when it does not match.
 */
export interface ProviderParseCheckpoint {
  /** End offset of the last newline-terminated line consumed. */
  offset: number;
  /** Guard over the bytes immediately before `offset`. */
  guard: string;
  /** Provider parser state after consuming through `offset` (opaque). */
  state?: unknown;
}

export interface ProviderParseResumeOptions {
  /**
   * Resume point from an earlier complete parse of the same file. Parsers
   * use it only when it is consistent with `fromOffset`; the caller is
   * responsible for passing a checkpoint whose skipped range produced no
   * events (see `FileProviderIngestionRunner`).
   */
  resumeFrom?: ProviderParseCheckpoint;
  /** Called once when a parse runs to completion (not on early exit). */
  onCheckpoint?: (checkpoint: ProviderParseCheckpoint) => void;
}
