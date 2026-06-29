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
- Sessions: discovered provider sessions, snippets, and capture/record
  controls.
- Recordings: per-file output state, stop controls, and re-arm controls.
- Workspaces: registration, display labels, shared workspace config editing, username overrides, and workspace diagnostics.
- Logs: operational and security-audit records.
- Settings: user-default and workspace username mapping workflows.
- Maintenance: cleanup flows and persisted twin troubleshooting.

## Auth Expiry

Kato Web fails closed when auth expires. If one tab detects an expired session,
other tabs should converge back to `/login`.
