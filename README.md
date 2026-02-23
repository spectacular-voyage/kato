# kato

Own your AI conversations.

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

- `init`
  - Create default runtime config if missing.
- `start`
  - Start daemon in detached background mode.
  - If config is missing, auto-init runs by default
    (`KATO_AUTO_INIT_ON_START=true`).
  - Disable auto-init by setting `KATO_AUTO_INIT_ON_START=false`.
- `stop`
  - Queue daemon stop request (or reset stale status if heartbeat is stale).
- `status [--json]`
  - Show daemon status.
- `export <session-id> [--output <path>]`
  - Queue one-off export request for the specified session id.
- `clean [--all|--recordings <days>|--sessions <days>] [--dry-run]`
  - Queue cleanup request.

Usage help:

```bash
deno run -A apps/daemon/src/main.ts help
deno run -A apps/daemon/src/main.ts help start
```

## Runtime Files

Default paths:

- Config: `~/.kato/config.json`
- Status: `~/.kato/runtime/status.json`
- Control queue: `~/.kato/runtime/control.json`

## Runtime Config

Default config shape:

```json
{
  "schemaVersion": 1,
  "runtimeDir": "~/.kato/runtime",
  "statusPath": "~/.kato/runtime/status.json",
  "controlPath": "~/.kato/runtime/control.json",
  "allowedWriteRoots": [
    "."
  ],
  "providerSessionRoots": {
    "claude": [
      "~/.claude/projects"
    ],
    "codex": [
      "~/.codex/sessions"
    ]
  },
  "featureFlags": {
    "writerIncludeThinking": true,
    "writerIncludeToolCalls": true,
    "writerItalicizeUserMessages": false,
    "daemonExportEnabled": true
  }
}
```

Notes:

- Runtime config is validated fail-closed at startup.
- `providerSessionRoots` controls provider ingestion discovery roots and daemon
  read-scope narrowing.
- Unknown `featureFlags` keys are rejected.
- Older daemon builds may fail to start with newer config files containing
  additional flags.

## Current MVP Status

Working now:

- CLI control-plane commands (`init`, `start`, `stop`, `status`, `export`,
  `clean`)
- Detached daemon launcher and heartbeat/status snapshots
- Path-policy-gated writer pipeline (`record`/`capture`/`export` contracts)
- Local OpenFeature baseline with config-driven feature flags

Known limits:

- Provider ingestion/session store wiring is still in progress.
- Export processing requires a wired runtime session loader and may be skipped
  until provider wiring is complete.
- Service-manager integration (`systemd`, launchd, Windows Service) is
  intentionally deferred post-MVP.

## Development Notes

- Project development notes live in `dev-docs/notes`.
- Main guidance docs:
  - `dev-docs/notes/dev.general-guidance.md`
  - `dev-docs/notes/dev.codebase-overview.md`
  - `dev-docs/notes/dev.decision-log.md`
