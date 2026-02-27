---
id: 8ytpqqux3rmo06u7eoxce96
title: 2026 02 26 Fix Gemini Support
desc: ''
updated: 1772170471633
created: 1772170471633
---

## Context

Kato's Gemini provider ingestion currently works by recursively scanning configured roots (typically `~/.gemini/tmp`) for `session-*.json` files and then deduping by `sessionId`.

Historically, Gemini stored project temp data under hash-based directories:

- `~/.gemini/tmp/<project-hash>/chats/session-*.json`

During troubleshooting on February 26-27, 2026, we confirmed Gemini now also uses project-slug directories (for example `kato`) via a registry/migration model:

- `~/.gemini/tmp/<project-slug>/chats/session-*.json`
- `~/.gemini/projects.json` maps project root -> slug

Important nuance:

- Session JSON payloads still include `projectHash`, even when files are now under slug directories.
- During migration, both hash and slug copies can coexist for the same `sessionId`.

## What Changed (Issue Summary)

### Old behavior assumption

Kato and human operators often expected Gemini temp paths to be hash-only. This assumption is now outdated.

### New storage behavior

Gemini CLI core now supports a project registry and short project IDs (slugs). Temp and history folders can be slug-based, with migration from old hash folders.

### Why this matters for Kato

If both old (hash) and new (slug) copies exist:

- Kato may see duplicate session files for one `sessionId`.
- Naive file-level ordering (for example mtime-only) can choose an unintended source.
- Path changes for the same session can look like "new source file", potentially impacting cursor continuity if not handled carefully.

This can cause flaky command detection/capture behavior, replay noise, or confusing status for active Gemini sessions.

## Proposed Solution

### Design principle

Treat the immediate directory under `~/.gemini/tmp` as an opaque project identifier. Do not infer semantics from hash-vs-slug naming.

### Discovery and dedupe strategy

- [ ] Continue recursive discovery under configured Gemini roots; do not narrow to hash patterns.
- [ ] For each discovered `session-*.json`, parse and retain:
  - `sessionId`
  - `lastUpdated` (from JSON payload, when present)
  - `projectHash` (informational)
  - `filePath`
  - `layoutType` (`hash`, `slug`, `unknown`; derived only for tie-breaking/telemetry)
- [ ] For duplicates sharing `sessionId`, choose canonical source deterministically:
  - primary: newest parsed `lastUpdated`
  - secondary: prefer slug-path over hash-path (migration target preference)
  - tertiary: filesystem mtime
  - final tie-breaker: lexical `filePath` (stable deterministic fallback)

### Cursor and state continuity

- [ ] If the winning source path changes for the same `provider+sessionId`, attempt continuity rather than unconditional reset.
- [ ] Preserve Gemini anchor/cursor continuity using existing item-index/anchor logic; reset only when anchor validation fails.
- [ ] Add explicit operational logs for path migration events (hash -> slug, slug -> hash, unknown transitions).

### Config and operator ergonomics

- [ ] Add warnings when `providerSessionRoots.gemini` is configured to a specific child (`.../tmp/<id>`) instead of the parent `.../tmp`.
- [ ] Document that Gemini may store sessions under either hash or slug project IDs, and both can temporarily coexist.

### Test coverage

- [ ] Add fixture/test cases with duplicate hash+slug files for same `sessionId`.
- [ ] Add tests for deterministic winner selection using `lastUpdated`.
- [ ] Add tests for source-path migration without losing command detection continuity.
- [ ] Add regression test ensuring no hash-only assumptions remain in discovery.

## Risks

- Risk: Choosing wrong duplicate source during migration.
  Mitigation: deterministic ranking with `lastUpdated` first, stable tie-breakers, and explicit logging.

- Risk: Replay or missed events when source path changes.
  Mitigation: preserve cursor/anchor where possible; reset only after anchor mismatch confirmation.

- Risk: Mixed client ecosystems (older extension/build still hash-only; newer builds slug-based).
  Mitigation: keep discovery layout-agnostic and recursive under parent root.

- Risk: Operator misconfiguration to overly narrow roots.
  Mitigation: startup warnings and docs updates.

## Open Questions

- [ ] Should we always prefer slug path over hash path in ties, or only when parsed payload timestamps are equal?
- [ ] Should `projectHash` be used only as metadata, or should we surface it in status output for debugging?
- [ ] Do we need a one-time migration health command (for example, diagnostics showing hash+slug duplicates and winner decisions)?
- [ ] Should we treat `~/.gemini/history` as discovery input for active ingestion, or keep it out-of-scope for now?

## Acceptance Criteria

- [ ] Active Gemini sessions are ingested reliably whether temp layout is hash-based, slug-based, or both.
- [ ] Duplicate hash+slug session files produce exactly one canonical tracked session per `sessionId`.
- [ ] Command detection/capture behavior remains stable across layout transitions.
- [ ] Docs clearly describe supported Gemini storage layouts and recommended root configuration.
