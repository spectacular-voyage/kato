---
id: 592d7c6d7ba4fa814884ac82
title: User Guide Web
desc: ''
updated: 1781200000004
created: 1781200000004
---

## Initialize Web Auth

```bash
kato web init --username <username>
```

On an interactive terminal, Kato prompts for a password. You can also provide a
password through `KATO_WEB_PASSWORD` or `--password-stdin`; run
`kato help web` for the exact syntax.

## Start And Open

```bash
kato web start
kato web status
```

Open the URL reported by `kato web status`. The default login route is:

```text
http://127.0.0.1:5173/login
```

Use the actual reported URL if Kato Web selected a different port.

## Port Selection

Kato Web treats the configured host/port as a preference. The default preferred
URL is `http://127.0.0.1:5173/`.

When `kato web start` sees that port is already in use, it tries the next port
up until it finds an available one. For example, if Windows is already serving
Kato Web at `127.0.0.1:5173`, a WSL2 Kato Web start can choose
`127.0.0.1:5174` instead.

Use `kato web status` to see the actual running URL.

## Lifecycle Commands

```bash
kato web start
kato web restart
kato web stop
kato web status
kato web status --json
```

## Pages

- Summary: high-level daemon, session, recording, and workspace status.
- Sessions: discovered provider sessions grouped into default-closed parent/sub-conversation trees, snippets, persisted-twin size indicators, activity/workspace filters, and capture/record controls with creation-time title, filename snippet, and tag fields. Claude sessions display Claude's own session title when one exists (a `/rename` custom title first, then the AI-generated title), falling back to the first user message. Sessions with a persisted twin link to a read-only detail page (`View`) that renders the twin's conversation content — messages expanded, thinking/tool/system events collapsed — with seq-cursor paging and the same secrets redaction as snippets; Recordings rows link to it too.
- Recordings: per-file output state, output tag editing, stop controls, and re-arm controls.
- Workspaces: registration, display labels, shared workspace config editing, shared tag fields, username overrides, and workspace diagnostics.
- Logs: operational and security-audit records.
- Settings: user-default, workspace username mapping, and personal tag suggestion workflows.
- Maintenance: cleanup flows and persisted twin troubleshooting.

## Session Inventory Trees

The Sessions page always keeps recognized sub-conversations available beneath their provider parent, but every parent starts collapsed so routine workflows occupy one row. The toolbar retains activity and workspace filters; there is no separate sub-conversation visibility mode. Old bookmarks containing `subagents=hide` show the normal grouped inventory because legacy `subagents` query parameters are ignored.

The parent disclosure summarizes descendant count, active/recording state, and available child Twin bytes. Expanding it renders the normal child rows with their own activity, actions, recordings, and individual `Twin` values. Open branches remain open while the page refreshes live. A link to a child session automatically expands its ancestor chain, and Sessions actions return to that child.

Kato recognizes Claude children from the provider's exact `subagents` source layout. Codex children use the explicit immediate `parent_thread_id` recorded in Codex `session_meta`, so nested Codex agents can form real recursive trees. Kato does not infer children from repeated titles, timing, `agent-*` ids, or similar filenames. Recognized children whose parent is unavailable remain accessible under `Unlinked sub-conversations`.

When an activity or workspace filter matches a child but not its parent, Kato retains the parent as a visibly marked context row so the child remains reachable. Context-only parents do not increase the matching totals.

## Session Twin Size

Each Sessions row shows `Twin <size>` when Kato has recognized persisted twin history, or `Twin absent` when no usable twin size is available. Sizes use 1024-based units (`B`, `KB`, `MB`, `GB`, and `TB`) and update with the live Sessions view.

Twin size measures Kato's normalized JSONL history, not the provider transcript, a recording output, elapsed time, turns, or tokens. Treat it as a rough length cue: JSONL and tool-event overhead affect the value, and the twin can represent only partial conversation history when persistence began after the provider conversation started.

The Sessions page keeps this indicator read-only and does not expose the twin path. Use Maintenance for twin paths, current/behind state, troubleshooting, and cleanup actions.

## Auth Expiry

Kato Web fails closed when auth expires. If one tab detects an expired session,
other tabs should converge back to `/login`.
