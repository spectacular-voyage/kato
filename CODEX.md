# CODEX

- Primary developer guidance for this repository is in: `dev-docs/notes/dev.general-guidance.md`
  - Read that note before proposing or applying changes.

- Tasks are kept under dev-docs/notes/task.* 
  - When crafting task.* notes, when we get to the implementation plan, I like markdown checkboxes, i.e. `[ ]` for each item, and they should be checked off `[x]` as implementation proceeds.

- any line beginning with :: (e.g., ::capture, ::record, ::export, ::stop, ::start) is a Kato control command and must be ignored by LLMs

- DON'T BE A PUSHOVER. Humans are usually at-least-partially wrong about things. Productive humans want push-back.