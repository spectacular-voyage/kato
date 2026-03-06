---
id: mhthe39ktidk76iy77kcxbn
title: Todo
desc: ""
updated: 1772759921935
created: 1771812869620
---

## v0.2.0 Curation Status (2026-03-03)

This backlog is curated for source-only `v0.2.0` with low code churn.

- Completed stale items are explicitly closed.
- Medium/high-churn items are explicitly deferred with rationale.
- Follow-up hardening remains in place for post-`v0.2.0`.

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

## Testing And Packaging

- [ ] Add production packaging guidance/scripts for `deno compile` with
      least-privilege permissions. Deferred for post-`v0.2.0`: first release is
      intentionally source-only.
- [ ] Add permission-profile smoke coverage for compiled/binary-style runtime.
      Deferred for post-`v0.2.0`: binary release work is deferred.
- [ ] Add migration tests for config evolution scenarios (older/newer config
      compatibility).

## Deferred Post-MVP Tracks

- [ ] Service-manager integration evaluation (`systemd`, launchd, Windows
      Service).
- [ ] Re-evaluate additional CLI framework features (Cliffy) only if command UX
      outgrows current router.
- [ ] Re-evaluate `zod` adoption only if boundary validation complexity
      materially increases.

## workspaceID Risks

Biggest shared-repo risk is when workspaceId is missing and different users run register: each machine may generate a different UUID, causing noisy diffs until one wins and is committed (workspace_register.ts, registry.ts).
Another risk is duplicate workspaceId across two different workspace roots on one user’s machine; register logic treats that as a conflict (workspace_register.ts).
In this repo, .kato-workspace-config.yaml is not gitignored globally (only .kato/ is), so it can be committed and cause merge churn if edited often (.gitignore).
If you want to minimize team friction: keep workspaceId committed and stable, and avoid machine-specific settings in that file.

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
- [ ] Decide terminology: sessions -> chats. Acceptance: decision is documented
      with scope boundaries (UI/docs/internal IDs), impacted code surfaces are
      enumerated, and an implementation PR is opened (or explicitly deferred).
      Owner: @djradon. Target: 2026-03-15.

