---
id: fuj8444pgik8sbs1pyv2iwv
title: 2026 05 26 Secrets Suppression
desc: ''
updated: 1779864921869
created: 1779861394074
---

## Goal

- I want to kato to automatically (by default) block anything that looks like a password, token, api key from making it into a twin (or recording, i'm not sure which is better, maybe both)
- gitleaks, trufflehog, and detect-secrets might be useful

## Summary

Add default-on, fail-closed secrets redaction at the parse boundary where
provider transcripts become canonical `ConversationEvent`s. Because every
Kato-created artifact (in-memory snapshot, `*.twin.jsonl`, recordings/exports,
web snippets, `status.json` snippets) is derived from those events, a single
choke point covers twins **and** recordings — answering the "twin or recording,
maybe both" question with "both, upstream of both".

Detection is a built-in Deno-native module: high-signal regex rules ported
from gitleaks' MIT-licensed ruleset (vendor-prefixed tokens, PEM blocks, JWTs)
plus generic keyword-proximity rules (`password=`, `api_key:`, …) with
Shannon-entropy validation. Matches are replaced with deterministic
`[REDACTED:<rule-id>]` placeholders. No external scanners, no new daemon
permissions.

## Discussion

- **Threat model / scope.** Provider source transcripts (Claude/Codex/Gemini
  files) already contain whatever secrets the user pasted or a tool printed
  (e.g. `cat .env`); Kato does not own those files and cannot fix them. The
  goal is: no *Kato-created* artifact contains the secret. Recordings are the
  highest-risk artifact (workspace files, likely committed/shared), but twins,
  snapshots, snippets, and `status.json` are all persisted or served, so all
  must be covered.
- **Why parse-time enforcement.** Content enters Kato through exactly two
  parse boundaries:
  - live ingestion + twin bootstrap in
    `apps/daemon/src/orchestrator/provider_ingestion.ts`
  - full-history replay in
    `apps/daemon/src/orchestrator/provider_source_replay.ts`, re-exported via
    `apps/runtime/src/session_history.ts` and used by daemon capture/export
    and the web app's snippet source-replay
  Redacting `ConversationEvent`s as parsers emit them makes every downstream
  surface consistent and fail-closed. Enforcing only at durable-write sites
  (twin append, writer pipeline, snippet serving) would mean 3+ enforcement
  points that must never drift — fail-open risk.
- **Why not gitleaks/trufflehog/detect-secrets directly.** They are Go/Python
  binaries. Kato ships prebuilt cross-platform bundles; [[dev.security-baseline]]
  forbids daemon `run` permission without justification; subprocess scanning in
  the poll loop adds latency; users would need to install the tools. The
  durable value is gitleaks' curated, MIT-licensed regex ruleset — port the
  high-signal subset into TypeScript instead.
- **Rule classes.** All redact by default (fail-closed):
  1. vendor-prefixed tokens (AWS `AKIA/ASIA`, GitHub `ghp_/gho_/ghs_/github_pat_`,
     Slack `xox*`, Stripe `sk_live_`, OpenAI `sk-`, Anthropic `sk-ant-`,
     Google `AIza`, npm `npm_`, etc.) — near-zero false positives
  2. structural secrets: PEM private-key blocks, JWTs
  3. generic keyword-proximity: `password/passwd/pwd/secret/token/api[_-]key`
     followed by assignment/colon and a value, validated by entropy/length to
     limit false positives
  Escape hatches: per-rule disable list and allowlist patterns in config.
- **Redaction form.** Replace only the matched span with
  `[REDACTED:<rule-id>]`. Deterministic (same input → same output), which
  keeps twin dedupe fingerprints stable since fingerprints are computed over
  already-redacted content.
- **Content-bearing fields.** The transform must cover, per event kind:
  message `content`, `tool.call` `input` (deep string-walk of the record),
  `tool.result` `result`, `thinking` `content`, decision `summary`/`metadata`,
  `provider.info` `content`. Identity fields (ids, cursors, timestamps, model,
  tool name) are excluded.
- **Performance.** Tool results can be large and the loop polls continuously.
  A single combined keyword-alternation regex prefilters each text before any
  per-rule regex runs; rules only execute when one of their keywords actually
  occurs.
- **Measured baseline (2026-06-11, `deno task bench`, Linux x64).** After the
  combined-keyword prefilter (which cut costs ~4x vs naive per-rule scans):
  - clean content: ~3 µs/KB (1 KB ≈ 3.0 µs, 32 KB ≈ 101 µs, 256 KB ≈ 894 µs)
  - secret-laden content: ~3.8 µs/KB (32 KB ≈ 126 µs); `detect` and `redact`
    cost the same within noise
  - 200-event transcript (~150 KB mixed messages/tool results): ~650 µs
  - end-to-end Claude replay of 500 events (~500 KB): parse-only 2.3 ms vs
    parse+redact 4.4 ms (1.92x)
  The original "single-digit % of parse time" target was the wrong metric:
  JSONL parse is so fast that redaction comparable to it is still negligible
  in absolute terms. Realistic live polling ingests a few KB per cycle →
  ~10 µs of redaction per cycle; a one-time 500 KB full-history replay pays
  ~2 ms. `mode: off` short-circuits at ~9 ns/text.
- **In-chat commands.** Redaction runs at parse time, so command detection
  sees redacted content. The strict `::` command grammar cannot match secret
  patterns, so no interference is expected — covered by a test.
- **Modes.** `off | detect | redact`, default `redact`. `detect` audits
  without altering content (useful for tuning/allowlist development).

## Open Issues

- Rule-set maintenance cadence: periodically re-sync ported rules against
  upstream gitleaks releases.
- Placeholder correlation: a short non-reversible fingerprint suffix
  (`[REDACTED:github-pat:a3f2]`) would let users correlate repeated secrets,
  but weakens privacy for low-entropy passwords. Deferred; plain placeholders
  for v1.
- Rule changes between versions alter redacted output, so anchor-replay can
  see fingerprint mismatches and re-append a few events as new. Existing
  dedupe machinery bounds the impact; acceptable for v1.

## Decisions

- Built-in Deno-native detector in `apps/runtime` (daemon and web both consume
  it); no external scanner subprocess, no npm secrets library.
- Single parse-time choke point (ingestion + source replay), covering twins,
  recordings, snapshots, snippets, and `status.json` consistently.
- All rule classes redact by default — fail-closed per Kato philosophy.
  Over-redaction is recoverable from the provider source file; a leaked
  recording is not.
- Config lives in `SharedBehaviorConfig`
  (`~/.kato/shared/kato-shared-config.yaml`) as shared policy; absent section
  defaults to `redact`; unknown keys rejected (fail-closed validation,
  consistent with `featureFlags` handling).
- Every redaction/detection emits a security-audit event with rule id,
  session, and counts — never the matched text.
- Fail-closed on transform errors: if redaction throws on an event, that
  event is dropped (with an audit event), never passed through unredacted.

## Contract Changes

- `shared/src/contracts/config.ts`: `SharedBehaviorConfig` gains optional
  `secretsPolicy`:

  ```ts
  interface SecretsPolicyConfig {
    mode: "off" | "detect" | "redact"; // default "redact" when absent
    disabledRules?: string[];          // rule ids to skip
    allowlist?: string[];              // literal substrings or /regex/ treated as safe
  }
  ```

- Redacted span format in all derived artifacts: `[REDACTED:<rule-id>]`.
- New security-audit event (e.g. `secrets.redacted` / `secrets.detected`)
  carrying provider, sessionId, eventId, ruleId, matchCount — no secret
  content.
- `ConversationEvent` and `SessionTwinEventV1` schemas unchanged (content is
  transformed, not restructured).
- Normative additions to [[dev.security-baseline]]: derived artifacts MUST
  pass secrets redaction before persistence/serving when mode is `redact`;
  redaction decisions MUST be auditable.

## Testing

- Detector contract tests: per-rule true-positive fixtures and near-miss
  negatives (UUIDs, git SHAs, base64 blobs, lockfile hashes); allowlist and
  disabledRules behavior; mode semantics; determinism.
- Ingestion integration (all three providers): planted secrets in fixture
  transcripts → snapshot, twin `*.twin.jsonl`, snippet, and `status.json`
  snippet all redacted; audit events emitted.
- Replay path: capture/export full-history replay and web snippet
  source-replay produce redacted content.
- Writer: recording markdown/JSONL contains placeholders, not secrets.
- Config: validation rejects unknown keys/invalid mode; absent `secretsPolicy`
  defaults to `redact` (fail-closed default).
- Command detection unaffected by redaction (`::capture-<alias>` still parses).
- Twin dedupe stability: re-ingesting the same redacted content does not
  duplicate events.
- Performance timings (`tests/secrets-redaction_bench.ts`, run via
  `deno bench`, with a `bench` task added to `deno.json`):
  - detector micro-benchmarks: clean vs secret-laden content at small
    (~1 KB), medium (~32 KB), and large (~256 KB) payload sizes typical of
    messages vs tool results; modes `off` / `detect` / `redact` to isolate
    detector cost; prefilter hit vs miss paths.
  - end-to-end ingestion timing: parse + redact a full provider fixture
    transcript with mode `off` vs `redact`, expressing redaction overhead as
    a percentage of total parse time.
  - record measured numbers in this note (Discussion) as the baseline for
    future rule-set changes.

## Non-Goals

- Scrubbing or mutating provider-owned source transcripts.
- Retroactive cleaning of already-persisted twins/recordings.
- External scanner integration (gitleaks/trufflehog subprocess or service).
- Network verification of live credentials (trufflehog-style).
- Perfect detection — this materially reduces leakage; it cannot guarantee
  zero.

## Implementation Plan

- [x] Add `SecretsPolicyConfig` to `shared/src/contracts/config.ts` with
      defaults + fail-closed validation in the shared config store
- [x] Build detection ruleset module under `apps/runtime/src/policy/`
      (vendor rules ported from gitleaks, PEM/JWT structural rules,
      keyword-proximity + entropy rule, allowlist support, rule metadata/ids)
- [x] Implement `redactConversationEvents()` transform covering all
      content-bearing fields per event kind (incl. deep walk of `tool.call`
      input)
- [x] Detector contract tests (positive/negative fixtures per rule, modes,
      allowlist, determinism)
- [x] Wire transform into `provider_ingestion.ts` (live loop + twin bootstrap
      path) before snapshot projection / twin mapping / dedupe
- [x] Wire transform into `provider_source_replay.ts` (covers daemon
      capture/export replay and web snippet source-replay)
- [x] Plumb `secretsPolicy` from shared config into daemon runtime and web
      replay contexts
- [x] Emit security-audit events on detect/redact (rule id + counts only) and
      operational debug counters
- [x] Integration tests: fixtures with planted secrets for claude/codex/gemini
      → twin, snapshot, snippet, and recording outputs all redacted
- [x] Config validation tests (unknown keys, bad mode, default-when-absent)
- [x] Command-detection and twin-dedupe regression tests
- [x] `Deno.bench` timing suite (`tests/secrets-redaction_bench.ts` + `bench`
      task): detector micro-benchmarks and off-vs-redact ingestion overhead;
      record baseline numbers in this note
- [x] Update README (user-facing note), [[dev.codebase-overview]],
      [[dev.security-baseline]] (normative MUSTs), [[dev.decision-log]]
- [x] `deno task fmt` + `deno task ci`
