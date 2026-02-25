import { dirname } from "@std/path";
import {
  createLogLayerChannel,
  type LogLayerChannelLike,
} from "./loglayer_adapter.ts";
import type { LogLevel, LogRecord, LogSink } from "./log_record.ts";

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

export class JsonLineFileSink implements LogSink {
  constructor(private readonly filePath: string) {}

  async write(record: LogRecord): Promise<void> {
    await Deno.mkdir(dirname(this.filePath), { recursive: true });
    await Deno.writeTextFile(
      this.filePath,
      `${JSON.stringify(record)}\n`,
      { append: true, create: true },
    );
  }
}

export class NoopSink implements LogSink {
  write(_record: LogRecord): void {
    // Intentionally empty for tests and dry scaffolding runs.
  }
}
