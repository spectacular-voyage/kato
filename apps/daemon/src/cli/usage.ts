import type { DaemonCliCommandName } from "./types.ts";

const GLOBAL_USAGE = [
  "Usage: kato <command> [options]",
  "",
  "Commands:",
  "  start                 Mark daemon as running (scaffold mode)",
  "  stop                  Mark daemon as stopped",
  "  status [--json]       Show daemon status",
  "  export <session-id> [--output <path>]",
  "                        Queue one-off export request (scaffold mode)",
  "  clean [--all|--recordings <days>|--sessions <days>] [--dry-run]",
  "                        Queue cleanup request (scaffold mode)",
  "",
  "Run `kato help <command>` for command-specific usage.",
].join("\n");

const COMMAND_USAGE: Record<DaemonCliCommandName, string> = {
  start: [
    "Usage: kato start",
    "",
    "Marks daemon state as running for initial migration scaffolding.",
  ].join("\n"),
  stop: [
    "Usage: kato stop",
    "",
    "Marks daemon state as stopped for initial migration scaffolding.",
  ].join("\n"),
  status: [
    "Usage: kato status [--json]",
    "",
    "Shows daemon state in text (default) or JSON form.",
  ].join("\n"),
  export: [
    "Usage: kato export <session-id> [--output <path>]",
    "",
    "Queues a one-off export request (export pipeline not implemented yet).",
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
