---
id: 2cjk9ym4rj1kv78923st9du
title: 2026 02 26 Status Display
desc: ''
updated: 1772096865932
created: 1772096865932
---

# User_2026-02-26_0109_37

::capture /home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-26-status-display.md

Can you implement the exports as a new exports.jsonl in the ~/.kato/ folder. It should get cleand up by `kato clean --logs`

# gpt-5.3-codex_2026-02-26_0109_46

I’ll add a dedicated `exports.jsonl` under `~/.kato` and wire it into both export execution and `kato clean --logs`. First I’m mapping where export requests are processed and where log cleanup currently enumerates files.

# gpt-5.3-codex_2026-02-26_0109_56

I found CLI enqueue and clean logic. Next I’m inspecting daemon-side export processing so `exports.jsonl` can record real outcomes (success/pending/failure) and not just queue requests.

# gpt-5.3-codex_2026-02-26_0110_12

I confirmed where to hook this in. I’m now reading the existing CLI tests for `export` and `clean --logs` so I can add `exports.jsonl` with minimal churn and solid coverage.