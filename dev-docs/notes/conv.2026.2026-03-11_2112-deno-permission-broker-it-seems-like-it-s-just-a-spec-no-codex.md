---
id: deno-permission-broker-i-06f703f1
title: 'deno permission broker : It seems like it''s just a spec, no…'
desc: ''
created: 1773288727257
updated: 1773288727257
participants: [djradon, codex.gpt-5.4]
kato-sessionIds: [019ce03e-44fd-72a2-9b60-f7ee3905916e]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [06f703f1-147c-4407-8537-20a7f1b99ac5]
conversationEventKinds: [message.user, message.assistant, tool.call, tool.result]
---

# djradon_2026-03-11_2112_07

deno permission broker : It seems like it's just a spec, not software I can use not?

::capture-k

# gpt-5.4_2026-03-11_2112_15

I’m checking the repo notes and current Deno references to verify whether “permission broker” is an implemented tool or only a proposal/spec.

# gpt-5.4_2026-03-11_2112_40

The local notes already frame it as an architectural option rather than a packaged dependency. I’m pulling the exact wording so I can answer this cleanly against both your notes and Deno’s current docs.

# gpt-5.4_2026-03-11_2113_07

The current Deno docs confirm the runtime hook is real, but they describe a socket/pipe protocol and schemas, not a bundled broker service. I’m checking your local Deno version as the last piece, because the feature only appeared in late 2025.

# gpt-5.4_2026-03-11_2113_40

I have enough context. The short answer is “real Deno feature, but not an off-the-shelf broker product”; I’m pulling the exact line in your note so I can tie that back to the repo wording.

# gpt-5.4_2026-03-11_2114_05

Yes. As of March 12, 2026, my read is: Deno’s permission broker is a real runtime feature, but not an off-the-shelf broker product you can just install and run.

Deno added it in `v2.5.3` on October 2, 2025, and the current docs say Deno connects to an external broker over a Unix socket or Windows named pipe, then sends every permission check to it. The docs define JSON request/response schemas and label it “Advanced use only.” My inference from that is that Deno ships the hook/protocol, not a ready-made broker daemon. Sources: [Deno security docs](https://docs.deno.com/runtime/fundamentals/security/), [Deno v2.5.3 release notes](https://github.com/denoland/deno/releases/tag/v2.5.3).

So the practical split is:

- If you mean “can I point Deno at my own broker implementation?”: yes.
- If you mean “is there an official Deno permission-broker service I can use directly?”: I did not find one.

For this repo, `[task.2026.2026-03-05-distribution-solutions.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-05-distribution-solutions.md#L16)` should be read as “Phase 2 custom integration candidate,” not “drop-in dependency.” Your local Deno is `2.7.4`, so the runtime side is available here if you want to prototype it.

If you want, I can tighten that note’s wording so it says `custom permission broker integration` instead of just `Permission Broker`.