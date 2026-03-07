# Kato

## Own your AI conversations.

Kato is your trusty sidekick for capturing chats, whether in your IDE, from a
code-assistant CLI,

## Features

- initiate a chat recording from within the chat interface
- capture to markdown or json
- automatically generate frontmatter for your markdown output files
- stop and start recording in-chat, as you go
- export entire conversations from the CLI or from within a chat
- specify the types of messages (thinking, tool calls, decisions) that you want
  to capture
- centralize conversations from multiple provider in a single location
- decentralize conversations into multiple locations

## Compatibility

| Provider    | VSCode                                                                     | CLI                                                                        | Local App                                                                  | Web App                                                                |
| ----------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Codex       | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | ![X](https://img.shields.io/badge/-%E2%9C%95-d1242f?style=flat-square) |
| Claude Code | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | ![X](https://img.shields.io/badge/-%E2%9C%95-d1242f?style=flat-square) |
| Gemini      | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | ![Check](https://img.shields.io/badge/-%E2%9C%93-2ea043?style=flat-square) | N/A                                                                        | ![X](https://img.shields.io/badge/-%E2%9C%95-d1242f?style=flat-square) |

`N/A` means the provider does not currently offer that interface.

## Installation

Prerequisite: Deno 2.x

Eventually, we'll have binary distributions. In the meantime, you have to clone
the repo:

```
# clone the Kato repository somewhere reasonable, like ~/github/kato
git clone https://github.com/spectacular-voyage/kato.git $HOME\github\kato
```

The rest of the installation depends on your platform...

### MacOS and Linux

```
# install deno if not already installed
curl -fsSL https://deno.land/install.sh | sh
```

Deno is not automatically appended to your PATH, so add these lines to the end
of your .zshrc:

```
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
```

While you're modifying your .zshrc, add an alias to
`<clone-location>/apps/cli/src/main.ts` for easy execution:

```
alias kato="deno run -A ~/github/kato/apps/cli/src/main.ts"
```

After modifying your path, you need to restart apps where applicable, e.g.:
VSCode, Terminal

### Windows (Powershell)

Install Deno:

```
irm https://deno.land/install.ps1 | iex
```

Modify your Powershell $PROFILE for easy execution:

```
function kato {
  deno run -A "$HOME\github\kato\apps\cli\src\main.ts" @args
}
```

Then open a new Powershell window or try `.$PROFILE`

## Quickstart

```
kato init
kato start

# Switch to a directory where you'd like to record chats
# In Kato, this is known as a workspace
cd chats-default

# Initialize your new workspace, and register it with an alias
kato workspace init
kato workspace register alias=default
```

Then start a new LLM chat (suggestion: the first line should be a good title for
the chat), on any new line, type `::capture-default` (or
`::capture-<whatever alias you defined for your workspace>`).

These "in-chat kato commands" can be confusing for LLMs, so you might want to
add something like "ignore all kato commands, which start with `::` on a new
line" to your message, system prompt, or guidance files.

### Example First Message

```
Our First Kato Session

Can you recommend solutions for capturing LLM conversations from vscode extensions and CLI tools?

Please ignore Kato commands, like this next line:
::capture-default
```

## In-Chat Kato Commands

Kato also watches user messages for in-chat control commands:

- `::capture-<alias> [<path>]` (start a recording from the beginning of the
  conversation)
- `::record-<alias> [<path>]` (start a recording from this point in the
  conversation)
- `::stop` (stop all recordings)
- `::stop-<alias>`
- `::export-<alias> [<path>]`

Rules:

- `::record`, `::capture`, and `::export` require a workspace alias suffix.
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

## CLI Command Reference

Supported commands:

- `--version` / `-V`
  - Print the CLI version.
- `init`
  - Create missing daemon/shared/CLI/user config plus default workspace template
    files (template only; not conversation outputs).
  - Uses global `~/.kato` by default. If `./.kato` exists in the current
    directory, kato warns and continues with global state.
- `start`
  - Start daemon in detached background mode.
  - CLI returns success only after daemon heartbeat acknowledges startup.
  - If config is missing, auto-init runs by default
    (`KATO_AUTO_INIT_ON_START=true`).
  - Disable auto-init by setting `KATO_AUTO_INIT_ON_START=false`.
  - Uses global `~/.kato` by default; `./.kato` is ignored unless
    `KATO_RUNTIME_DIR` is explicitly set.
- `restart`
  - Stop daemon and start it again.
  - If daemon is not running, behaves like `start`.
  - Uses global `~/.kato` by default; `./.kato` is ignored unless
    `KATO_RUNTIME_DIR` is explicitly set.
- `stop`
  - Queue daemon stop request (or reset stale status if heartbeat is stale).
- `status [--json]`
  - Show daemon status.
  - Text mode includes a `Recent Errors` section sourced from runtime
    operational/security-audit WARN and ERROR log entries.
- `workspace init [<dir>]`
  - Create `<dir>/.kato-workspace-config.yaml`.
  - If `<dir>` is omitted, uses the current working directory.
- `workspace register [<dir>] --alias <alias>`
  - Register a workspace config under an explicit workspace alias.
  - If `<dir>` is provided, Kato uses exactly
    `<dir>/.kato-workspace-config.yaml`.
  - If `<dir>` is omitted, Kato searches nearest ancestors from the current
    working directory.
  - Adds the workspace root to shared `allowedWriteRoots` when missing.
  - Running daemon permissions remain startup-bound; restart to apply newly
    added write roots.
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
    (`~/.kato/shared/sessions/*.meta.json`, `*.twin.jsonl`) older than `<days>`.
  - `--sessions` refuses to run while daemon status is actively running.
  - `--recordings` is currently an accepted placeholder.
- `user <init|map|default|exclude-me>`
  - Manage participant username settings in `~/.kato/kato-user-config.yaml`.
  - `user map` manages workspace-specific username mappings.

Workspace registration changes are visible to a running daemon for new
alias-scoped commands without a restart. Changes to an already-registered
workspace's alias, root, or config path are restart-bound.

Runtime root precedence:

1. `KATO_RUNTIME_DIR` (must be absolute or `~/...`; relative values are
   rejected).
2. Home default `~/.kato/daemon` (from `HOME`/`USERPROFILE`).
3. No implicit `./.kato` fallback. If home cannot be resolved and no override is
   set, CLI/daemon startup fails with remediation text.

## Runtime Files

Default paths:

- Daemon config: `~/.kato/daemon/kato-daemon-config.yaml`
- CLI config: `~/.kato/cli/kato-cli-config.yaml`
- Shared config: `~/.kato/shared/kato-shared-config.yaml`
- User config: `~/.kato/kato-user-config.yaml`
- Default workspace template:
  `~/.kato/shared/default-kato-workspace-config.yaml`
- Workspace registry: `~/.kato/shared/workspace-registry.json`
- Status: `~/.kato/shared/status.json`
- Control queue: `~/.kato/shared/ipc/daemon-control.json`
- Daemon session index cache: `~/.kato/shared/daemon-control.json`
- Session metadata + twins: `~/.kato/shared/sessions/*.meta.json` and
  `~/.kato/shared/sessions/*.twin.jsonl`
- Workspace-local config: `<workspace>/.kato-workspace-config.yaml`

Session metadata is authoritative; `shared/daemon-control.json` is a rebuildable
cache index. `kato-daemon-config.yaml` is daemon-only process config.
`kato-shared-config.yaml` owns shared policy and plain export defaults.
`kato-cli-config.yaml` is CLI-local settings (currently logging).
`~/.kato` is runtime/config/session state, not a workspace output root.

Captured/exported
conversation files are written to registered workspace roots.


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
providerAutoGenerateSnapshots:
  codex: true
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
- `kato init` creates daemon/shared/cli/user config files plus workspace
  template.
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
`<workspace>/.kato-workspace-config.yaml` share the same runtime output shape.
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
  writerIncludeToolCalls: false
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

## User Workspace Mapping

User-to-workspace username mapping is configured in
`~/.kato/kato-user-config.yaml` (`participants.workspaceUsernames`) and managed
by CLI commands:

```bash
kato user init
kato user map set <workspace-alias-or-id> <username>
kato user map list
kato user map delete <workspace-alias-or-id>
kato user default set <username>
kato user default clear
kato user exclude-me <true|false>
```

Participant username precedence for frontmatter is:

1. If `excludeMeFromParticipantList` is `true`, no username is emitted.
2. If a workspace-specific mapping exists for the resolved `workspaceId`, use
   that mapped username.
3. Otherwise, use `defaultUsername` when non-empty.

Frontmatter user entries are emitted as plain usernames (for example `djradon`)
without a `user.` prefix.

## Filename Templating

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

- `{username}`: resolved username slug (`workspaceUsernames[workspaceId]` ->
  `defaultUsername` -> `unknown-user`)

defaultOutputDir supports the same template tokens as `filenameTemplate`.

## Timezone

`workspaceTimezone` and `exportTimezone` accept:

- `"local"`: daemon process local timezone
- `"UTC"`
- any valid IANA timezone id (for example `"America/Los_Angeles"`)

## Known Issues

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

[![Coverage](https://codecov.io/gh/spectacular-voyage/kato/graph/badge.svg?branch=main)](https://codecov.io/gh/spectacular-voyage/kato)

---

<p align="center">
  <img src="https://spectacular.voyage/assets/2026-03_kato-wordmark_v2_black-outline.png" alt="Kato wordmark" width="560" />
</p>
