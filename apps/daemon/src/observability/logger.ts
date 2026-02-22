import { dirname } from "@std/path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  channel: "operational" | "security-audit";
  event: string;
  message: string;
  attributes?: Record<string, unknown>;
}

export interface LogSink {
  write(record: LogRecord): Promise<void> | void;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLoggerOptions {
  minLevel?: LogLevel;
  channel: LogRecord["channel"];
  now?: () => Date;
}

export class StructuredLogger {
  private readonly minLevel: LogLevel;
  private readonly channel: LogRecord["channel"];
  private readonly now: () => Date;

  constructor(
    private readonly sinks: readonly LogSink[],
    options: StructuredLoggerOptions,
  ) {
    this.minLevel = options.minLevel ?? "info";
    this.channel = options.channel;
    this.now = options.now ?? (() => new Date());
  }

  async log(
    level: LogLevel,
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      channel: this.channel,
      event,
      message,
      ...(attributes && Object.keys(attributes).length > 0
        ? { attributes }
        : {}),
    };

    for (const sink of this.sinks) {
      await sink.write(record);
    }
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
