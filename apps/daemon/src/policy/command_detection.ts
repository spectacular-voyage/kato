export type InChatControlCommandName =
  | "record"
  | "capture"
  | "export"
  | "stop";

export interface InChatControlCommand {
  verb: InChatControlCommandName;
  name: InChatControlCommandName;
  alias?: string;
  argument?: string;
  line: number;
  raw: string;
}

export interface InChatControlCommandError {
  line: number;
  raw: string;
  reason: string;
}

export interface InChatControlDetectionResult {
  commands: InChatControlCommand[];
  errors: InChatControlCommandError[];
}

interface FenceState {
  marker: "`" | "~";
  length: number;
}

const COMMAND_LINE_PATTERN = /^\s*::([^\s]+)(?:\s+(.+))?\s*$/;
const FENCE_PATTERN = /^\s*([`~]{3,})/;

function parseFenceToken(line: string): FenceState | undefined {
  const match = line.match(FENCE_PATTERN);
  if (!match) {
    return undefined;
  }

  const token = match[1] ?? "";
  const marker = token[0];
  if (marker !== "`" && marker !== "~") {
    return undefined;
  }

  return {
    marker,
    length: token.length,
  };
}

function isFenceClose(line: string, state: FenceState): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length < state.length) {
    return false;
  }

  let count = 0;
  while (count < trimmed.length && trimmed[count] === state.marker) {
    count += 1;
  }

  if (count < state.length) {
    return false;
  }

  return trimmed.slice(count).trim().length === 0;
}

function parseCommandLine(
  rawLine: string,
  line: number,
): {
  command?: InChatControlCommand;
  error?: InChatControlCommandError;
} {
  const match = rawLine.match(COMMAND_LINE_PATTERN);
  if (!match) {
    return {};
  }

  const rawName = match[1];
  const name = rawName?.toLowerCase();
  const argument = match[2]?.trim();
  const commandBase = {
    line,
    raw: rawLine,
  };

  if (name === "stop") {
    if (argument && argument.length > 0) {
      return {
        error: {
          ...commandBase,
          reason: `Command '::${name}' does not accept arguments`,
        },
      };
    }
    return {
      command: {
        ...commandBase,
        verb: "stop",
        name: "stop",
      },
    };
  }

  const verbPrefixes: Array<{
    prefix: string;
    verb: InChatControlCommandName;
    allowArgument: boolean;
  }> = [
    { prefix: "record-", verb: "record", allowArgument: true },
    { prefix: "capture-", verb: "capture", allowArgument: true },
    { prefix: "export-", verb: "export", allowArgument: true },
    { prefix: "stop-", verb: "stop", allowArgument: false },
  ];
  for (const prefixEntry of verbPrefixes) {
    if (!name?.startsWith(prefixEntry.prefix) || !rawName) {
      continue;
    }
    const alias = rawName.slice(prefixEntry.prefix.length).trim();
    if (alias.length === 0) {
      return {
        error: {
          ...commandBase,
          reason: `Command '::${rawName}' is missing an alias suffix`,
        },
      };
    }
    if (!prefixEntry.allowArgument && argument && argument.length > 0) {
      return {
        error: {
          ...commandBase,
          reason: `Command '::${rawName}' does not accept arguments`,
        },
      };
    }
    return {
      command: {
        ...commandBase,
        verb: prefixEntry.verb,
        name: prefixEntry.verb,
        alias,
        ...(argument && argument.length > 0 ? { argument } : {}),
      },
    };
  }

  if (name === "init" || name?.startsWith("init-")) {
    return {
      error: {
        ...commandBase,
        reason: `Unsupported control command '::${
          rawName ?? ""
        }'. Use ::record-<alias>, ::capture-<alias>, or ::export-<alias>.`,
      },
    };
  }

  if (name === "record" || name === "capture" || name === "export") {
    return {
      error: {
        ...commandBase,
        reason:
          `Command '::${name}' requires a workspace alias suffix (for example ::${name}-default)`,
      },
    };
  }

  return {
    error: {
      ...commandBase,
      reason: `Unknown control command '::${rawName ?? ""}'`,
    },
  };
}

export function detectInChatControlCommands(
  text: string,
): InChatControlDetectionResult {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const commands: InChatControlCommand[] = [];
  const errors: InChatControlCommandError[] = [];

  let fenceState: FenceState | undefined;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = i + 1;

    if (fenceState) {
      if (isFenceClose(rawLine, fenceState)) {
        fenceState = undefined;
      }
      continue;
    }

    const fenceToken = parseFenceToken(rawLine);
    if (fenceToken) {
      fenceState = fenceToken;
      continue;
    }

    const parsed = parseCommandLine(rawLine, line);
    if (parsed.command) {
      commands.push(parsed.command);
    }
    if (parsed.error) {
      errors.push(parsed.error);
    }
  }

  return { commands, errors };
}
