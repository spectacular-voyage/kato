---
id: per-workspace-daemon-ins-019ca269
title: 2026 02 27 per Workspace Daemons
desc: ''
updated: 1772251753376
created: 1772251753376
participants:
  - user.djradon
  - codex.gpt-5.3-codex
sessionId: 019ca269-7f1d-7861-a0f4-f886e3bae577
recordingIds:
  - f6674fb1-6a40-49e7-804a-1f6679d228e7
conversationEventKinds:
  - message.user
  - thinking
  - message.assistant
  - tool.call
  - tool.result
---

# User_2026-02-27_2009_13

Per-workspace daemon instances

I figured out a solution for workspace-specific kato usage: just "kato init" in the workspace, and you can specify the default path, filename template, and ConversationEventKind capture settings in the workspace-specific config.

I don't even think we need to change much, just add the defaultOutputPath and filename template.

::capture /home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-27-per-workspace-daemons

**Planning code inspection**

# gpt-5.3-codex_2026-02-27_2009_20

I’m treating this as a code change: wire workspace-local `kato init` config to support `defaultOutputPath` and a filename template, with minimal surface area. I’ll inspect the config schema, `kato init`, and the capture/output path logic first so the change lands in the right layer.

**Targeting key config files**

# gpt-5.3-codex_2026-02-27_2009_27

The relevant pieces are in the daemon config layer and `init`. I’m narrowing to the config contract, runtime loader, and init scaffolding so we can add the two new fields without disturbing command handling.