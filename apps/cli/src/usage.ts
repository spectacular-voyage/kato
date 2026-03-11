import type { DaemonCliCommandName } from "./types.ts";
import { CLI_APP_VERSION } from "./version.ts";

const APP_TAGLINE = "Own your AI conversations.";

function withAppHeader(usageBody: string): string {
  return [
    `kato ${CLI_APP_VERSION}`,
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
  "  init                  Create default global config files if missing",
  "  start                 Start daemon in detached background mode",
  "  restart               Stop then start daemon (start only if not running)",
  "  stop                  Queue daemon stop request (or reset stale status)",
  "  status [--json] [--all] [--live]",
  "                        Show daemon status",
  "  web <init|start|stop|status>",
  "                        Configure and manage the local web operator console",
  "  workspace <init|register|list|unregister>",
  "                        Manage workspace aliases and local workspace config",
  "  export <session-id> [--output <path>]",
  "                        Queue one-off export request",
  "  clean [--all|--logs|--recordings <days>|--twins <days> [--delete-metadata]] [--dry-run]",
  "                        Run cleanup immediately in CLI",
  "  user <init|map|default|exclude-me>",
  "                        Manage per-user participant username settings",
  "",
  "Run `kato help <command>` for command-specific usage.",
].join("\n");

const COMMAND_USAGE_BODY: Record<DaemonCliCommandName, string> = {
  init: [
    "Usage: kato init",
    "",
    "Creates ~/.kato/daemon/kato-daemon-config.yaml, ~/.kato/shared/kato-shared-config.yaml, ~/.kato/cli/kato-cli-config.yaml, ~/.kato/shared/default-kato-workspace-config.yaml, and ~/.kato/kato-user-config.yaml when missing.",
    "Uses global ~/.kato by default; local ./.kato is ignored unless KATO_RUNTIME_DIR is explicitly set to an absolute path.",
  ].join("\n"),
  start: [
    "Usage: kato start",
    "",
    "Starts daemon runtime in detached background mode.",
    "Returns success after daemon heartbeat acknowledges startup.",
    "Uses global ~/.kato by default; set KATO_RUNTIME_DIR to an absolute path (or ~/...) to use another runtime root.",
  ].join("\n"),
  restart: [
    "Usage: kato restart",
    "",
    "Stops daemon and starts it again. If daemon is not running, starts it.",
    "Uses global ~/.kato by default; set KATO_RUNTIME_DIR to an absolute path (or ~/...) to use another runtime root.",
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
    "  --live    Refresh-loop display; press q/Ctrl+C to exit, f to flush errors (persisted, implies --all)",
  ].join("\n"),
  web: [
    "Usage:",
    "  KATO_WEB_PASSWORD=<password> kato web init --username <username> [--host <hostname>] [--port <port>]",
    "  secret-tool read kato/web | kato web init --username <username> --password-stdin [--host <hostname>] [--port <port>]",
    "  kato web start",
    "  kato web stop",
    "  kato web status [--json]",
    "",
    "Initializes explicit web config, hashed credentials, and the local web server lifecycle.",
    "`kato web start` refuses to run until `kato web init` has created config.",
  ].join("\n"),
  "workspace-init": [
    "Usage: kato workspace init [<dir>]",
    "",
    "Creates <dir>/.kato-workspace-config.yaml using the default template.",
    "If <dir> is omitted, uses the current working directory.",
  ].join("\n"),
  "workspace-register": [
    "Usage: kato workspace register [<dir>] [--alias <alias>]",
    "",
    "Registers a workspace config under a workspace alias.",
    "If <dir> is provided, registers exactly <dir>/.kato-workspace-config.yaml.",
    "If <dir> is omitted, uses the nearest ancestor workspace config from the current directory.",
    "If --alias is omitted, uses the leaf workspace folder name as the alias.",
  ].join("\n"),
  "workspace-list": [
    "Usage: kato workspace list",
    "",
    "Lists registered workspaces.",
  ].join("\n"),
  "workspace-unregister": [
    "Usage: kato workspace unregister <alias-or-id>",
    "",
    "Removes a registered workspace alias from the registry.",
  ].join("\n"),
  export: [
    "Usage: kato export <session-id> [--output <path>]",
    "",
    "Queues a one-off export request.",
  ].join("\n"),
  clean: [
    "Usage: kato clean [--all|--logs|--recordings <days>|--twins <days> [--delete-metadata]] [--dry-run]",
    "",
    "Runs cleanup in CLI.",
    "--logs flushes daemon runtime logs plus ~/.kato/daemon/exports.jsonl.",
    "--all is an alias for --logs.",
    "--twins deletes persisted twin files older than <days> and rewrites matching metadata to canonical no-twin state.",
    "--delete-metadata also deletes matching twin metadata files; use only with --twins.",
    "--recordings is accepted but currently a no-op placeholder.",
  ].join("\n"),
  user: [
    "Usage:",
    "  kato user init",
    "  kato user map set <workspace-alias-or-id> <username>",
    "  kato user map list [--json]",
    "  kato user map delete <workspace-alias-or-id>",
    "  kato user default set <username>",
    "  kato user default clear",
    "  kato user exclude-me <true|false>",
    "",
    "Manages ~/.kato/kato-user-config.yaml participant settings.",
    "Workspace selectors must resolve to a registered workspace alias or workspaceId.",
  ].join("\n"),
};

export function getGlobalUsage(): string {
  return withAppHeader(GLOBAL_USAGE_BODY);
}

export function getCommandUsage(commandName: DaemonCliCommandName): string {
  return withAppHeader(COMMAND_USAGE_BODY[commandName]);
}
