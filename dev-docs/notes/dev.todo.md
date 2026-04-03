---
id: mhthe39ktidk76iy77kcxbn
title: Todo
desc: ""
updated: 1775014693695
created: 1771812869620
---

- brew packaging
- review entire twin or file (i.e. markdown viewer)
- heading templates
  - -ai-enabled mode lets you summarize in x words (by first speech act, and eventually retroactively replace 
  - product name, not just llm
  - nickname
- redact list. redact words, sentences, entire chats based on regex or simple mat

## Event Schema Follow-ups (v2)

- [ ] Add schema fail-closed check when persisted snapshot files are added (fail
      with `kato clean --all` remediation hint on v1 data).
- [ ] Add `JsonlConversationWriter` to active recording pipeline (currently only
      markdown recordings are appended; JSONL write mode is export-only).
      Deferred for post-`v0.2.0`: behavior expansion outside low-churn release
      scope.

## Runtime And Ingestion Follow-ups

- [ ] Extend `SessionSnapshotStore` with `delete`/`clear` and wire it into
      `clean` command behavior. Deferred for post-`v0.2.0`: medium
      implementation not release-critical.
- [ ] Add permission-boundary tests that prove provider reads are denied outside
      `providerSessionRoots`.
- [ ] Snapshot projection still keys in-memory reads by provider session id;
      harden provider-aware lookup paths where CLI/runtime can still be
      ambiguous.
- [ ] _maybe_ Fix mid-turn cursor advancement: cursor must not advance past an
      incomplete multi-entry assistant turn; polling at a turn boundary splits
      one logical event into two separate snapshot entries that dedupe cannot
      collapse. This requires the ingestion runner to detect turn boundaries per
      provider (e.g. `task_complete`/`final_answer` for Codex; consecutive
      assistant entries for Claude) and buffer partial turns between polls —
      significant redesign.
- [ ] Add explicit SessionTwin compaction/retention policy (v1 is append-only).

## CLI And Runtime Hardening

- [ ] Add `kato config validate` command for preflight runtime config checks.
      Deferred for post-`v0.2.0`: useful hardening but out-of-scope for
      low-churn release.
- [ ] Improve startup error UX for config/schema failures with actionable
      remediation hints.
- [ ] Add workspace pre-persist verification and runtime re-verification status
      (`valid|invalid|unverified`) with explicit error reasons.

## Config And Feature-Flag Evolution

- [ ] Define explicit versioning/migration strategy for runtime config
      (`featureFlags`, `providerSessionRoots`).
- [ ] Decide and document compatibility policy for newer config fields vs older
      daemon builds.
- [ ] Re-evaluate remote/centralized OpenFeature provider integration once cloud
      control-plane work begins.

## Observability And Security Follow-Through

- [ ] Define event schema/version contract for operational and audit logs.
- [ ] Add sensitive-field redaction tests for log sinks.
- [ ] Add audit-completeness tests for critical allow/deny decisions.

## Binary Distribution Follow-Ups

- [ ] Finalize least-privilege compile permissions for `kato`, `kato-daemon`,
      and `kato-web`, with launcher-only spawning power where possible.
- [ ] Expand packaged-bundle smoke checks to full daemon lifecycle and full web
      lifecycle coverage.
- [ ] Add downloadable-archive smoke checks that extract the real `.tar.gz` or
      `.zip` and rerun the core binary/web assertions.
- [ ] Add automated tests for `scripts/package-binaries.ts` covering bundle
      contents, emitted metadata, and archive/checksum output.
- [ ] Add permission regression checks proving compiled binaries still honor
      app-level path policy outside configured roots.
- [ ] Add signing/notarization steps required before direct binary installs are
      documented as the default path.

## Testing And Packaging

- [ ] Add migration tests for config evolution scenarios (older/newer config
      compatibility).

## Deferred Post-MVP Tracks

- [ ] Re-evaluate additional CLI framework features (Cliffy) only if command UX
      outgrows current router.
- [ ] Re-evaluate `zod` adoption only if boundary validation complexity
      materially increases.

## workspaceID Risks

(very remote) risk is duplicate workspaceId across two different workspace roots on one user’s machine; register logic treats that as a conflict (workspace_register.ts).

## Other

- [ ] resolveConversationTitle call dedup/memoization in daemon runtime is still
      an optimization opportunity.
- [ ] remove all compatibility-layer cruft
- [ ] Supporting relative paths for in-chat command arguments and config
      allowedWriteRoots
- [ ] add codex "plan" documents (and other documents?) to
      ConversationEventKinds and add corresponding config switches.
- [ ] Decide terminology: workspace -> destination. Acceptance: a short decision
      note is published in dev docs, README wording is updated if approved, and
      a PR is opened (or linked) for code/string renames when required. Owner:
      @djradon. Target: 2026-03-15.

- [ ] update cli based on new web summary functionality and tightened session/ingest differentiation

- [ ] interactive  prompt "kato init" (e.g. defaultUsername, etc) 
