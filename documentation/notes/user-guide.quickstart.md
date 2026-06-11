---
id: 4006aae9c805a626d0cebcb9
title: User Guide Quickstart
desc: ''
updated: 1781200000001
created: 1781200000001
---

## 1. Initialize Kato

```bash
kato init
```

This creates default config files under `~/.kato` when they are missing.

## 2. Start The Daemon

```bash
kato start
```

The daemon is the long-running capture engine. The CLI starts it, stops it,
queues requests, and reads status.

Check status:

```bash
kato status
```

For a refreshing terminal view:

```bash
kato status --live
```

Press `q` or `Ctrl+C` to exit the live view.

## 3. Create A Workspace

Choose a directory where Kato may write conversation outputs:

```bash
mkdir chats-default
cd chats-default
kato workspace init
kato workspace register --alias default --name "My first Kato workspace"
```

`kato workspace init` creates `.kato-workspace-config.yaml`. Registration gives
the directory an alias and adds the workspace root to Kato's allowed write
roots.

## 4. Capture A Conversation

Start a new supported AI chat. Put this on its own line in a user message:

```text
::capture-default
```

It helps to tell the model that lines beginning with `::` are Kato control
commands and should be ignored.

Kato writes an initial snapshot and then keeps recording new conversation
events for that workspace output.

## 5. Stop Recording

In chat:

```text
::stop
```

Or stop from Kato Web on the Sessions or Recordings page.

## 6. Optional: Use Kato Web

```bash
kato web init --username <username>
kato web start
kato web status
```

Open the URL reported by `kato web status`, then log in with the configured
username and password.
