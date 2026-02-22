export type InChatControlCommandName = "record" | "capture" | "export" | "stop";

export interface InChatControlCommand {
  name: InChatControlCommandName;
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

const COMMAND_LINE_PATTERN = /^\s*::([a-z][a-z0-9-]*)(?:\s+(.+))?\s*$/i;
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

  const name = match[1]?.toLowerCase();
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
          reason: "Command '::stop' does not accept arguments",
        },
      };
    }

    return {
      command: {
        ...commandBase,
        name,
      },
    };
  }

  if (name === "record" || name === "capture" || name === "export") {
    if (!argument || argument.length === 0) {
      return {
        error: {
          ...commandBase,
          reason: `Command '::${name}' requires a path argument`,
        },
      };
    }

    return {
      command: {
        ...commandBase,
        name,
        argument,
      },
    };
  }

  return {
    error: {
      ...commandBase,
      reason: `Unknown control command '::${name ?? ""}'`,
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
