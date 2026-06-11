---
id: fenubr668qxsy1dtv8r1a5c
title: User Guide
desc: ''
updated: 1775504358256
created: 1775504358256
---

Kato captures supported local AI conversations into files you control. Start
with [[user-guide.installation]] and [[user-guide.quickstart]] if you are new.

## Guide Index

- [[user-guide.installation]] - install, upgrade, and verify Kato.
- [[user-guide.quickstart]] - first daemon, first workspace, first capture.
- [[user-guide.workspaces]] - workspace aliases, output defaults, and write
  boundaries.
- [[user-guide.recording]] - sessions, captures, recordings, exports, and
  in-chat commands.
- [[user-guide.web]] - Kato Web setup, pages, and port behavior.
- [[user-guide.configuration]] - config files, redaction, usernames, and writer
  settings.
- [[user-guide.troubleshooting]] - status checks and common failure modes.

## Common Workflows

First setup:

```bash
kato init
kato start
```

Create and register a workspace:

```bash
mkdir chats-default
cd chats-default
kato workspace init
kato workspace register --alias default --name "My first Kato workspace"
```

Capture from a supported AI chat:

```text
::capture-default
```

Open Kato Web:

```bash
kato web init --username <username>
kato web start
kato web status
```

Use `kato help`, `kato help web`, and `kato help workspace` for the current
command reference.
