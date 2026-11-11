export interface DebouncedWatchBatch {
  paths: string[];
  kinds: Deno.FsEvent["kind"][];
  emittedAt: string;
  /**
   * The OS dropped events in this window (queue or buffer overflow), so
   * `paths` is incomplete and anything under the watched roots may have
   * changed. Set only when true.
   */
  rescan?: boolean;
}

export interface WatchDebounceOptions {
  debounceMs?: number;
  /**
   * Longest a batch waits after its first event. Without it, steady writes
   * anywhere under the roots would keep postponing every batch.
   */
  maxWaitMs?: number;
  recursive?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export class DebouncedPathAccumulator {
  private readonly pendingPaths = new Set<string>();
  private readonly pendingKinds = new Set<Deno.FsEvent["kind"]>();
  private pendingRescan = false;
  private lastEventAtMs: number | null = null;

  constructor(private readonly debounceMs: number) {}

  add(event: Deno.FsEvent, nowMs = Date.now()): void {
    for (const path of event.paths) {
      this.pendingPaths.add(path);
    }
    this.pendingKinds.add(event.kind);
    if (event.flag === "rescan") {
      this.pendingRescan = true;
    }
    this.lastEventAtMs = nowMs;
  }

  hasPending(): boolean {
    return this.pendingPaths.size > 0 || this.pendingRescan;
  }

  shouldFlush(nowMs = Date.now()): boolean {
    if (!this.hasPending()) {
      return false;
    }

    if (this.lastEventAtMs === null) {
      return false;
    }

    return nowMs - this.lastEventAtMs >= this.debounceMs;
  }

  flush(now = new Date()): DebouncedWatchBatch | null {
    if (!this.hasPending()) {
      return null;
    }

    const batch: DebouncedWatchBatch = {
      paths: [...this.pendingPaths],
      kinds: [...this.pendingKinds],
      emittedAt: now.toISOString(),
      ...(this.pendingRescan ? { rescan: true } : {}),
    };

    this.pendingPaths.clear();
    this.pendingKinds.clear();
    this.pendingRescan = false;
    this.lastEventAtMs = null;

    return batch;
  }
}

/**
 * Watch filesystem paths and emit debounced event batches.
 *
 * This is the Deno-native replacement for chokidar-style watcher fanout.
 */
export async function watchFsDebounced(
  watchPaths: string[],
  onBatch: (batch: DebouncedWatchBatch) => Promise<void> | void,
  options: WatchDebounceOptions = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? 250;
  const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? 1_000);
  const now = options.now ?? (() => new Date());

  const watcher = Deno.watchFs(watchPaths, {
    recursive: options.recursive ?? true,
  });
  let aborted = options.signal?.aborted ?? false;
  let closeError: unknown;
  const onAbort = () => {
    aborted = true;
    try {
      watcher.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) {
        // Preserve the first close error; don't overwrite if already set.
        if (closeError === undefined) closeError = error;
      }
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const accumulator = new DebouncedPathAccumulator(debounceMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAtMs: number | null = null;

  const flush = async () => {
    const batch = accumulator.flush(now());
    if (batch) {
      await onBatch(batch);
    }
  };

  const scheduleFlush = () => {
    const nowMs = Date.now();
    firstPendingAtMs ??= nowMs;
    if (timer !== null) {
      clearTimeout(timer);
    }

    const waitMs = Math.max(
      0,
      Math.min(debounceMs, firstPendingAtMs + maxWaitMs - nowMs),
    );
    timer = setTimeout(() => {
      timer = null;
      firstPendingAtMs = null;
      void flush();
    }, waitMs);
  };

  try {
    for await (const event of watcher) {
      if (aborted || options.signal?.aborted) {
        break;
      }

      accumulator.add(event);
      scheduleFlush();
    }
  } catch (error) {
    if (!(aborted && error instanceof Deno.errors.BadResource)) {
      throw error;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    // Deliberate drain-on-close: remove the abort listener, clear any pending
    // timer, then flush accumulated events before closing the watcher so no
    // buffered paths are lost on shutdown.
    await flush();
    try {
      watcher.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.BadResource)) {
        // Preserve the first close error; don't overwrite if already set.
        if (closeError === undefined) closeError = error;
      }
    }
  }

  if (closeError !== undefined) {
    throw closeError;
  }
}
