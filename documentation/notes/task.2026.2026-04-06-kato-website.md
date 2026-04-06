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

- `dev.*` notes under a `Development` section
- `docs.*` notes under a `User Guide` section
- `release-notes.*.md` under a `Release Notes` section
- `contributor.*` notes under a `Contributors` section
- standalone pages for `roadmap.md` and `product-ideas.md`

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

Out of scope for the first pass:

- Dendron transclusion / note refs
- block anchors
- alias/link-label preservation syntax
- full parity with Dendron publish behavior
- publishing conversations, tasks, completed notes, or cancelled notes

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

- Decide whether unpublished note references should stay as visibly unresolved
  wikilinks or fall back to source-file links.
- Decide how much of the current `root.md` note, if any, should shape the site
  homepage.

## Decisions

- Build the first slice as a custom Deno static generator instead of using the
  Dendron Next.js publish template.
- Keep this generator repository-specific for now rather than coupling it to
  Weave's broader architecture.
- Generate the published site into `docs/` so it can be served directly by
  GitHub Pages.
- Publish only the explicitly selected note families and standalone pages.
- Treat dot-delimited note names as the hierarchy source of truth.
- Preserve Dendron wikilink navigation semantics for the supported subset of
  note-link syntax.
- Reuse existing Kato Dendron-parsing ideas where practical so note naming and
  link handling do not diverge between features.

## Contract Changes

- Add a repeatable static-site build command for the note-based website.
- Add a generated site output tree containing actual HTML pages under `docs/`.
- Introduce a note-classification contract from `documentation/notes` into public
  site sections:
  - `dev.*` => `Development`
  - `docs.*` => `User Guide`
  - `release-notes.*` => `Release Notes`
  - `contributor.*` => `Contributors`
  - `roadmap` and `product-ideas` => standalone pages
- Introduce a Dendron-note URL contract that is derived from the note
  hierarchy rather than from ad hoc hand-authored page paths.

## Testing

- Add focused tests for:
  - note classification into sections
  - hierarchy-driven URL generation
  - Dendron wikilink rendering for published notes
  - heading-fragment resolution for `[[note#heading]]`
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

- [ ] Finalize the task contract and lock the initial publication scope.
- [ ] Implement a Deno note-site generator that reads `documentation/notes`,
      parses frontmatter, classifies publishable notes, and builds a note
      index.
- [ ] Implement markdown-to-HTML rendering with supported Dendron wikilinks and
      hierarchy-aware internal URLs.
- [ ] Add a site theme, homepage, section landing pages, and note-page layout.
- [ ] Generate the static site output into `docs/` and wire root build/serve
      tasks.
- [ ] Add focused tests for classification, URLs, and Dendron link behavior.
- [ ] Update developer notes for the new public-site pipeline.
- [ ] Run validation and mark the checklist items complete as work lands.
