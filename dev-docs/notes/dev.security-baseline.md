---
id: ltf5lkolipmlh5oidt302wm
title: Security Baseline
desc: ''
updated: 1771724510032
created: 1771724510032
---


## Purpose

This document is the implementation contract for Kato security controls.

Unlike `research.2026-02-21-deno-security-baseline.md`, this file is normative: requirements here use `MUST` / `MUST NOT` and are release-gating unless explicitly waived.

## Scope

In scope:
- Local session discovery/parsing for supported providers.
- In-chat command handling (`::record`, `::capture`, `::export`, `::stop`).
- Controlled Markdown export writes.
- Daemon lifecycle, state, logging, and release pipeline.

Out of scope (baseline):
- Arbitrary code execution from chat content.
- Plugin/script execution loaded from chats.
- Network-dependent processing for core local capture/export.

## Core Security Invariants

1. Kato `MUST` run with deny-by-default permissions.
2. Kato `MUST NOT` require network access for baseline local operation.
3. Kato `MUST NOT` execute subprocesses from parsed session content.
4. Every write target `MUST` pass path policy checks before write.
5. Path normalization and allowlist checks `MUST` happen before any file mutation.
6. Security-relevant allow/deny decisions `MUST` be auditable.

## Process and Permission Model

### Orchestrator

- The long-running orchestrator `MUST` have only permissions needed for steady-state monitoring.
- The orchestrator `MUST NOT` have `net`, `run`, `ffi`, or `sys` unless explicitly justified.

### Provider parser workers

- Parser workers `MUST` be read-scoped to provider session roots only.
- Parser workers `MUST NOT` have write access to arbitrary export destinations.

### Destination-scoped writer workers

- A new writer worker `MUST` be created when destination changes.
- Writer worker permissions `MUST` be scoped to one destination target (or minimal parent dir if atomic append requires temp+rename).
- Writer workers `MUST NOT` have provider session read permissions.

### Union-permission constraint

- In-process workers inherit parent upper bound.
- If strong separation is needed, architecture `SHOULD` prefer process boundaries over worker-only boundaries.

## Launcher vs Daemon Permission Narrowing

Baseline recommendation:

1. A short-lived launcher process may read config/policy and start constrained runtime processes.
2. The launcher `SHOULD` exit immediately after successful startup.
3. The long-running daemon `MUST` run with a reduced permission set derived from policy.

Security value:
- Helpful, but partial.
- It reduces steady-state blast radius (the daemon runs narrower).
- It does not protect against malicious policy/config if policy is user-writable and untrusted.

Enterprise upgrade path:
- Centrally managed/signed org policy strengthens this pattern substantially.

## Path Policy

1. Paths `MUST` be canonicalized before policy decision.
2. Traversal escapes (`../`, mixed separator evasions, UNC/extended path edge cases) `MUST` be denied unless explicitly allowed.
3. Symlink escapes outside approved roots `MUST` be denied.
4. Denied writes `MUST` emit structured security audit events.
5. Allowed destinations `MUST` come from policy/config allowlists.

## Command Policy

1. Strict command grammar `MUST` be default.
2. Legacy permissive command parsing `MUST` be opt-in only.
3. No backward compatibility requirements block tightening command parsing.

## State, Config, and Logs

1. State writes `MUST` be crash-safe (atomic write pattern).
2. Config and state `MUST` be schema-validated on load.
3. Security audit logs `MUST` be separate from operational logs.
4. Logs `MUST NOT` include unnecessary sensitive content by default.

## Build and Supply Chain Controls

1. Lockfile `MUST` be committed and enforced as frozen in CI.
2. Release builds `SHOULD` use cached-only/offline modes where possible.
3. Non-stdlib dependencies `MUST` have explicit justification.
4. Release artifacts `MUST` be signed and provenance-documented.

## Security Test Gates (Release Blocking)

1. Path traversal and canonicalization tests.
2. Symlink escape tests.
3. Command confusion/prose-trigger rejection tests.
4. Parser poisoning/malformed JSONL resilience tests.
5. Permission boundary tests per process/worker role.
6. Daemon lifecycle race tests.
7. Audit completeness tests for policy decisions.

## Platform Baseline

- First corporate baseline release may be Linux-first.
- macOS and Windows support may follow after baseline controls stabilize.

## Encryption-at-Rest Baseline Decision

- Deferred for v1 baseline.
- Revisit for enterprise/cloud and remote storage scenarios.

## Policy Ownership

- Phase 1: user-managed local policy file.
- Future enterprise: centrally managed org policy with non-overridable controls.

## Exception Process

Any deviation from this baseline requires:
1. Written exception note.
2. Explicit risk statement.
3. Owner and expiry date.
4. Follow-up issue for remediation.