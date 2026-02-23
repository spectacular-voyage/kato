import type { DaemonCliCommandName } from "./types.ts";

const GLOBAL_USAGE = [
  "Usage: kato <command> [options]",
  "",
  "Commands:",
  "  init                  Create default runtime config if missing",
  "  start                 Start daemon in detached background mode",
  "  stop                  Queue daemon stop request (or reset stale status)",
  "  status [--json]       Show daemon status",
  "  export <session-id> [--output <path>]",
  "                        Queue one-off export request",
  "  clean [--all|--recordings <days>|--sessions <days>] [--dry-run]",
  "                        Queue cleanup request",
  "",
  "Run `kato help <command>` for command-specific usage.",
].join("\n");

const COMMAND_USAGE: Record<DaemonCliCommandName, string> = {
  init: [
    "Usage: kato init",
    "",
    "Creates a default local runtime config at ~/.kato/config.json when missing.",
  ].join("\n"),
  start: [
    "Usage: kato start",
    "",
    "Starts daemon runtime in detached background mode.",
  ].join("\n"),
  stop: [
    "Usage: kato stop",
    "",
    "Queues daemon stop request or resets stale running status.",
  ].join("\n"),
  status: [
    "Usage: kato status [--json]",
    "",
    "Shows daemon state in text (default) or JSON form.",
  ].join("\n"),
  export: [
    "Usage: kato export <session-id> [--output <path>]",
    "",
    "Queues a one-off export request.",
  ].join("\n"),
  clean: [
    "Usage: kato clean [--all|--recordings <days>|--sessions <days>] [--dry-run]",
    "",
    "Queues a cleanup request for recordings/session metadata.",
  ].join("\n"),
};

export function getGlobalUsage(): string {
  return GLOBAL_USAGE;
}

export function getCommandUsage(commandName: DaemonCliCommandName): string {
  return COMMAND_USAGE[commandName];
}
