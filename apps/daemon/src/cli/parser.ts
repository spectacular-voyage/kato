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

function parseWorkspaceInit(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "workspace-init" };
  }

  const positionals = toPositionals(parsed);
  if (positionals.length > 1) {
    throw new CliUsageError(
      "Command 'workspace init' accepts at most one optional <dir> positional argument",
    );
  }

  return {
    kind: "command",
    command: {
      name: "workspace-init",
      ...(positionals[0] ? { dirPath: positionals[0] } : {}),
    },
  };
}

function parseWorkspaceRegister(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    string: ["alias"],
    alias: { h: "help", a: "alias" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "workspace-register" };
  }

  requireNoPositionals("workspace-register", toPositionals(parsed));
  const alias = typeof parsed.alias === "string" && parsed.alias.length > 0
    ? parsed.alias
    : undefined;
  return {
    kind: "command",
    command: { name: "workspace-register", ...(alias ? { alias } : {}) },
  };
}

function parseWorkspaceList(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "workspace-list" };
  }

  requireNoPositionals("workspace-list", toPositionals(parsed));
  return { kind: "command", command: { name: "workspace-list" } };
}

function parseWorkspaceUnregister(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "workspace-unregister" };
  }

  const positionals = toPositionals(parsed);
  if (positionals.length !== 1) {
    throw new CliUsageError(
      "Command 'workspace unregister' requires exactly one <alias-or-id> positional argument",
    );
  }

  return {
    kind: "command",
    command: { name: "workspace-unregister", selector: positionals[0]! },
  };
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

function parseAttach(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    string: ["output"],
    alias: {
      h: "help",
      o: "output",
    },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "attach" };
  }

  const positionals = toPositionals(parsed);
  if (positionals.length !== 1) {
    throw new CliUsageError(
      "Command 'attach' requires exactly one <session-id> positional argument",
    );
  }

  const outputPath =
    typeof parsed.output === "string" && parsed.output.length > 0
      ? parsed.output
      : undefined;

  return {
    kind: "command",
    command: {
      name: "attach",
      sessionId: positionals[0]!,
      ...(outputPath ? { outputPath } : {}),
    },
  };
}

function parseAttachments(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help", "all"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "attachments" };
  }

  requireNoPositionals("attachments", toPositionals(parsed));
  return {
    kind: "command",
    command: { name: "attachments", all: parsed.all === true },
  };
}

function parseDetach(rest: string[]): DaemonCliIntent {
  const parsed = parseStrictArgs(rest, {
    boolean: ["help"],
    alias: { h: "help" },
  });

  if (parsed.help === true) {
    return { kind: "help", topic: "detach" };
  }

  const positionals = toPositionals(parsed);
  if (positionals.length !== 1) {
    throw new CliUsageError(
      "Command 'detach' requires exactly one <session-id> positional argument",
    );
  }

  return {
    kind: "command",
    command: {
      name: "detach",
      sessionId: positionals[0]!,
    },
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
        topic === "workspace-init" ||
        topic === "workspace-register" ||
        topic === "workspace-list" ||
        topic === "workspace-unregister" ||
        topic === "attach" ||
        topic === "attachments" ||
        topic === "detach" ||
        topic === "export" ||
        topic === "clean"
      ) {
        return { kind: "help", topic };
      }
    }

    throw new CliUsageError(
      "Usage: kato help [init|start|restart|stop|status|workspace-init|workspace-register|workspace-list|workspace-unregister|attach|attachments|detach|export|clean]",
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
  if (commandName === "workspace") {
    const [subcommand, ...subRest] = rest;
    if (!subcommand) {
      throw new CliUsageError(
        "Usage: kato workspace <init|register|list|unregister> [options]",
      );
    }
    if (subcommand === "init") {
      return parseWorkspaceInit(subRest);
    }
    if (subcommand === "register") {
      return parseWorkspaceRegister(subRest);
    }
    if (subcommand === "list") {
      return parseWorkspaceList(subRest);
    }
    if (subcommand === "unregister") {
      return parseWorkspaceUnregister(subRest);
    }
    throw new CliUsageError(`Unknown workspace subcommand: ${subcommand}`);
  }
  if (commandName === "attach") {
    return parseAttach(rest);
  }
  if (commandName === "attachments") {
    return parseAttachments(rest);
  }
  if (commandName === "detach") {
    return parseDetach(rest);
  }
  if (commandName === "export") {
    return parseExport(rest);
  }
  if (commandName === "clean") {
    return parseClean(rest);
  }

  throw new CliUsageError(`Unknown command: ${commandName}`);
}
