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

Run CLI commands through the daemon entry point (source/dev invocation):

```bash
deno run -A apps/daemon/src/main.ts <command> [options]
```

`-A` grants broad permissions and is intended for local
source-running/development. For production packaging, prefer a compiled binary
(`deno compile`) with explicit least-privilege permissions for your runtime
paths.

First run:

```bash
deno run -A apps/daemon/src/main.ts init
deno run -A apps/daemon/src/main.ts start
deno run -A apps/daemon/src/main.ts status
```

Stop:

```bash
deno run -A apps/daemon/src/main.ts stop
```

## Command Reference

Supported commands:

- `--version` / `-V`
  - Print the daemon CLI version.
- `init`
  - Create default runtime config if missing.
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
- `export <session-id> [--output|-o <path>] [--format|-f markdown|jsonl]`
  - Queue one-off export request for the specified session id.
  - `--format markdown` (default): render as a human-readable markdown file.
  - `--format jsonl` / `-f jsonl`: emit one canonical `ConversationEvent` JSON
    object per line.
  - When `--output` is omitted, the daemon chooses a default path.
- `clean [--all|--recordings <days>|--sessions <days>] [--dry-run]`
  - Run cleanup immediately in the CLI.
  - `--all` flushes runtime logs.
  - `--sessions <days>` removes persisted session artifacts
    (`~/.kato/sessions/*.meta.json`, `*.twin.jsonl`) older than `<days>`.
  - `--sessions` refuses to run while daemon status is actively running.
  - `--recordings` is currently an accepted placeholder.

Usage help:

```bash
deno run -A apps/daemon/src/main.ts help
deno run -A apps/daemon/src/main.ts help start
deno run -A apps/daemon/src/main.ts --version
```

## In-Chat Recording Commands

Kato also watches user messages for in-chat control commands:

- `::start [<destination>]`
- `::capture [<destination>]`
- `::stop`
- `::stop id:<recording-id-or-prefix>`
- `::stop dest:<destination>`

When destination is omitted for `::start` / `::capture`, kato generates a file
under `~/.kato/recordings/`.

## Runtime Files

Default paths:

- Config: `~/.kato/kato-config.yaml`
- Status: `~/.kato/runtime/status.json`
- Control queue: `~/.kato/runtime/control.json`
- Daemon session index cache: `~/.kato/daemon-control.json`
- Session metadata + twins: `~/.kato/sessions/*.meta.json` and
  `~/.kato/sessions/*.twin.jsonl`

Session metadata is authoritative; `daemon-control.json` is a rebuildable cache.

## Runtime Config

Default config shape:

```yaml
schemaVersion: 1
runtimeDir: ~/.kato/runtime
statusPath: ~/.kato/runtime/status.json
controlPath: ~/.kato/runtime/control.json
allowedWriteRoots:
  - .
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
markdownFrontmatter:
  includeFrontmatterInMarkdownRecordings: true
  includeUpdatedInFrontmatter: false
  addParticipantUsernameToFrontmatter: false
  defaultParticipantUsername: ""
  includeConversationKinds: false
featureFlags:
  writerIncludeCommentary: true
  writerIncludeThinking: false
  writerIncludeToolCalls: false
  writerItalicizeUserMessages: false
  daemonExportEnabled: true
  captureIncludeSystemEvents: false
logging:
  operationalLevel: info
  auditLevel: info
daemonMaxMemoryMb: 500
```

Notes:

- Runtime config is validated fail-closed at startup.
- `providerSessionRoots` controls provider ingestion discovery roots and daemon
  read-scope narrowing.
- `globalAutoGenerateSnapshots` controls default SessionTwin generation
  behavior. `false` means twins are generated while recordings are active (or
  on-demand).
- `providerAutoGenerateSnapshots` can override `globalAutoGenerateSnapshots` per
  provider (`claude`, `codex`, `gemini`).
- `cleanSessionStatesOnShutdown=true` deletes persisted `*.twin.jsonl` files at
  daemon shutdown while retaining session metadata/index.
- `markdownFrontmatter` controls markdown frontmatter behavior:
  - `includeFrontmatterInMarkdownRecordings` (default `true`)
  - `includeUpdatedInFrontmatter` (default `false`)
  - `addParticipantUsernameToFrontmatter` (default `false`)
  - `defaultParticipantUsername` preferred username when username inclusion is enabled.
    Fallback order is: `defaultParticipantUsername` -> `USER`/`USERNAME` env
    vars -> home-directory basename.
  - `includeConversationKinds` to add `kind.*` tags (default `false`)
- Missing provider root keys in legacy configs are backfilled with defaults
  (including `gemini`).
- Missing `logging` config in legacy files is backfilled to:
  - `operationalLevel: "info"`
  - `auditLevel: "info"`
- Runtime log level precedence is:
  - `KATO_LOGGING_OPERATIONAL_LEVEL` / `KATO_LOGGING_AUDIT_LEVEL` env override
  - `runtimeConfig.logging`
- `daemonMaxMemoryMb` is the global in-memory snapshot budget.
- `KATO_DAEMON_MAX_MEMORY_MB` is used only when generating a default config
  (`init`/auto-init). Precedence for generated config is: explicit value > env
  var > `500`.
- `allowedWriteRoots` gates user-requested output paths (`record`, `capture`,
  `export`), not daemon-owned runtime artifacts (`status.json`, `control.json`,
  runtime logs).
- Unknown `featureFlags` keys are rejected.
- Older daemon builds may fail to start with newer config files containing
  additional flags.

## Current MVP Status

Working now:

- CLI control-plane commands (`init`, `start`, `restart`, `stop`, `status`,
  `export`, `clean`)
- Detached daemon launcher and heartbeat/status snapshots
- Provider ingestion for `claude`, `codex`, and `gemini` with persisted ingest
  cursors
- Persistent SessionTwin state (`~/.kato/sessions/*.twin.jsonl`) and per-session
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
