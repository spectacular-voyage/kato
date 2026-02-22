export interface DebouncedWatchBatch {
  paths: string[];
  kinds: Deno.FsEvent["kind"][];
  emittedAt: string;
}

export interface WatchDebounceOptions {
  debounceMs?: number;
  recursive?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export class DebouncedPathAccumulator {
  private readonly pendingPaths = new Set<string>();
  private readonly pendingKinds = new Set<Deno.FsEvent["kind"]>();
  private lastEventAtMs: number | null = null;

  constructor(private readonly debounceMs: number) {}

  add(event: Deno.FsEvent, nowMs = Date.now()): void {
    for (const path of event.paths) {
      this.pendingPaths.add(path);
    }
    this.pendingKinds.add(event.kind);
    this.lastEventAtMs = nowMs;
  }

  hasPending(): boolean {
    return this.pendingPaths.size > 0;
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
    };

    this.pendingPaths.clear();
    this.pendingKinds.clear();
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
  const now = options.now ?? (() => new Date());

  const watcher = Deno.watchFs(watchPaths, {
    recursive: options.recursive ?? true,
  });

  const accumulator = new DebouncedPathAccumulator(debounceMs);
  let timer: number | null = null;

  const flush = async () => {
    const batch = accumulator.flush(now());
    if (batch) {
      await onBatch(batch);
    }
  };

  const scheduleFlush = () => {
    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  };

  try {
    for await (const event of watcher) {
      if (options.signal?.aborted) {
        break;
      }

      accumulator.add(event);
      scheduleFlush();
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    await flush();
    watcher.close();
  }
}
