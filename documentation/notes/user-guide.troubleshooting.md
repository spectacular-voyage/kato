---
id: 2e87765200421f77224b9b0a
title: User Guide Troubleshooting
desc: ''
updated: 1781200000006
created: 1781200000006
---

## Check Status First

```bash
kato status
kato status --all
kato status --live
```

Use `--all` to include stale sessions. In live mode, press `f` to flush shown
errors and `q` or `Ctrl+C` to exit.

## Daemon Is Not Running

```bash
kato start
```

If startup fails, check the config paths mentioned in the error and the daemon
logs under `~/.kato/daemon/logs/`. Earlier days are in rotated files such as `operational.2026-11-07.jsonl`; see [[user-guide.configuration#logs]] for retention.

## A Session Shows "Ingestion Failing"

Kato could not read that conversation's provider transcript, so it is not capturing new content from it. The error text in Kato Web (Summary, Sessions) or `kato status` says why; details are in `~/.kato/daemon/logs/operational.jsonl` under `provider.ingestion.parse_error`. Retries continue automatically and capture resumes from where it stopped once the file is readable.

## A Recording Is Missing Content

Look for `recording.append.gap` in `~/.kato/daemon/logs/operational.jsonl`. It means content arrived faster than Kato could write it and older events were no longer in memory (usually a very large backlog after downtime), so the recording continues after a gap. Export the conversation again if you need the complete text.

## High CPU Right After `kato start`

If conversations kept going while the daemon was stopped (or while it could not read them), Kato catches them up after it starts, one conversation at a time, and appends the missed content to any recordings that are on. A large backlog can keep the daemon busy for a minute or two. `provider.ingestion.catch_up.queued` in `~/.kato/daemon/logs/operational.jsonl` lists the conversations being caught up.

## Web Is Not Opening

```bash
kato web status
```

Use the URL reported by status. If the preferred port was busy, Kato Web may be
running on the next available port.

If status says web is stopped:

```bash
kato web start
```

## No Sessions Appear

- Confirm the daemon is running.
- Confirm the provider is supported in [[compatibility]].
- Confirm the provider has written local transcript/session files.
- Confirm daemon `providerSessionRoots` include the provider's session
  location.
- Try `kato status --all` in case the session is stale.

## In-Chat Command Did Nothing

- Put the command on its own line.
- Use a registered workspace alias, for example `::capture-default`.
- Confirm `kato workspace list` shows the alias.
- Confirm the daemon is running.
- Tell the AI assistant to ignore lines that begin with `::`; the model may
  otherwise respond to the command as prose.

## Write Denied

Kato writes only under allowed workspace roots unless a command path is
explicitly permitted by policy.

Run:

```bash
kato workspace register --alias <alias> <workspace-dir>
```

Registration restarts the daemon by default when it expands the write boundary.
If you used `--no-restart`, run:

```bash
kato restart
```

## Clean Old Runtime Artifacts

```bash
kato clean --logs
kato clean --twins <days>
kato clean --twins <days> --delete-metadata
kato clean --dry-run --twins <days>
```

`--logs` empties the active log files and deletes rotated ones. Rotated logs older than `logging.retentionDays` (default 30) are also deleted automatically.

`--recordings` is accepted by the CLI but is currently a placeholder.
