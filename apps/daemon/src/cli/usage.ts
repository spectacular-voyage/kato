import type { DaemonCliCommandName } from "./types.ts";
import { DAEMON_APP_VERSION } from "../version.ts";

const APP_TAGLINE = "Own your AI conversations.";

function withAppHeader(usageBody: string): string {
  return [
    `kato ${DAEMON_APP_VERSION}`,
    APP_TAGLINE,
    "",
    usageBody,
  ].join("\n");
}

const GLOBAL_USAGE_BODY = [
  "Usage: kato <command> [options]",
  "       kato [--version|-V]",
  "",
  "Commands:",
  "  init                  Create default runtime config if missing",
  "  start                 Start daemon in detached background mode",
  "  restart               Stop then start daemon (start only if not running)",
  "  stop                  Queue daemon stop request (or reset stale status)",
  "  status [--json] [--all] [--live]",
  "                        Show daemon status",
  "  export <session-id> [--output <path>]",
  "                        Queue one-off export request",
  "  clean [--all|--recordings <days>|--sessions <days>] [--dry-run]",
  "                        Run cleanup immediately in CLI",
  "",
  "Run `kato help <command>` for command-specific usage.",
].join("\n");

const COMMAND_USAGE_BODY: Record<DaemonCliCommandName, string> = {
  init: [
    "Usage: kato init",
    "",
    "Creates a default local runtime config at ~/.kato/config.json when missing.",
  ].join("\n"),
  start: [
    "Usage: kato start",
    "",
    "Starts daemon runtime in detached background mode.",
    "Returns success after daemon heartbeat acknowledges startup.",
  ].join("\n"),
  restart: [
    "Usage: kato restart",
    "",
    "Stops daemon and starts it again. If daemon is not running, starts it.",
  ].join("\n"),
  stop: [
    "Usage: kato stop",
    "",
    "Queues daemon stop request or resets stale running status.",
  ].join("\n"),
  status: [
    "Usage: kato status [--json] [--all] [--live]",
    "",
    "Shows daemon state in text (default) or JSON form.",
    "",
    "  --json    Output as JSON (includes full memory and session fields)",
    "  --all     Include stale sessions",
    "  --live    Refresh-loop display; press q or Ctrl+C to exit (implies --all)",
  ].join("\n"),
  export: [
    "Usage: kato export <session-id> [--output <path>]",
    "",
    "Queues a one-off export request.",
  ].join("\n"),
  clean: [
    "Usage: kato clean [--all|--recordings <days>|--sessions <days>] [--dry-run]",
    "",
    "Runs cleanup in CLI.",
    "--all flushes runtime logs.",
    "--sessions deletes persisted session twins/metadata older than <days>.",
    "--sessions refuses to run while daemon status is actively running.",
    "--recordings is accepted but currently a no-op placeholder.",
  ].join("\n"),
};

export function getGlobalUsage(): string {
  return withAppHeader(GLOBAL_USAGE_BODY);
}

export function getCommandUsage(commandName: DaemonCliCommandName): string {
  return withAppHeader(COMMAND_USAGE_BODY[commandName]);
}
