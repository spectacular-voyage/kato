import {
  LOG_LEVEL_ORDER,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from "./log_record.ts";

export interface LogLayerEntry {
  level: LogLevel;
  event: string;
  message: string;
  attributes?: Record<string, unknown>;
}

export interface LogLayerChannelLike {
  log(entry: LogLayerEntry): Promise<void>;
}

export interface LogLayerChannelOptions {
  channel: LogRecord["channel"];
  minLevel: LogLevel;
  now: () => Date;
  transports: readonly LogSink[];
}

type LogLayerConstructor = new (options: Record<string, unknown>) => {
  debug?: (message: string) => Promise<void> | void;
  info?: (message: string) => Promise<void> | void;
  warn?: (message: string) => Promise<void> | void;
  error?: (message: string) => Promise<void> | void;
};

interface LogLayerModuleShape {
  LogLayer?: LogLayerConstructor;
}

let cachedLogLayerModulePromise:
  | Promise<LogLayerModuleShape | null>
  | undefined;

async function loadLogLayerModule(): Promise<LogLayerModuleShape | null> {
  if (cachedLogLayerModulePromise) {
    return await cachedLogLayerModulePromise;
  }

  cachedLogLayerModulePromise = (async () => {
    try {
      const module = await import("loglayer");
      return module as unknown as LogLayerModuleShape;
    } catch {
      return null;
    }
  })();

  return await cachedLogLayerModulePromise;
}

async function writeRecordToSinks(
  record: LogRecord,
  sinks: readonly LogSink[],
): Promise<void> {
  for (const sink of sinks) {
    await sink.write(record);
  }
}

function toRecord(
  entry: LogLayerEntry,
  options: LogLayerChannelOptions,
): LogRecord {
  return {
    timestamp: options.now().toISOString(),
    level: entry.level,
    channel: options.channel,
    event: entry.event,
    message: entry.message,
    ...(entry.attributes && Object.keys(entry.attributes).length > 0
      ? { attributes: entry.attributes }
      : {}),
  };
}

// Parity baseline channel: preserves existing JSONL schema and level filtering.
class JsonlParityLogLayerChannel implements LogLayerChannelLike {
  constructor(private readonly options: LogLayerChannelOptions) {}

  async log(entry: LogLayerEntry): Promise<void> {
    if (LOG_LEVEL_ORDER[entry.level] < LOG_LEVEL_ORDER[this.options.minLevel]) {
      return;
    }

    await writeRecordToSinks(
      toRecord(entry, this.options),
      this.options.transports,
    );
  }
}

// LogLayer-backed channel with fallback guarantees:
// if npm loglayer is unavailable or its transport hook doesn't fire, we still
// emit the exact same JSONL record via the parity writer path.
class NpmLogLayerChannel implements LogLayerChannelLike {
  private readonly parity: JsonlParityLogLayerChannel;
  private readonly pendingRecords: LogRecord[] = [];
  private shipCount = 0;
  private readonly logger:
    | {
      debug?: (message: string) => Promise<void> | void;
      info?: (message: string) => Promise<void> | void;
      warn?: (message: string) => Promise<void> | void;
      error?: (message: string) => Promise<void> | void;
    }
    | undefined;

  private constructor(
    private readonly options: LogLayerChannelOptions,
    logger:
      | {
        debug?: (message: string) => Promise<void> | void;
        info?: (message: string) => Promise<void> | void;
        warn?: (message: string) => Promise<void> | void;
        error?: (message: string) => Promise<void> | void;
      }
      | undefined,
  ) {
    this.logger = logger;
    this.parity = new JsonlParityLogLayerChannel(options);
  }

  static async create(
    options: LogLayerChannelOptions,
  ): Promise<LogLayerChannelLike> {
    const module = await loadLogLayerModule();
    const LogLayer = module?.LogLayer;
    if (typeof LogLayer !== "function") {
      return new JsonlParityLogLayerChannel(options);
    }

    const channel = new NpmLogLayerChannel(options, undefined);
    const transport = {
      ship: async (_payload: unknown) => {
        channel.shipCount += 1;
        const next = channel.pendingRecords.shift();
        if (next) {
          await writeRecordToSinks(next, options.transports);
        }
      },
    };

    let logger:
      | {
        debug?: (message: string) => Promise<void> | void;
        info?: (message: string) => Promise<void> | void;
        warn?: (message: string) => Promise<void> | void;
        error?: (message: string) => Promise<void> | void;
      }
      | undefined;
    try {
      logger = new LogLayer({ transport });
    } catch {
      try {
        logger = new LogLayer({ transports: [transport] });
      } catch {
        return new JsonlParityLogLayerChannel(options);
      }
    }

    return new NpmLogLayerChannel(options, logger);
  }

  async log(entry: LogLayerEntry): Promise<void> {
    if (LOG_LEVEL_ORDER[entry.level] < LOG_LEVEL_ORDER[this.options.minLevel]) {
      return;
    }
    if (!this.logger) {
      await this.parity.log(entry);
      return;
    }

    const method = this.logger[entry.level];
    if (typeof method !== "function") {
      await this.parity.log(entry);
      return;
    }

    const record = toRecord(entry, this.options);
    const beforeShipCount = this.shipCount;
    this.pendingRecords.push(record);
    try {
      await method.call(this.logger, entry.message);
    } catch {
      const index = this.pendingRecords.indexOf(record);
      if (index >= 0) {
        this.pendingRecords.splice(index, 1);
      }
      await this.parity.log(entry);
      return;
    }

    // If transport wasn't invoked, preserve parity by writing directly.
    if (this.shipCount === beforeShipCount) {
      const index = this.pendingRecords.indexOf(record);
      if (index >= 0) {
        this.pendingRecords.splice(index, 1);
      }
      await this.parity.log(entry);
    }
  }
}

class DeferredLogLayerChannel implements LogLayerChannelLike {
  private resolved: LogLayerChannelLike | undefined;
  private resolving: Promise<LogLayerChannelLike> | undefined;

  constructor(private readonly options: LogLayerChannelOptions) {}

  private async resolveChannel(): Promise<LogLayerChannelLike> {
    if (this.resolved) {
      return this.resolved;
    }
    if (!this.resolving) {
      this.resolving = NpmLogLayerChannel.create(this.options)
        .then((channel) => {
          this.resolved = channel;
          return channel;
        });
    }
    return await this.resolving;
  }

  async log(entry: LogLayerEntry): Promise<void> {
    const channel = await this.resolveChannel();
    await channel.log(entry);
  }
}

export function createLogLayerChannel(
  options: LogLayerChannelOptions,
): LogLayerChannelLike {
  return new DeferredLogLayerChannel(options);
}
