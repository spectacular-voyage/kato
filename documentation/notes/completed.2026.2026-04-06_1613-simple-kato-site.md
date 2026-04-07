---
id: 4lplclregwdwl4nsoiagaja
title: 2026 04 06 1613 Simple Kato Site
desc: ''
updated: 1775517223019
created: 1775517223019
---

## Goal

Get a simple public Kato website up quickly by shipping a single-page static
site in `docs/`, using `README.md` as the primary content source and borrowing
from the existing note vault where helpful.

## Summary

This task is intentionally narrower than the cancelled Dendron-site-generator
work. The goal here is not to build a reusable publishing system. The goal is
to ship a clean, convincing Kato homepage quickly.

For this slice:

- ship a single-page site in `docs/`
- use `README.md` as the primary factual source
- optionally pull in supporting material from:
  - `documentation/notes/features.md`
  - `documentation/notes/compatibility.md`
  - `documentation/notes/user-guide.md`
- allow light marketing copy where it helps presentation, as long as it does
  not contradict the current product
- use the existing Kato brand assets from `shared/assets/`
- pull visual/design direction from `https://spectacular.voyage/`

Longer-term reusable SSG work is now expected to happen through Weave rather
than through a Kato-specific static-site engine. Do not let that future
architecture block this task.

## Discussion

### Why this task is intentionally simple

The broader Dendron-site effort was trying to solve too many problems at once:

- note taxonomy
- stable public identities
- Dendron wikilink semantics
- reusable publishing architecture
- multi-page public information architecture

That is valid product/platform work, but it is not the fastest path to a
useful Kato website.

Right now Kato needs a public-facing page that:

- explains what the product is
- shows compatibility and install paths
- gives a quickstart
- looks branded and intentional
- can be served from GitHub Pages immediately

That is closer to "ship a good landing page" than "build a documentation
publishing system."

### Content posture

`README.md` should be the source of truth for the core product claims in this
task. The site does not need to reproduce the README verbatim, and it should
not inherit README's structural compromises if they are not ideal for a public
homepage.

Allowed transformations:

- rearranging sections for stronger homepage flow
- tightening wording for readability and marketing polish
- adding short connective copy between README-derived sections
- turning terse README lists into better-designed page sections

Allowed supplemental sources:

- `documentation/notes/features.md`
- `documentation/notes/compatibility.md`
- `documentation/notes/user-guide.md`

Allowed design reference:

- `https://spectacular.voyage/`

The page may also include carefully invented marketing copy for:

- headline/subheadline treatment
- section intros
- calls to action
- framing around why local control of AI conversation history matters

But it must not invent unsupported product capabilities, install targets, or
provider compatibility.

### Implementation shape

Because this is a fast-path task, the implementation can be much simpler than a
future general SSG:

- a small build script or scripts are fine
- the site can be authored directly into `docs/`
- a single `index.html` plus supporting CSS/assets is enough

The implementation should still be clean enough that future replacement by
Weave is straightforward. That means:

- no sprawling one-off hacks if a small helper module would clarify things
- no irreversible coupling of the repo to a half-built publishing framework
- no network-dependent build step

### Visual direction

The site should feel like a real product page, not a dumped README with CSS.
Use the existing Kato assets:

- `shared/assets/2026-03_kato-logo_256_trans.png`
- `shared/assets/2026-03_kato-wordmark_v2_black-outline.png`

Primary visual reference:

- `https://spectacular.voyage/`

Design cues worth borrowing from the reference site:

- a clean, confident product-landing feel
- strong hero framing with concise product language
- generous whitespace and simple section rhythm
- lightweight product-marketing copy rather than documentation dump styling
- visual continuity with the broader Spectacular Voyage brand

This task should reuse that direction, while still making Kato feel like its
own product page rather than a generic copy of the current parent site.

The page should likely include:

- hero section
- concise feature framing
- compatibility section
- installation section
- quickstart section
- links to GitHub releases / repo / future docs entry points as appropriate

### Relationship to future Weave work

This task should explicitly avoid turning into "prototype Weave inside Kato."

Future reusable site generation can happen in Weave or an external repo. This
task only needs to leave behind:

- a working public page in `docs/`
- a simple, comprehensible local update path
- content choices that can later be re-expressed through Weave if desired

## Open Issues

None for the first slice after scope clarification. The current pass will use a
hand-maintained static page under `docs/`, tighten README-backed facts into
homepage-specific prose, and send "Learn more" traffic to the GitHub
repository.

## Decisions

- This task builds a simple single-page Kato site, not a reusable Dendron
  publishing system.
- Ship the site from `docs/` for GitHub Pages serving.
- Use `README.md` as the primary factual content source.
- Supplement from `features.md`, `compatibility.md`, and `user-guide.md` only
  where that improves the page.
- Existing shared brand assets should be reused rather than replaced.
- `https://spectacular.voyage/` is the primary design-direction reference for
  the first pass.
- Light marketing copy is allowed, but unsupported product claims are not.
- The first slice should be authored directly as static files in `docs/`
  rather than generated through a build step.
- The implementation remains repo-specific and intentionally lightweight.
- The homepage should emphasize why Kato is valuable for AI-assisted
  development work: durable local ownership of conversations, reusable
  markdown output, and better shared memory across humans and agents.
- The first-slice "Learn more" destination should be the GitHub repository.
- Future Weave-based or external-repo SSG work is explicitly out of scope for
  this task.

## Contract Changes

- Add a hand-maintained public single-page Kato site under `docs/`.
- Introduce a public homepage contract:
  - `docs/index.html` is the main public entry point
- Introduce a content contract for the first slice:
  - primary source: `README.md`
  - optional supporting sources:
    - `documentation/notes/features.md`
    - `documentation/notes/compatibility.md`
    - `documentation/notes/user-guide.md`
- Introduce an asset contract for the first slice:
  - Kato branding assets come from `shared/assets/`
  - public copies may live under `docs/assets/`
- Introduce a design-reference contract for the first slice:
  - visual direction may be derived from `https://spectacular.voyage/`

## Testing

- Verify the site renders as a coherent single page on desktop and mobile.
- Verify the page includes accurate compatibility, install, and quickstart
  information relative to `README.md`.
- Verify links to GitHub releases/repo/docs targets resolve correctly.
- Verify the final output in `docs/` is servable by GitHub Pages as plain
  static files.
- Run the targeted validation appropriate to the implementation path. For this
  slice that primarily means browser verification rather than code-generation
  tests.

## Non-Goals

- Building the future reusable Weave publishing pipeline
- Recreating the cancelled multi-page Dendron-site task in smaller disguise
- Publishing the note vault
- Designing a long-term documentation architecture
- Full content de-duplication between `README.md` and the website
- Client-heavy app behavior or search

## Implementation Plan

- [x] Refine the content outline for the single-page site using `README.md`
      as the primary source.
- [x] Decide the minimum supporting sources and where light marketing copy is
      needed.
- [x] Implement the simple site directly in `docs/` as a hand-maintained
      static page.
- [x] Apply branding, layout, and responsive styling using the existing Kato
      assets.
- [x] Verify content accuracy against `README.md` and supporting notes.
- [x] Run appropriate validation and mark the checklist complete as work lands.
