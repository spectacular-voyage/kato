---
id: iy29i0zhnexvuncl7trjia7
title: 2026 04 06 Kato Website
desc: ''
updated: 1775502170948
created: 1775502170948
---

## Goal

Build a static Kato website from the Dendron note vault in `documentation/notes`
that emits real HTML pages instead of a JavaScript shell, while preserving the
meaningful Dendron note hierarchy and note-link semantics that the current
notes already use.

## Summary

The site should be generated from the current note vault, not hand-copied into
a second documentation tree.

For this first slice, publish only:

- `root.md` as the homepage
- `dev.*` notes under a `Development` section
- `user-guide.md` as the `User Guide` section landing page
- `compatibility.md` as an in-scope `User Guide` page
- `release-notes.*.md` under a `Release Notes` section
- `contributor.*` notes under a `Contributors` section
- standalone pages for `features.md`, `roadmap.md`, and `product-ideas.md`

Do not reuse Dendron's current Next.js publishing template. The main product
need here is committed, inspectable HTML output with a predictable static
layout, not a client-heavy render path.

Do not contort Weave's future architecture around this task. A dedicated
"Dendron-note static site generator" can exist separately from any future
general-purpose Weave renderer/publisher.

## Discussion

### Why not use Dendron's stock publish path

The current Dendron publish story is centered on a Next.js template. That may
be fine for some Dendron sites, but it is the wrong output shape for Kato's
notes site because too much of the content ends up living behind JavaScript.
The generated site should look like a traditional static site: meaningful HTML
source, working direct links, and no requirement that client code reconstruct
the page body.

### Why not force Lume into this immediately

Lume has useful ideas, especially custom loaders and a small Deno-native
extension surface. But for this repository, the hard part is not generic page
templating. The hard part is the Dendron-specific source interpretation:

- note classification into public sections
- dot-delimited note hierarchy
- Dendron wikilinks such as `[[note]]` and `[[note#heading]]`
- selective publication instead of "publish everything in the vault"
- consistent internal linking even when some referenced notes stay unpublished

That makes a small purpose-built generator the lowest-risk first step. If we
later want to lift the Dendron parsing/rendering pieces into a reusable library
or adapter for Weave or Lume, we can do that from a working implementation.

### Dendron feature scope for the first pass

Support only the Dendron features the current published-note set actually uses:

- dot-delimited note hierarchy from filenames
- YAML frontmatter extraction
- `[[note]]` wikilinks
- `[[note#heading]]` wikilinks
- pass-through raw HTML blocks that are already valid in Markdown, including
  `<details>` / `<summary>`

Out of scope for the first pass:

- Dendron transclusion / note refs
- block anchors
- alias/link-label preservation syntax
- full parity with Dendron publish behavior
- publishing conversations, tasks, completed notes, or cancelled notes

### Public identity and URL contract

The public site should not expose Dendron's current random `id` values in URLs.
But the current source filename alone is also not enough, because note renames
would then silently change published URLs.

Use curated Dendron `id` values for every in-scope published note. For
published notes, `id` becomes the canonical published hierarchy used for URL
generation. Existing random ids should be rewritten once from the current
source taxonomy plus the chosen public section mounts, then treated as the
stable published identity.

For the first slice, the id-migration rules should be:

- `root` => homepage `/`
- `dev` => `development`
- `dev.*` => `development.*`
- `user-guide` => `user-guide`
- `compatibility` => `user-guide.compatibility`
- `release-notes.*` => `release-notes.*`
- `contributor.*` => `contributors.*`
- `features` => `features`
- `roadmap` => `roadmap`
- `product-ideas` => `product-ideas`

Examples:

- `dev.general-guidance` => `id: development.general-guidance` =>
  `/development/general-guidance/`
- `user-guide` => `id: user-guide` => `/user-guide/`
- `compatibility` => `id: user-guide.compatibility` =>
  `/user-guide/compatibility/`

This means `user-guide.md` defines the section landing page, but child URLs
should not be inferred from the current source filename at render time. They
should be derived during migration and then stored as each note's curated
`id`.

If a source note is currently in the wrong hierarchy for public publication,
fix that before freezing curated ids. `docs.benefits` has already been moved to
top-level `features`, which should produce `/features/`.

### Unpublished note links

When a published page links to a note that exists in the vault but is
intentionally unpublished, fall back to the note's GitHub source URL instead of
pretending the note is publishable or leaving a dead internal link.

For this repository that should target the current source-vault path under
`documentation/notes/`, for example:

- `https://github.com/spectacular-voyage/kato/blob/main/documentation/notes/conv.2026.2026-02-24-status.md`

This gives users a readable fallback because GitHub already renders Markdown
nicely for repository files. But GitHub's renderer should remain a fallback
destination only, not part of the Kato site build pipeline.

### Markdown rendering posture

Do not call GitHub's Markdown API during site builds. That would make the build
network-dependent, couple output shape to GitHub's private renderer behavior,
and make local/offline builds weaker.

Instead:

- render Markdown locally in the site generator
- preserve valid raw HTML blocks such as `<details>` / `<summary>`
- style the output so those blocks work as expandable sections in the generated
  site

This keeps the site generator productizable while still letting unpublished
fallback links reuse GitHub's repository-file renderer when users click out to
source notes.

### Initial renderer stack

Start with a `markdown-it`-based renderer.

Recommended first-pass stack:

- `markdown-it`
- `markdown-it-anchor`
- a table-of-contents plugin for `markdown-it`
- `shiki` or `highlight.js` integration for fenced code blocks

For Dendron wikilinks, do not assume an off-the-shelf wikilink plugin is the
whole answer. Kato needs site-specific behavior:

- resolve note targets against the in-scope note index
- map links through curated note `id`
- distinguish published vs unpublished targets
- fall back unpublished targets to GitHub source URLs

So the right implementation is a custom Dendron wikilink layer on top of
`markdown-it`. A package such as `markdown-it-wikilinks` may still be useful as
reference code or a parsing aid, but its default MediaWiki-style path behavior
is not the Kato site contract.

### Output shape

Use a generated static output tree suitable for GitHub Pages or other plain
static hosting.

The generated site should include:

- a homepage
- section landing pages
- one page per published note
- a shared stylesheet and copied brand assets

The output pages should carry:

- page title and section context
- note metadata where useful
- section navigation
- a table of contents for longer notes
- internal links for published notes
- explicit fallback styling for links to notes that exist in the vault but are
  intentionally unpublished

## Open Issues

- Decide whether the first slice should support explicit public URL aliases /
  redirects, or defer that until after the initial publication contract lands.

## Decisions

- Build the first slice as a custom Deno static generator instead of using the
  Dendron Next.js publish template.
- Keep this generator repository-specific for now rather than coupling it to
  Weave's broader architecture.
- Generate the published site into `docs/` so it can be served directly by
  GitHub Pages.
- Publish only the explicitly selected note families and standalone pages.
- Use `root.md` as the site homepage source note.
- Use curated Dendron `id` values as the canonical published identity for
  in-scope notes.
- Generate public URLs from curated `id` values, not from Dendron's current
  random ids and not directly from the current filename at render time.
- Rewrite in-scope note ids from the current note hierarchy plus explicit public
  section mounts:
  - `dev` => `development`
  - `user-guide` => `user-guide`
  - `compatibility` => `user-guide.compatibility`
  - `contributor` => `contributors`
- Treat curated `id` values as the hierarchy source of truth for published
  URLs.
- Continue using Dendron note names as source identifiers for wikilink
  resolution.
- Preserve Dendron wikilink navigation semantics for the supported subset of
  note-link syntax.
- Preserve valid raw HTML blocks in note bodies, including `<details>` /
  `<summary>`, so expandable sections work in generated pages.
- For unpublished note targets, emit GitHub source-file links under
  `documentation/notes/` instead of broken internal links.
- Do not depend on GitHub's Markdown rendering API for the site build; local
  rendering remains authoritative.
- Use a `markdown-it`-based renderer with heading-anchor, TOC, and code-block
  highlighting support.
- Implement Dendron wikilink resolution as Kato-owned logic on top of the
  Markdown renderer rather than delegating public URL semantics to a generic
  wikilink plugin.
- `docs.benefits` has been retaxonomized to top-level `features`.
- Reuse existing Kato Dendron-parsing ideas where practical so note naming and
  link handling do not diverge between features.

## Contract Changes

- Add a repeatable static-site build command for the note-based website.
- Add a generated site output tree containing actual HTML pages under `docs/`.
- Introduce curated Dendron `id` values for every published in-scope note.
- Introduce a note-classification contract from `documentation/notes` into public
  site sections:
  - `dev.*` => `Development`
  - `user-guide` => `User Guide` landing page
  - `compatibility` => `User Guide`
  - `release-notes.*` => `Release Notes`
  - `contributor.*` => `Contributors`
  - `features`, `roadmap`, and `product-ideas` => standalone pages
- Introduce a homepage contract:
  - `root.md` => `/`
- Introduce a Dendron-note URL contract that is derived from curated note `id`
  values instead of ad hoc hand-authored page paths:
  - `development.*` => `/development/.../`
  - `user-guide.*` => `/user-guide/.../`
  - `release-notes.*` => `/release-notes/.../`
  - `contributors.*` => `/contributors/.../`
  - standalone ids such as `features`, `roadmap`, and `product-ideas` =>
    top-level pages
- Introduce a build contract that in-scope published notes must use curated,
  URL-grade Dendron `id` values after the initial migration lands.
- Introduce an unpublished-link fallback contract:
  - unpublished targets resolve to GitHub blob URLs under
    `documentation/notes/`
- Introduce a markdown-rendering contract:
  - generated pages render Markdown locally
  - raw HTML blocks such as `<details>` / `<summary>` are preserved
  - the base renderer is `markdown-it`
  - heading anchors, TOC generation, and code highlighting are supported
  - Dendron wikilinks resolve through Kato-owned note-index logic

## Testing

- Add focused tests for:
  - note classification into sections
  - curated-`id`-driven URL generation
  - homepage mapping from `root.md`
  - section-root mappings such as `user-guide` => `/user-guide/`
  - explicit source-to-public remaps such as `compatibility` =>
    `user-guide.compatibility`
  - Dendron wikilink rendering for published notes
  - Dendron wikilink fallback for unpublished targets
  - heading-fragment resolution for `[[note#heading]]`
  - unpublished note fallback links to GitHub blob URLs
  - pass-through rendering for `<details>` / `<summary>` blocks
  - invalid legacy-random-id failure behavior for in-scope notes after
    migration
  - conservative behavior for unpublished note targets
- Run the site build and verify the generated output shape.
- Run the targeted root type/test validation that covers the new generator.

## Non-Goals

- Replacing Dendron as an authoring environment
- Publishing the entire note vault
- Full Dendron parity
- Building a general Weave renderer in this slice
- Adding client-side search or a JavaScript app shell

## Implementation Plan

- [ ] Finalize the task contract, section mounts, and curated-`id` rules.
- [x] Rename or retaxonomize public notes whose current source hierarchy should
      not become part of the public URL contract:
      `docs.benefits` => `features`.
- [ ] Rewrite in-scope note ids to their curated published values and make
      legacy random ids invalid for published notes once that migration lands.
- [ ] Implement a Deno note-site generator that reads `documentation/notes`,
      parses frontmatter, classifies publishable notes, validates curated ids,
      and builds a note index.
- [ ] Implement markdown-to-HTML rendering with supported Dendron wikilinks and
      curated-`id`-aware internal URLs.
- [ ] Add a site theme, homepage, section landing pages, and note-page layout.
- [ ] Generate the static site output into `docs/` and wire root build/serve
      tasks.
- [ ] Add focused tests for classification, URLs, and Dendron link behavior.
- [ ] Update developer notes for the new public-site pipeline.
- [ ] Run validation and mark the checklist items complete as work lands.
