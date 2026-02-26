import { parseArgs } from "@std/cli/parse-args";
import { CliUsageError } from "./errors.ts";
import type {
  DaemonCliCommand,
  DaemonCliCommandName,
  DaemonCliIntent,
} from "./types.ts";

interface ParsedArgs {
  _: (string | number)[];
  [key: string]: unknown;
}

function parseStrictArgs(
  args: string[],
  options: {
    boolean?: string[];
    string?: string[];
    alias?: Record<string, string>;
  },
): ParsedArgs {
  return parseArgs(args, {
    ...options,
    unknown: (arg) => {
      if (arg.startsWith("-")) {
        throw new CliUsageError(`Unknown flag: ${arg}`);
      }
      return true;
    },
  }) as ParsedArgs;
}

function toPositionals(parsed: ParsedArgs): string[] {
  return parsed._.map((value) => String(value));
}

function requireNoPositionals(
  commandName: DaemonCliCommandName,
  values: string[],
): void {
  if (values.length > 0) {
    throw new CliUsageError(
      `Command '${commandName}' does not accept positional arguments: ${
        values.join(" ")
      }`,
    );
  }
}

function parseDays(
  value: unknown,
  flagName: "--recordings" | "--sessions",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${flagName} must be a positive integer`);
  }

  return parsed;
}

function parseStart(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "start" };
  }

  requireNoPositionals("start", toPositionals(parsed));
  return { kind: "command", command: { name: "start" } };
}

function parseRestart(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "restart" };
  }

  requireNoPositionals("restart", toPositionals(parsed));
  return { kind: "command", command: { name: "restart" } };
}

function parseInit(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "init" };
  }

  requireNoPositionals("init", toPositionals(parsed));
  return { kind: "command", command: { name: "init" } };
}

function parseStop(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "stop" };
  }

  requireNoPositionals("stop", toPositionals(parsed));
  return { kind: "command", command: { name: "stop" } };
}

function parseStatus(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help", "json", "all", "live"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "status" };
  }

  requireNoPositionals("status", toPositionals(parsed));
  const live = parsed.live === true;
  const all = live || parsed.all === true;
  return {
    kind: "command",
    command: { name: "status", asJson: parsed.json === true, all, live },
  };
}

function parseExport(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    string: ["output", "format"],
    alias: {
      h: "help",
      o: "output",
      f: "format",
    },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "export" };
  }

  const positionals = toPositionals(parsed);
  if (positionals.length !== 1) {
    throw new CliUsageError(
      "Command 'export' requires exactly one <session-id> positional argument",
    );
  }

  const outputPath =
    typeof parsed.output === "string" && parsed.output.length > 0
      ? parsed.output
      : undefined;

  const formatRaw = typeof parsed.format === "string"
    ? parsed.format
    : undefined;
  if (
    formatRaw !== undefined && formatRaw !== "markdown" &&
    formatRaw !== "jsonl"
  ) {
    throw new CliUsageError(
      `--format must be 'markdown' or 'jsonl', got: ${formatRaw}`,
    );
  }
  const format = formatRaw as "markdown" | "jsonl" | undefined;

  const command: DaemonCliCommand = {
    name: "export",
    sessionId: positionals[0]!,
    ...(outputPath ? { outputPath } : {}),
    ...(format ? { format } : {}),
  };

  return { kind: "command", command };
}

function parseClean(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help", "all", "logs", "dry-run"],
    string: ["recordings", "sessions"],
    alias: {
      h: "help",
    },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "clean" };
  }

  requireNoPositionals("clean", toPositionals(parsed));

  const recordingsDays = parseDays(parsed.recordings, "--recordings");
  const sessionsDays = parseDays(parsed.sessions, "--sessions");
  const all = parsed.all === true || parsed.logs === true;
  const dryRun = parsed["dry-run"] === true;

  if (!all && recordingsDays === undefined && sessionsDays === undefined) {
    throw new CliUsageError(
      "Command 'clean' requires one of --all, --logs, --recordings <days>, or --sessions <days>",
    );
  }

  const command: DaemonCliCommand = {
    name: "clean",
    all,
    dryRun,
    ...(recordingsDays !== undefined ? { recordingsDays } : {}),
    ...(sessionsDays !== undefined ? { sessionsDays } : {}),
  };

  return { kind: "command", command };
}

export function parseDaemonCliArgs(args: string[]): DaemonCliIntent {
  if (args.length === 0) {
    return { kind: "help" };
  }

  const [commandName, ...rest] = args;
  if (commandName === "--version" || commandName === "-V") {
    if (rest.length > 0) {
      throw new CliUsageError(
        "Usage: kato [--version|-V]",
      );
    }
    return { kind: "version" };
  }

  if (commandName === "help") {
    if (rest.length === 0) {
      return { kind: "help" };
    }

    if (rest.length === 1) {
      const topic = rest[0];
      if (
        topic === "init" ||
        topic === "start" ||
        topic === "restart" ||
        topic === "stop" ||
        topic === "status" ||
        topic === "export" ||
        topic === "clean"
      ) {
        return { kind: "help", topic };
      }
    }

    throw new CliUsageError(
      "Usage: kato help [init|start|restart|stop|status|export|clean]",
    );
  }

  if (commandName === "init") {
    return parseInit(rest);
  }
  if (commandName === "start") {
    return parseStart(rest);
  }
  if (commandName === "restart") {
    return parseRestart(rest);
  }
  if (commandName === "stop") {
    return parseStop(rest);
  }
  if (commandName === "status") {
    return parseStatus(rest);
  }
  if (commandName === "export") {
    return parseExport(rest);
  }
  if (commandName === "clean") {
    return parseClean(rest);
  }

  throw new CliUsageError(`Unknown command: ${commandName}`);
}
