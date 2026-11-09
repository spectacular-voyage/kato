import { dirname } from "@std/path";
import {
  createLogLayerChannel,
  type LogLayerChannelLike,
} from "./loglayer_adapter.ts";
import type { LogLevel, LogRecord, LogSink } from "./log_record.ts";
import {
  DEFAULT_LOG_RETENTION_DAYS,
  formatUtcDay,
  isValidLogRetentionDays,
  pruneRotatedLogFiles,
  rotateLogFileIfStale,
} from "./log_rotation.ts";

export type { LogLevel, LogRecord, LogSink } from "./log_record.ts";

export interface StructuredLoggerOptions {
  minLevel?: LogLevel;
  channel: LogRecord["channel"];
  now?: () => Date;
}

export class StructuredLogger {
  private readonly channelLogger: LogLayerChannelLike;

  constructor(
    private readonly sinks: readonly LogSink[],
    options: StructuredLoggerOptions,
  ) {
    this.channelLogger = createLogLayerChannel({
      channel: options.channel,
      minLevel: options.minLevel ?? "info",
      now: options.now ?? (() => new Date()),
      transports: this.sinks,
    });
  }

  async log(
    level: LogLevel,
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    await this.channelLogger.log({ level, event, message, attributes });
  }

  debug(
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    return this.log("debug", event, message, attributes);
  }

  info(
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    return this.log("info", event, message, attributes);
  }

  warn(
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    return this.log("warn", event, message, attributes);
  }

  error(
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    return this.log("error", event, message, attributes);
  }
}

export class JsonLineWriterSink implements LogSink {
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly writer: { write(data: Uint8Array): Promise<number> },
  ) {}

  async write(record: LogRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    await this.writer.write(this.encoder.encode(line));
  }
}

export interface JsonLineFileSinkOptions {
  /**
   * Days to keep rotated log files before they are deleted.
   * Defaults to {@link DEFAULT_LOG_RETENTION_DAYS}.
   */
  retentionDays?: number;
  /** Clock used for UTC-day rollover; must match file mtimes' clock. */
  now?: () => Date;
}

// Serializes rollover per log path so multiple sink instances writing the same
// file within one process cannot rotate it twice.
const rolloverQueues = new Map<string, Promise<void>>();

/**
 * Appends one JSON record per line. The file is opened per write, so the
 * active file can be renamed aside safely: on the first write of each UTC day
 * the previous day's file is rotated to `<stem>.<YYYY-MM-DD>.jsonl` and rotated
 * files older than the retention window are deleted. Rotation is best-effort
 * and never prevents the record from being written.
 */
export class JsonLineFileSink implements LogSink {
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private observedDay: string | undefined;

  constructor(
    private readonly filePath: string,
    options: JsonLineFileSinkOptions = {},
  ) {
    const retentionDays = options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
    if (!isValidLogRetentionDays(retentionDays)) {
      throw new Error("Log retentionDays must be a positive integer");
    }
    this.retentionDays = retentionDays;
    this.now = options.now ?? (() => new Date());
  }

  async write(record: LogRecord): Promise<void> {
    await Deno.mkdir(dirname(this.filePath), { recursive: true });
    const today = formatUtcDay(this.now());
    if (this.observedDay !== today) {
      await this.rollover(today);
    }
    await Deno.writeTextFile(
      this.filePath,
      `${JSON.stringify(record)}\n`,
      { append: true, create: true },
    );
  }

  private async rollover(today: string): Promise<void> {
    const previous = rolloverQueues.get(this.filePath) ?? Promise.resolve();
    const run = previous.then(async () => {
      try {
        await rotateLogFileIfStale(this.filePath, today);
      } catch {
        // Best-effort: keep appending to the active file.
      }
      try {
        await pruneRotatedLogFiles(this.filePath, today, this.retentionDays);
      } catch {
        // Best-effort: pruning is retried on the next rollover.
      }
    });
    rolloverQueues.set(this.filePath, run);
    try {
      await run;
    } finally {
      if (rolloverQueues.get(this.filePath) === run) {
        rolloverQueues.delete(this.filePath);
      }
    }
    this.observedDay = today;
  }
}

export class NoopSink implements LogSink {
  write(_record: LogRecord): void {
    // Intentionally empty for tests and dry scaffolding runs.
  }
}
