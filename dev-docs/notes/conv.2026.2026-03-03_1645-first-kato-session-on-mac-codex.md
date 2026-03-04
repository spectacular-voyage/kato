---
id: first-kato-session-on-ma-1e30fe84
title: 'first kato session on Mac'
desc: ''
created: 1772585142263
updated: 1772585142263
kato-sessionIds: [019cb64a-5d41-7530-b359-9cf19f081575]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [1e30fe84-be1a-4ce5-a4b4-6cb425b2e19c, 98992b7f-1d75-49bb-b9ac-d4fd77027361]
conversationEventKinds: [message.user, message.assistant, thinking, tool.call, tool.result]
participants: [codex.gpt-5.3-codex]
---

# User_2026-03-03_1645_42

first kato session on Mac

::capture-k

**Preparing to investigate user command**

# gpt-5.3-codex_2026-03-03_1645_42

I’ll check the project docs for the `::capture-k` flow and run the first-session steps for macOS from there. I’m starting by reading `README.md` and nearby setup files.

**Inspecting README for session triggers**

# gpt-5.3-codex_2026-03-03_1645_47

I found the relevant setup section in `README.md`; next I’m pulling just the Mac + first-session steps so I can confirm exactly what command should be used for your alias.

**Inspecting user alias availability**

# gpt-5.3-codex_2026-03-03_1645_52

The quickstart command format is `::capture-<alias>`. I’ll verify your registered workspace aliases so we can confirm whether `::capture-k` is valid in this environment.

**Checking Deno environment and run commands**

# gpt-5.3-codex_2026-03-03_1645_57

`kato` isn’t on PATH yet (`command not found`), so `::capture-k` won’t work until the CLI is installed or invoked via Deno. I’m checking whether Deno is available so I can give you the exact command to run next.

**Verifying Deno and Kato installation steps**

**Investigating CLI usage**

**Searching install instructions**

**Reviewing setup instructions**

**Planning kato session setup**

# gpt-5.3-codex_2026-03-03_1646_17

I checked the local docs/code: lines starting with `::` are Kato control commands intended for the Kato daemon, not for me to execute directly here. I’ll locate the CLI entrypoint so I can give you the exact macOS install/run commands for your first session.

**Identifying correct router path**

**Preparing user guidance**

**Checking workspace alias source**

# gpt-5.3-codex_2026-03-03_1646_27

I confirmed your shell has `alias k=deno run -A .../apps/cli/src/main.ts`, and your user config is present. I’ll quickly verify whether workspace alias `k` is registered, since `::capture-k` depends on that alias specifically.

# User_2026-03-03_1654_20

::record-k

**Ignoring specific commands**

# gpt-5.3-codex_2026-03-03_1654_20

Ignored (`::record-k`).

# User_2026-03-03_1655_25

Excellent work. Is there a less-perjorative term for vibe-coding?

# gpt-5.3-codex_2026-03-03_1655_25

“Flow-driven development” is a solid less-pejorative option.

Other good alternatives:
- “Exploratory coding”
- “Rapid prototyping”
- “Intent-first coding”
- “Collaborative AI-assisted development”

# User_2026-03-03_1655_45

but something catchy

# gpt-5.3-codex_2026-03-03_1655_45

“Promptcraft” is catchy and less pejorative.

Runner-ups:
- “Codeflow”
- “Flowcode”
- “Prompt-to-Prod”
- “IntentOps”