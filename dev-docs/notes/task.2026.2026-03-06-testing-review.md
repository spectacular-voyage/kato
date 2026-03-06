---
id: a7kdxc803xvjsgm8lx4u04l
title: 2026 03 06 Testing Review
desc: ''
updated: 1772810009191
created: 1772809486844
---

## Goal

Review Kato's current test suite so we can decide where more coverage is
warranted, which tests add little value, how to reduce suite/CI runtime, and
whether `[[dev.testing]]` should change.

## Summary

- Baseline the current coverage and runtime instead of reacting only to the
  Codecov badge.
- Separate real coverage gaps from low-value coverage noise.
- Identify redundant or weak-signal tests and helper modules that are being
  pulled into the test run unnecessarily.
- Evaluate Deno module parallelism and other test/CI performance wins.
- Update testing documentation if the agreed workflow changes.

## Discussion

Current signals already visible in the repo today:

- Local coverage baseline from `deno task test:coverage --frozen` is `73.0%`
  line coverage and `80.5%` branch coverage across `398` passing tests.
- Codecov's ~`70%` project score therefore appears directionally real, not
  just a badge/reporting glitch.
- Current local runtimes:
  - `deno task test --frozen`: about `14s` elapsed
  - `deno task test:coverage --frozen`: about `23s` elapsed
  - direct `deno test --parallel ... --frozen`: about `8s` elapsed
  - direct `deno test --parallel --clean --coverage=.coverage-par ... --frozen`:
    about `10s` elapsed
- CI currently runs the full suite twice:
  - `deno task ci` already includes `deno task test --frozen`
  - then `.github/workflows/ci.yml` runs `deno task test:coverage --frozen`
- The current test task uses `tests/**/*.ts`, which also loads helper modules
  with zero tests (`tests/test_env.ts`, `tests/test_temp.ts`) instead of only
  test files.

Coverage triage should distinguish at least three buckets:

- Real logic worth more tests:
  - `apps/daemon/src/writer/jsonl_writer.ts` (`32.4%` lines)
  - `apps/runtime/src/orchestrator/launcher.ts` (`44.1%`)
  - `apps/daemon/src/orchestrator/session_twin_mapper.ts` (`49.5%`)
  - `apps/daemon/src/providers/codex/parser.ts` (`54.9%`)
  - `apps/runtime/src/policy/path_policy.ts` (`59.1%`)
  - `apps/runtime/src/config/runtime_config.ts` (`60.4%`)
- Mixed/noisy coverage contributors that still need a value judgment:
  - `shared/src/contracts/session_state.ts` (`21.4%`)
  - `shared/src/contracts/session_twin.ts` (`37.4%`)
  - version/entrypoint wrappers such as `apps/web/src/version.ts`
- Areas that already have broad suites but may have overlap or expensive
  duplication:
  - `tests/daemon-runtime_test.ts`
  - `tests/daemon-cli_test.ts`
  - `tests/provider-ingestion_test.ts`
  - `tests/writer-markdown_test.ts`

Specific observations worth checking during the review:

- `JsonlConversationWriter` appears to have only indirect coverage through
  pipeline tests and no direct writer-focused test file.
- The biggest runtime suites are also the biggest source files, so performance
  work may come more from reducing duplicated setup and CI reruns than from
  deleting many tiny unit tests.
- `[[dev.testing]]` documents smoke testing and the basic local/CI loop, but it
  does not currently describe the coverage workflow, how to inspect coverage
  gaps, or any performance guidance around targeted runs / `--parallel`.

## Open Issues

- Should we raise project coverage by adding targeted tests, by excluding
  low-value files from coverage, or by both?
- Which low-coverage files represent real product risk versus mostly
  schema/entrypoint noise?
- Is `--parallel` stable enough for both local `test` and CI `test:coverage`
  tasks?
- Should CI stop running the same suite twice once coverage is part of the
  quality signal?
- Are there tests that should be deleted outright, or is the bigger
  opportunity to merge/simplify expensive integration cases?

## Contract Changes

- None expected for production behavior.
- This task may change testing commands, CI workflow, coverage policy, and
  documentation if the review supports it.

## Testing

Review work should capture before/after evidence for:

- Coverage baseline and hotspot list from `deno task test:coverage --frozen`
- Plain suite runtime from `deno task test --frozen`
- Parallel runtime from direct `deno test --parallel ... --frozen`
- CI duplication impact from `.github/workflows/ci.yml`
- Any proposed removals, with proof that the remaining suite still covers the
  intended contract
- Any docs changes validated against the actual commands in `deno.json`

## Non-Goals

- Do not chase a coverage number in the abstract without tying it to risk or
  missing behavior.
- Do not remove tests only because they are small or fast; remove them only if
  they duplicate stronger coverage or lock in unhelpful implementation details.
- Do not broaden production permissions or weaken fail-closed behavior just to
  make tests easier.
- Do not rewrite the entire test suite in one pass.

## Implementation Plan

- [ ] Capture and document the current baseline in one place:
      suite count, plain runtime, coverage runtime, Codecov/project coverage,
      and CI duplicate test execution.
- [ ] Sort low-coverage files into buckets:
      real logic gaps, acceptable low-value coverage noise, and files that may
      merit coverage exclusion or lower priority.
- [ ] Review the heaviest suites (`daemon-runtime`, `daemon-cli`,
      `provider-ingestion`, `writer-markdown`) for repeated setup, overlapping
      scenarios, and tests that assert implementation detail instead of durable
      behavior.
- [ ] Audit helper/test selection hygiene:
      confirm whether `tests/**/*.ts` should be narrowed to actual test files so
      helper modules like `tests/test_env.ts` and `tests/test_temp.ts` are not
      run as zero-test modules.
- [ ] Add a focused coverage plan for the most undercovered logic where missing
      tests appear meaningful, starting with JSONL writing, runtime launcher
      branches, session-twin mapping, Codex parsing edge cases, runtime-config
      validation, and path-policy denial cases.
- [ ] Identify any tests that can be merged or removed, and record the specific
      reason for each candidate:
      duplicate coverage, weak signal, obsolete behavior, or excessive setup
      cost.
- [ ] Evaluate enabling Deno module parallelism in both local and CI commands,
      using the current baseline as comparison and confirming the suite stays
      deterministic under `--parallel`.
- [ ] Review the CI workflow for avoidable duplicate work, especially the
      current `deno task ci` plus separate `deno task test:coverage` sequence,
      and propose a simpler gate if it preserves signal.
- [ ] Update `[[dev.testing]]` to reflect the current agreed workflow:
      coverage commands, how to inspect hotspots, when to use targeted versus
      full runs, and any `--parallel` / CI guidance adopted from this review.
