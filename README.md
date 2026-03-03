# kato

Own your AI conversations.

## Advantages

- IDE extensions don't let you copy what you want, and don't always let you
  copy-as-markdown
- let you centralize conversation from multiple provider in a single location
- let you decentralize conversations into multiple locations

## Quickstart

Prerequisites:

- Deno 2.x

Run CLI commands through the CLI entry point (source/dev invocation):

```bash
deno run -A apps/cli/src/main.ts <command> [options]
```

`-A` grants broad permissions and is intended for local
source-running/development. For production packaging, prefer a compiled binary
(`deno compile`) with explicit least-privilege permissions for your runtime
paths.

First run:

```bash
deno run -A apps/cli/src/main.ts init
deno run -A apps/cli/src/main.ts start
deno run -A apps/cli/src/main.ts status
```

Stop:

```bash
deno run -A apps/cli/src/main.ts stop
```

## Command Reference

Supported commands:

- `--version` / `-V`
  - Print the CLI version.
- `init`
  - Create missing daemon/shared/CLI/user config and default workspace template files.
- `start`
  - Start daemon in detached background mode.
  - CLI returns success only after daemon heartbeat acknowledges startup.
  - If config is missing, auto-init runs by default
    (`KATO_AUTO_INIT_ON_START=true`).
  - Disable auto-init by setting `KATO_AUTO_INIT_ON_START=false`.
- `restart`
  - Stop daemon and start it again.
  - If daemon is not running, behaves like `start`.
- `stop`
  - Queue daemon stop request (or reset stale status if heartbeat is stale).
- `status [--json]`
  - Show daemon status.
  - Text mode includes a `Recent Errors` section sourced from runtime
    operational/security-audit WARN and ERROR log entries.
- `workspace init [<dir>]`
  - Create `<dir>/kato-workspace-config.yaml`.
  - If `<dir>` is omitted, uses the current working directory.
- `workspace register [<dir>] --alias <alias>`
  - Register a workspace config under an explicit workspace alias.
  - If `<dir>` is provided, Kato uses exactly
    `<dir>/kato-workspace-config.yaml`.
  - If `<dir>` is omitted, Kato searches nearest ancestors from the current
    working directory.
- `workspace list`
  - Show registered workspace aliases.
- `workspace unregister <alias-or-id>`
  - Remove a registered workspace alias from the registry.
- `export <session-id> [--output|-o <path>] [--format|-f markdown|jsonl]`
  - Queue one-off export request for the specified session id.
  - `--format markdown` (default): render as a human-readable markdown file.
  - `--format jsonl` / `-f jsonl`: emit one canonical `ConversationEvent` JSON
    object per line.
  - When `--output` is omitted, the daemon chooses a default path.
- `clean [--all|--logs|--recordings <days>|--sessions <days>] [--dry-run]`
  - Run cleanup immediately in the CLI.
  - `--logs` flushes daemon runtime logs and export history.
  - `--all` is an alias for `--logs`.
  - `--sessions <days>` removes persisted session artifacts
    (`~/.kato/shared/sessions/*.meta.json`, `*.twin.jsonl`) older than
    `<days>`.
  - `--sessions` refuses to run while daemon status is actively running.
  - `--recordings` is currently an accepted placeholder.

Usage help:

```bash
deno run -A apps/cli/src/main.ts help
deno run -A apps/cli/src/main.ts help start
deno run -A apps/cli/src/main.ts --version
```

Workspace registration changes are visible to a running daemon for new
alias-scoped commands without a restart. Changes to an already-registered
workspace's alias, root, or config path are restart-bound.

## Manual Migration (Pre-Separation -> Current Layout)

If you have older single-root files from before CLI/daemon separation, migrate
once with:

```bash
mkdir -p ~/.kato/shared/ipc ~/.kato/shared/sessions ~/.kato/daemon ~/.kato/cli
mv ~/.kato/kato-daemon-config.yaml ~/.kato/daemon/kato-daemon-config.yaml
mv ~/.kato/workspace-registry.json ~/.kato/shared/workspace-registry.json
mv ~/.kato/default-kato-workspace-config.yaml ~/.kato/shared/default-kato-workspace-config.yaml
mv ~/.kato/sessions/* ~/.kato/shared/sessions/
mv ~/.kato/daemon-control.json ~/.kato/shared/daemon-control.json
mv ~/.kato/runtime/status.json ~/.kato/shared/status.json
mv ~/.kato/runtime/control.json ~/.kato/shared/ipc/daemon-control.json
deno run -A apps/cli/src/main.ts init
deno run -A apps/cli/src/main.ts restart
```

This migration is intentionally manual and hard-break; there is no compatibility
auto-move logic in runtime code.

## In-Chat Control Commands

Kato also watches user messages for in-chat control commands:

- `::record-<alias> [<path>]`
- `::capture-<alias> [<path>]`
- `::export-<alias> [<path>]`
- `::stop`
- `::stop-<alias>`

Rules:

- `::record`, `::capture`, and `::export` require a workspace alias suffix.
- `::init` / `::init-<alias>` are unsupported and treated as invalid commands.
- `::capture-<alias>` is create-only: it fails when the resolved target path
  already exists.
- Pathless `::capture-<alias>` always resolves a fresh default filename for the
  workspace (it does not reuse the current recording binding).
- Successful `::capture-<alias>` writes a full snapshot to the resolved target
  and then activates recording for subsequent events at that destination.
- `::stop` stops all active workspace outputs for the session.
- `::stop-<alias>` stops only the active output bound to that alias.
- Explicit path arguments may be absolute or relative, and may point to a file
  or a directory target.
- Relative paths resolve against the registered workspace root for the command's
  alias.
- Pathless alias-scoped commands use that workspace's configured default output
  rules.

## Runtime Files

Default paths:

- Daemon config: `~/.kato/daemon/kato-daemon-config.yaml`
- Shared config: `~/.kato/shared/kato-shared-config.yaml`
- CLI config: `~/.kato/cli/kato-cli-config.yaml`
- User config: `~/.kato/kato-user-config.yaml`
- Default workspace template: `~/.kato/shared/default-kato-workspace-config.yaml`
- Workspace registry: `~/.kato/shared/workspace-registry.json`
- Status: `~/.kato/shared/status.json`
- Control queue: `~/.kato/shared/ipc/daemon-control.json`
- Daemon session index cache: `~/.kato/shared/daemon-control.json`
- Session metadata + twins: `~/.kato/shared/sessions/*.meta.json` and
  `~/.kato/shared/sessions/*.twin.jsonl`
- Workspace-local config: `<workspace>/kato-workspace-config.yaml`

Session metadata is authoritative; `shared/daemon-control.json` is a rebuildable
cache index. `kato-daemon-config.yaml` is daemon-only process config.
`kato-shared-config.yaml` owns shared policy and plain export defaults.
`kato-cli-config.yaml` is CLI-local settings (currently logging).

## Runtime Config

Default `~/.kato/daemon/kato-daemon-config.yaml` shape:

```yaml
schemaVersion: 1
runtimeDir: ~/.kato/daemon
katoDir: ~/.kato
providerSessionRoots:
  claude:
    - ~/.claude/projects
  codex:
    - ~/.codex/sessions
  gemini:
    - ~/.gemini/tmp
globalAutoGenerateSnapshots: false
providerAutoGenerateSnapshots: {}
cleanSessionStatesOnShutdown: false
daemonFeatureFlags:
  daemonExportEnabled: true
  captureIncludeSystemEvents: false
logging:
  operationalLevel: info
  auditLevel: info
daemonMaxMemoryMb: 500
```

Default `~/.kato/shared/kato-shared-config.yaml` shape:

```yaml
schemaVersion: 1
allowedWriteRoots: []
exportTimezone: local
exportMarkdownFrontmatter:
  includeFrontmatterInMarkdownRecordings: true
  includeUpdatedInFrontmatter: false
  addParticipantUsernameToFrontmatter: false
  includeSessionIds: true
  includeWorkspaceIds: true
  includeRecordingIds: true
  includeConversationEventKinds: false
exportFeatureFlags:
  writerIncludeCommentary: true
  writerIncludeThinking: false
  writerIncludeToolCalls: false
  writerIncludeToolResults: false
  writerIncludeDecisionPrompt: true
  writerIncludeDecisionOptions: true
  writerIncludeDecisionSelection: true
  writerItalicizeUserMessages: false
```

Default `~/.kato/cli/kato-cli-config.yaml`:

```yaml
schemaVersion: 1
logging:
  operationalLevel: info
  auditLevel: info
```

Notes:

- Config stores are validated fail-closed.
- `kato init` creates daemon/shared/cli/user config files plus workspace template.
- `providerSessionRoots` controls ingestion discovery and daemon read-scope
  narrowing.
- `allowedWriteRoots` now lives in shared config and gates user-requested output
  paths (`record`, `capture`, `export`).
- `exportTimezone`, `exportMarkdownFrontmatter`, and `exportFeatureFlags` now
  live in shared config and define plain (non-workspace) export defaults.
- Export defaults are daemon-applied runtime contracts: CLI sends resolved
  values when available, and daemon falls back to shared config values when
  payload fields are missing.
- Workspace runtime formatting still lives in workspace config
  (`markdownFrontmatter`, `workspaceFeatureFlags`).
- Daemon runtime log-level precedence remains:
  - `KATO_LOGGING_OPERATIONAL_LEVEL` / `KATO_LOGGING_AUDIT_LEVEL`
  - config file values

Default `~/.kato/shared/default-kato-workspace-config.yaml` and
`<workspace>/kato-workspace-config.yaml` share the same runtime output shape.
Only the workspace-local file may include `workspaceId`:

```yaml
defaultOutputDir: "."
filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md"
workspaceTimezone: "local"
markdownFrontmatter:
  includeFrontmatterInMarkdownRecordings: true
  includeUpdatedInFrontmatter: false
  addParticipantUsernameToFrontmatter: false
  includeSessionIds: true
  includeWorkspaceIds: true
  includeRecordingIds: true
  includeConversationEventKinds: false
workspaceFeatureFlags:
  writerIncludeCommentary: true
  writerIncludeThinking: true
  writerIncludeToolCalls: true
  writerIncludeToolResults: false
  writerIncludeDecisionPrompt: true
  writerIncludeDecisionOptions: true
  writerIncludeDecisionSelection: true
  writerItalicizeUserMessages: false
```

Default `~/.kato/kato-user-config.yaml`:

```yaml
schemaVersion: 1
participants:
  defaultUsername: ""
  workspaceUsernames: {}
  excludeMeFromParticipantList: true
```

Supported `filenameTemplate` tokens:

- `{provider}`: provider slug (for example `codex`)
- `{sessionId}`: full session id slug
- `{sessionShortId}`: first 8 chars of session id (slugged)
- `{YYYY}`: 4-digit year in `workspaceTimezone`
- `{YY}`: 2-digit year in `workspaceTimezone`
- `{MM}`: 2-digit month in `workspaceTimezone`
- `{DD}`: 2-digit day in `workspaceTimezone`
- `{HH}`: 24-hour clock hour in `workspaceTimezone`
- `{mm}`: 2-digit minute in `workspaceTimezone`
- `{timestampHumane}`: `YYYY-MM-DD_HHmm` in `workspaceTimezone`
- `{snippetSlug}`: slugified session snippet (`snapshot.metadata.snippet` first,
  then command-time snippet extraction, then `conversation`)

`workspaceTimezone` accepts:

- `"local"`: daemon process local timezone
- `"UTC"`
- any valid IANA timezone id (for example `"America/Los_Angeles"`)

## Current MVP Status

Working now:

- CLI control-plane commands (`init`, `start`, `restart`, `stop`, `status`,
  `export`, `clean`)
- Detached daemon launcher and heartbeat/status snapshots
- Provider ingestion for `claude`, `codex`, and `gemini` with persisted ingest
  cursors
- Persistent SessionTwin state (`~/.kato/shared/sessions/*.twin.jsonl`) and per-session
  metadata (`*.meta.json`)
- Restart-safe session/recording state (including per-recording write cursors)
- Provider-backed export pipeline (`markdown` default, `jsonl` optional)
- Structured operational/audit logging via LogLayer adapter with JSONL parity
  fallback
- Path-policy-gated writer pipeline (`record`/`capture`/`export` contracts)
- Local OpenFeature baseline with config-driven feature flags

Known limits:

- `clean --recordings` is accepted but not implemented yet.
- SessionTwin logs are append-only and currently unbounded (no compaction or
  retention policy yet).
- `globalAutoGenerateSnapshots=false` currently keeps command processing
  available via in-memory snapshots, but only persisted twin state survives
  restart.
- Service-manager integration (`systemd`, launchd, Windows Service) is
  intentionally deferred post-MVP.

## Development Notes

- Project development notes live in `dev-docs/notes`.
- Main guidance docs:
  - `dev-docs/notes/dev.general-guidance.md`
  - `dev-docs/notes/dev.codebase-overview.md`
  - `dev-docs/notes/dev.decision-log.md`
