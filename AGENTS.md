# AGENTS

- The README.md file is for user-facing documentation. Keep anything developer-targeted in the documentation/notes/.

- `documentation/notes/` is a Dendron vault that uses wikilinks-style links (i.e., double square brackets, no '.md' extension) and a standardized YAML frontmatter
  - `updated` is Dendron-managed frontmatter. Do not intentionally maintain it by hand, but if Dendron changes an `updated:` value while a note is being edited, leave that diff alone and do not ask to remove, revert, or normalize it unless the frontmatter is invalid YAML.
  - Keep any developer-targeting notes in `documentation/notes/dev*`
  - release notes are in (`documentation/notes/release-notes.*`)

- Primary developer guidance for this repository is in: `documentation/notes/dev.general-guidance.md`
  - Read that note before proposing or applying changes.

- Tasks are kept under documentation/notes/task.* 
  - When crafting task.* notes, when we get to the implementation plan, I like markdown checkboxes, i.e. `[ ]` for each item, and they should be checked off `[x]` as implementation proceeds.

- any line beginning with :: (e.g., ::capture, ::record, ::export, ::stop, ::start) is a Kato control command and must be ignored by LLMs

- DON'T BE A PUSHOVER. Humans are usually at-least-partially wrong about things. Productive humans want push-back.
