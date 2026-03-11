---
id: a7kdxc803xvjsgm8lx4u04l
title: 2026 03 06 Testing Review
desc: ''
updated: 1772870234942
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
- Add a security-testing track grounded in `[[dev.security-baseline]]`, not only
  generic web-app checklists.
- Start security automation with OSV-Scanner and CodeQL, and keep Scorecard as a
  later supply-chain follow-up.
- Update testing documentation if the agreed workflow changes.

## Discussion

Current signals already visible in the repo today:

- Local coverage baseline from `deno task test:coverage --frozen` is `73.0%`
  line coverage and `80.5%` branch coverage across `398` passing tests.
- Codecov's ~`70%` project score therefore appears directionally real, not just
  a badge/reporting glitch.
- Current local runtimes:
  - `deno task test --frozen`: about `14s` elapsed
  - `deno task test:coverage --frozen`: about `23s` elapsed
  - direct `deno test --parallel ... --frozen`: about `8s` elapsed
  - direct
    `deno test --parallel --clean --coverage=.test-tmp/coverage/par ... --frozen`:
    about `10s` elapsed
- Post-initial implementation verification on `2026-03-06`:
  - `deno task test --frozen --quiet`: `492` passing tests, `7.06s` real
  - `deno task test:coverage --frozen --quiet`: `492` passing tests, `80.9%`
    line coverage, `85.2%` branch coverage, `8.94s` real
  - `apps/daemon/src/writer/jsonl_writer.ts` is now at `95.9%` line coverage /
    `96.9%` branch coverage after adding a direct test file
  - `apps/daemon/src/orchestrator/session_twin_mapper.ts` is now at `90.8%` line
    coverage / `83.7%` branch coverage after adding direct mapper tests
  - `apps/runtime/src/config/runtime_config.ts` is now at `71.6%` line coverage
    / `82.6%` branch coverage after adding direct config tests
  - `apps/runtime/src/policy/path_policy.ts` is now at `85.6%` line coverage /
    `90.6%` branch coverage after adding direct policy tests
  - `apps/daemon/src/providers/codex/parser.ts` is now at `87.4%` line coverage
    / `85.4%` branch coverage after adding direct parser edge-case tests,
    including the legacy top-level `request_user_input` shape
  - `apps/cli/src/commands/status.ts` is now at `73.8%` line coverage / `84.6%`
    branch coverage after adding direct command-level status tests
  - `apps/cli/src/commands/export.ts` is now at `98.3%` line coverage / `94.6%`
    branch coverage after adding direct command-level export tests
  - `apps/cli/src/commands/start.ts` is now at `93.6%` line coverage / `92.0%`
    branch coverage after adding direct command-level start tests
  - `apps/cli/src/commands/workspace_init.ts` is now at `100%` line coverage /
    `100%` branch coverage after adding direct workspace-init tests
  - `apps/cli/src/parser.ts` is now at `93.6%` line coverage / `96.1%` branch
    coverage after adding direct parser-only help/usage/arity tests
  - `apps/runtime/src/orchestrator/control_plane.ts` is now at `73.8%` line
    coverage / `82.4%` branch coverage after adding direct control-plane
    store/path/staleness tests
  - `apps/runtime/src/config/shared_behavior_config.ts` is now at `77.9%` line
    coverage / `84.5%` branch coverage after adding direct shared-config
    parser/default/store tests
  - `apps/runtime/src/utils/env.ts` is now at `82.4%` line coverage / `96.2%`
    branch coverage after adding direct env-helper tests
  - `apps/cli/src/commands/status_error_cursor.ts` is now at `77.6%` line
    coverage / `87.2%` branch coverage after adding direct cursor normalization
    and fail-closed tests
  - `apps/runtime/src/utils/hash.ts` is now at `100%` line coverage / `100%`
    branch coverage after adding direct hash tests
  - detached launcher branches now have direct tests, and current Deno coverage
    attributes that work under `apps/daemon/src/orchestrator/launcher.ts`
    (`100%`) while warning that `apps/runtime/src/orchestrator/launcher.ts` is
    missing transpiled source
  - the root `test` and `test:coverage` tasks now use `--parallel` by default
  - `test:coverage` no longer hardcodes `--frozen`, so the documented/CI form
    `deno task test:coverage --frozen` works again
- GitHub CI has been adjusted to run the test suite once:
  - `deno task ci:quality` runs `fmt` + `lint` + `check`
  - `deno task test:coverage --frozen` runs the test suite and coverage
- The root test task now intentionally uses `main_test.ts` plus
  `tests/**/*_test.ts`, so helper modules such as `tests/test_env.ts` and
  `tests/test_temp.ts` are no longer loaded as zero-test modules.
- Initial implementation from this review has now started:
  - root test tasks have been narrowed to `main_test.ts` + `tests/**/*_test.ts`
  - direct JSONL writer tests have been added so
    `apps/daemon/src/writer/jsonl_writer.ts` is not covered only indirectly
  - direct session-twin mapper tests have been added so
    `apps/daemon/src/orchestrator/session_twin_mapper.ts` is not covered only
    through runtime/golden tests
  - direct runtime-config tests have been added so
    `apps/runtime/src/config/runtime_config.ts` is not covered only through
    CLI/main config bootstrap tests
  - direct path-policy tests have been added so
    `apps/runtime/src/policy/path_policy.ts` is not covered only through
    CLI/runtime integration paths
  - direct launcher tests now cover home-resolution and PowerShell branches for
    detached daemon startup
  - direct Codex parser tests now cover additional `response_item`,
    `request_user_input`, legacy top-level `request_user_input`, and
    task-complete edge cases
  - direct status command tests now cover JSON stale filtering plus file-backed
    recent-error and cursor reconciliation behavior
  - direct export command tests now cover stale-daemon rejection, denied output
    paths, queue payload resolution, and export-history write failures
  - direct start / workspace-init command tests now cover daemon
    acknowledgement/retry behavior plus workspace-config create/idempotent
    behavior without routing through `runDaemonCli`
  - direct status-workspace tests now cover workspace validation, registry-load
    unavailable behavior, and invalid-config/mismatch/missing-config cases
    without routing through the full `runDaemonCli status` integration path
  - direct CLI parser tests now cover help topics, usage errors, arity checks,
    and format validation without a runtime harness
  - direct control-plane tests now cover default/override path resolution,
    snapshot staleness, invalid snapshot fallback, queue cloning, malformed
    queue files, and queue-length enforcement
  - direct shared-behavior config tests now cover home-shorthand defaults,
    nested flag/frontmatter parsing, existing-config ensure behavior, and
    invalid YAML / non-`.yaml` rejection
  - direct env-helper tests now cover `readOptionalEnv`, `resolveHomeDir`, and
    `expandHomePath` behavior under explicit HOME / USERPROFILE cases
  - direct hash tests now cover deterministic stable-stringify normalization
    plus known FNV-1a digests
  - direct status-error cursor tests now cover invalid document shapes, key-cap
    normalization, and recursive parent-dir creation on save
  - root test tasks now allow the env keys exercised by those direct tests
  - `tests/test_env.ts` now provides a shared env lock so env-mutating tests
    remain deterministic under `--parallel`
  - raw coverage output now lives under `.test-tmp/coverage/` instead of
    accumulating new top-level `.coverage*` directories
  - the current `daemon-runtime_test.ts` refactor slice now extracts shared
    state-dir/scenario-dir cleanup helpers, a reusable debug-logger factory, and
    a single-workspace-output prepopulation helper across the persistent in-chat
    test cluster, including capture/export, cursor-anchor, first-seen command,
    relative-path, and frontmatter end-to-end cases, without changing runtime
    behavior
  - the current `daemon-cli_test.ts` refactor slice now reuses
    `tests/test_temp.ts` cleanup across every temp-dir case in the file and a
    shared harnessed CLI runner across the init/workspace/user clusters, so
    those tests stop rebuilding temp-dir lifecycles and `makeRuntimeHarness`
    boilerplate inline
  - the current `provider-ingestion_test.ts` refactor slice now extracts a
    shared persistent-session-state helper plus a typed file-runner factory
    across the persisted-cursor, workspace-output twin, snippet-resume,
    source-change, missing-twin bootstrap, fail-closed schema, and Gemini anchor
    scenarios so those cases stop redefining the same state-store and
    `FileProviderIngestionRunner` scaffolding inline
  - the current `provider_ingestion` source/test refactor slice now extracts
    duplicate session discovery ranking and deduping into
    `apps/daemon/src/orchestrator/provider_session_discovery.ts` with direct
    coverage in `tests/provider-session-discovery_test.ts`, so the broad
    `tests/provider-ingestion_test.ts` suite no longer needs the two Gemini
    duplicate-winner end-to-end cases
  - the current `provider_ingestion` source/test refactor slice now also
    extracts cursor resume and anchor realignment policy into
    `apps/daemon/src/orchestrator/provider_ingestion_resume.ts` with direct
    coverage in `tests/provider-ingestion-resume_test.ts`, so the broad
    `tests/provider-ingestion_test.ts` suite no longer needs the source-path
    reset and Gemini anchor realign/replay cases just to cover resume policy
  - the current `provider_ingestion` source/test refactor slice now also
    extracts merge-signature and dedupe policy into
    `apps/daemon/src/orchestrator/provider_ingestion_merge.ts` with direct
    coverage in `tests/provider-ingestion-merge_test.ts`, so the broad
    `tests/provider-ingestion_test.ts` suite no longer needs the replayed
    duplicate, cross-kind collision, and missing-id dedupe cases just to cover
    merge policy
  - the current `daemon_runtime` source/test refactor slice now extracts status
    projection into `apps/daemon/src/orchestrator/runtime_status_projection.ts`
    with direct coverage in `tests/daemon-status-projection_test.ts`, so
    `tests/daemon-runtime_test.ts` no longer needs four broad provider/session/
    active-recording projection assertions in the full runtime-loop harness
  - the current `daemon_runtime` source/test refactor slice now also extracts
    export-control request handling into
    `apps/daemon/src/orchestrator/runtime_export_request.ts` with direct
    coverage in `tests/daemon-export-request_test.ts`, so
    `tests/daemon-runtime_test.ts` no longer needs the provider-aware,
    short-selector, missing-snapshot, empty-snapshot, and export-disabled export
    request cases just to cover daemon export policy
  - the current `daemon_runtime` source/test refactor slice now also extracts
    first-seen source-freshness and command-cursor eligibility logic into
    `apps/daemon/src/orchestrator/runtime_first_seen.ts` with direct coverage in
    `tests/daemon-first-seen_test.ts`, so `tests/daemon-runtime_test.ts` no
    longer needs the mixed-backlog and no-timestamp first-seen eligibility cases
    just to cover cursor policy
  - the current `daemon_runtime` source/test refactor slice now also extracts
    command cursor anchor resolution plus in-chat boundary/seed slicing into
    `apps/daemon/src/orchestrator/runtime_command_state.ts` with direct coverage
    in `tests/daemon-command-state_test.ts`, so `tests/daemon-runtime_test.ts`
    no longer needs the seed-boundary and cursor-anchor recovery cases just to
    cover snapshot slicing/resume policy
  - the current `daemon_runtime` source/test refactor slice now also extracts
    memory-sample and eviction telemetry into
    `apps/daemon/src/orchestrator/runtime_memory_telemetry.ts` with direct
    coverage in `tests/daemon-memory-telemetry_test.ts`, so
    `tests/daemon-runtime_test.ts` no longer needs the broad sample/eviction
    logging case just to cover memory telemetry policy
  - the current `daemon_runtime` source/test refactor slice now also extracts
    workspace filename/default-output-dir template rendering into
    `apps/daemon/src/orchestrator/runtime_workspace_paths.ts` with direct
    coverage in `tests/daemon-workspace-paths_test.ts`, so
    `tests/daemon-runtime_test.ts` no longer needs the DST timestamp/snippet
    filename and conversation-fallback filename cases just to cover template
    rendering policy
  - the current `daemon_runtime` source/test refactor slice now also extracts
    workspace output lookup, cycle transitions, and destination-binding state
    into `apps/daemon/src/orchestrator/runtime_workspace_output_state.ts` with
    direct coverage in `tests/daemon-workspace-output-state_test.ts`, so
    `tests/daemon-runtime_test.ts` no longer needs the initial active-cycle,
    missing-pointer stop, and stop-then-resume binding cases just to cover
    workspace-output state policy
  - the current `daemon_runtime` source/test refactor slice now also extracts
    command target normalization, destination resolution, and destination policy
    validation into
    `apps/daemon/src/orchestrator/runtime_command_destination.ts` with direct
    coverage in `tests/daemon-command-destination_test.ts`, so
    `tests/daemon-runtime_test.ts` no longer needs the relative-argument and
    default-destination runtime-loop cases just to cover destination policy
  - the current `cli status` refactor slice now relies on direct
    `tests/status-workspace_test.ts` coverage for workspace-summary validation
    and unavailable-state behavior, while `tests/daemon-cli_test.ts` keeps only
    the narrower integration assertions for loaded workspace mappings
- GitHub CI trigger behavior today: `.github/workflows/ci.yml` runs on
  `pull_request` and on `push` to `main`. That means it runs during PR
  review/update and again after merge when the merge commit lands on `main`.
- `[[dev.security-baseline]]` already defines release-blocking security test
  gates for this repo: path traversal/canonicalization, symlink escapes, command
  confusion, malformed parser input, permission boundaries, daemon lifecycle
  races, and audit completeness.
- Current `[[dev.security-baseline]]` gate mapping:
  - path traversal and canonicalization: covered directly in
    `tests/path-policy_test.ts` (allowed-root canonicalization, traversal
    denial, Windows separator traversal) and exercised again through
    export/write path decision tests in `tests/cli-command-direct_test.ts`
  - symlink escape: covered directly in `tests/path-policy_test.ts`
  - command confusion / prose-trigger rejection: covered directly in
    `tests/command-detection_test.ts` and reinforced in
    `tests/daemon-runtime_test.ts` for unsupported `::init`,
    unsupported `::init-<alias>`, and malformed `::stop` usage
  - parser poisoning / malformed input resilience: covered directly in
    `tests/codex-parser_test.ts` for malformed `request_user_input`, in
    `tests/provider-ingestion_test.ts` for parse-error continuation and
    permission-denied reads, and in `tests/daemon-control-plane_test.ts` for
    malformed/unsupported control queue files
  - permission boundary tests per process/worker role: partial only; current
    tests cover deny-by-policy and permission-denied handling/logging, but they
    do not yet assert a full per-role subprocess/worker permission matrix
  - daemon lifecycle race tests: partial only; current tests cover watcher
    abort/shutdown behavior in `tests/daemon-watcher_test.ts` and capture
    destination collision retry behavior in `tests/daemon-runtime_test.ts`, but
    not a broader startup/shutdown race matrix
  - audit completeness: covered directly in `tests/cli-command-direct_test.ts`,
    `tests/provider-ingestion_test.ts`, `tests/daemon-export-request_test.ts`,
    `tests/daemon-runtime_test.ts`, and `tests/daemon-main_test.ts` for
    security-audit logging on denied/fail-closed paths and persisted audit log
    separation
- Initial CI rollout decision: start CodeQL and OSV-Scanner in advisory-only
  mode, then tighten later if the signal quality is good enough.

Coverage triage should distinguish at least three buckets:

- Real logic worth more tests:
  - `apps/runtime/src/config/runtime_config.ts` (`71.6%`)
  - `apps/cli/src/commands/status.ts` (`73.8%`)
  - `apps/daemon/src/orchestrator/provider_ingestion.ts` (`73.7%`)
- Mixed/noisy coverage contributors that still need a value judgment:
  - `shared/src/contracts/session_state.ts` (`21.4%`)
  - `shared/src/contracts/session_twin.ts` (`37.4%`)
  - version/entrypoint wrappers such as `apps/web/src/version.ts`
- Former hotspot files already improved by direct tests in this review:
  - `apps/daemon/src/writer/jsonl_writer.ts` (`95.9%` lines)
  - `apps/daemon/src/orchestrator/session_twin_mapper.ts` (`90.8%`)
  - `apps/runtime/src/config/runtime_config.ts` (`71.0%`)
  - `apps/runtime/src/policy/path_policy.ts` (`85.6%`)
  - `apps/daemon/src/providers/codex/parser.ts` (`87.4%`)
  - `apps/cli/src/commands/status.ts` (`73.8%`)
  - `apps/cli/src/commands/export.ts` (`98.3%`)
  - `apps/cli/src/commands/start.ts` (`93.6%`)
  - `apps/cli/src/commands/workspace_init.ts` (`100%`)
  - `apps/cli/src/parser.ts` (`93.6%`)
  - `apps/runtime/src/orchestrator/control_plane.ts` (`73.8%`)
  - `apps/runtime/src/config/shared_behavior_config.ts` (`77.9%`)
  - `apps/runtime/src/utils/env.ts` (`82.4%`)
  - `apps/runtime/src/utils/hash.ts` (`100%`)
  - `apps/cli/src/commands/status_error_cursor.ts` (`77.6%`)
  - launcher coverage no longer appears as a live gap, although Deno currently
    reports it under `apps/daemon/src/orchestrator/launcher.ts`
- Areas that already have broad suites but may have overlap or expensive
  duplication:
  - `tests/daemon-runtime_test.ts`
  - `tests/daemon-cli_test.ts`
  - `tests/provider-ingestion_test.ts`
  - `tests/writer-markdown_test.ts`
- Early heavy-suite review snapshot from the current tree:
  - `tests/daemon-runtime_test.ts` is about `6.5k` lines across `53` tests and
    still repeatedly rebuilds temp dirs, workspace fixtures, session snapshot
    stores, and full `runDaemonRuntimeLoop` harnesses for many adjacent in-chat
    / export / filename-template scenarios, even after moving status projection
    plus export-control and first-seen cursor policy into smaller directly
    tested helpers
  - `tests/daemon-cli_test.ts` is about `3.2k` lines across `55` tests and
    repeatedly rebuilds `makeRuntimeHarness` plus in-memory
    config/status/control stores even for command internals that now have direct
    command-level tests
  - `tests/provider-ingestion_test.ts` is about `2.1k` lines across `22` tests
    and still repeats watch harness + snapshot store + provider-runner setup for
    discovery, resume, duplicate-resolution, and watch-update cases
  - `tests/writer-markdown_test.ts` is about `1.6k` lines across `32` tests;
    most cases are low-cost pure rendering assertions, so readability splitting
    is likely higher-value than aggressive deletion

Specific observations worth checking during the review:

- Direct writer- and parser-focused tests have worked well for improving signal
  on undercovered logic without widening the broad integration suites.
- The biggest runtime suites are also the biggest source files, so performance
  work may come more from reducing duplicated setup and CI reruns than from
  deleting many tiny unit tests.
- Refactoring the worst large files should be treated as a targeted
  testability/perf enabler, not as a prerequisite for the entire review: do the
  cheap test-infrastructure wins first, then extract seams from the biggest
  files where that can replace broad integration coverage with smaller focused
  tests.
- OWASP guidance is only a partial fit here: it is most relevant for `apps/web`
  and any future externally reachable `apps/cloud` endpoints, while the
  daemon/CLI/runtime path needs more emphasis on local file-policy, parser
  hardening, permission scoping, and auditability.
- `[[dev.testing]]` documents smoke testing and the basic local/CI loop, but it
  now covers the coverage workflow, targeted-run guidance, `--parallel`
  behavior, and the current security-test expectations.

## Decisions

- Security automation first slice: start with CodeQL and OSV-Scanner in
  advisory-only mode. Keep findings visible in GitHub without failing the
  workflow solely because a finding exists.
- Supply-chain/process follow-up: note OpenSSF Scorecard for a later phase
  rather than bundling it into the first rollout.
- Refactor strategy: treat large-file breakup as a targeted
  testability/performance enabler after cheap infrastructure wins, not as a
  prerequisite for the whole review.
- Local vs GitHub testing: keep both. Running tests locally before commit is
  good and does not replace GitHub CI; GitHub CI still runs on PRs and on pushes
  to `main`, including post-merge.
- GitHub CI duplication: keep local `deno task ci` as the full local gate, but
  run tests only once in GitHub Actions by splitting non-test quality checks
  from coverage-enabled test execution.

## Open Issues

- Should we raise project coverage by adding targeted tests, by excluding
  low-value files from coverage, or by both?
- Which low-coverage files represent real product risk versus mostly
  schema/entrypoint noise?
- Is `--parallel` stable enough for both local `test` and CI `test:coverage`
  tasks?
- Are there tests that should be deleted outright, or is the bigger opportunity
  to merge/simplify expensive integration cases?
- Which security checks should become standard local/CI gates now versus later,
  especially for the web surface versus the daemon/runtime surface?
- After an advisory-only proving period, which findings should become
  release-gating and on what timeline?

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
- Security baseline coverage against `[[dev.security-baseline]]` release gates,
  including which gates already have meaningful tests and which do not
- Any candidate security automation/tooling trial results and false-positive
  rate
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
- Do not bolt on generic OWASP/web scanners as a checkbox if they do not match
  the current local CLI/daemon threat model.
- Do not rewrite the entire test suite in one pass.

## Implementation Plan

- [x] Capture and document the current baseline in one place: suite count, plain
      runtime, coverage runtime, Codecov/project coverage, and CI duplicate test
      execution.
- [x] Sort low-coverage files into buckets: real logic gaps, acceptable
      low-value coverage noise, and files that may merit coverage exclusion or
      lower priority.
- [x] Review the heaviest suites (`daemon-runtime`, `daemon-cli`,
      `provider-ingestion`, `writer-markdown`) for repeated setup, overlapping
      scenarios, and tests that assert implementation detail instead of durable
      behavior.
- [x] Take the cheap test-infrastructure wins first, before larger refactors:
      tighten test file selection, keep `--frozen` discipline, evaluate
      `--parallel`, and reduce duplicate CI test execution.
- [x] Run a targeted refactor-for-testability pass on the biggest code/test
      pairs rather than a repo-wide file breakup: `daemon_runtime` <->
      `daemon-runtime_test`, `provider_ingestion` <-> `provider-ingestion_test`,
      and likely `cli status` <-> `improved-status` / future webstatus parity.
- [x] For `apps/daemon/src/orchestrator/daemon_runtime.ts`, extract small units
      by responsibility so fewer behaviors require end-to-end runtime-loop
      tests: in-chat command handling, recording state transitions, export
      request handling, status projection updates, and memory/cleanup reporting.
- [x] For `apps/daemon/src/orchestrator/provider_ingestion.ts`, extract seams
      around session discovery, duplicate-resolution, cursor resume/anchor
      logic, dedupe/fingerprint handling, and watch/update orchestration.
- [x] For `apps/cli/src/commands/status.ts`, extract projection/render helpers
      that can be shared with webstatus and tested without full CLI command
      setup.
- [x] After each extraction, move assertions out of the giant integration test
      files into smaller targeted tests instead of only adding new tests on top
      of the existing broad suites.
- [x] Map the current suite against `[[dev.security-baseline]]` release-blocking
      security gates: traversal, symlink escape, command confusion, malformed
      input, permission boundaries, lifecycle races, and audit completeness.
- [x] Audit helper/test selection hygiene: confirm whether `tests/**/*.ts`
      should be narrowed to actual test files so helper modules like
      `tests/test_env.ts` and `tests/test_temp.ts` are not run as zero-test
      modules.
- [x] Add an initial focused coverage pass for the most undercovered logic where
      missing tests appear meaningful: JSONL writing, session-twin mapping,
      runtime-config validation, path-policy denial cases, detached launcher
      branches, command-level status behavior, direct control-plane behavior,
      direct shared-behavior config behavior, direct env-helper and
      status-error-cursor behavior, and additional Codex parser edge cases are
      now covered directly.
- [x] Continue focused coverage work for the remaining undercovered logic: the
      original remaining hotspots from this review (Codex parser branches, env
      helpers, and status-error cursor behavior) now have direct tests and
      verified coverage improvements.
- [x] Identify any tests that can be merged or removed, and record the specific
      reason for each candidate: duplicate coverage, weak signal, obsolete
      behavior, or excessive setup cost.
- [x] Evaluate enabling Deno module parallelism in both local and CI commands,
      using the current baseline as comparison and confirming the suite stays
      deterministic under `--parallel`.
- [x] Add the first security automation slice with OSV-Scanner and CodeQL in
      advisory-only mode, then capture fit/noise/results in `[[dev.testing]]` or
      a follow-up note.
- [x] Note OpenSSF Scorecard as a later supply-chain/process follow-up rather
      than part of the first tooling rollout.
- [x] Review the CI workflow for avoidable duplicate work, especially the
      current `deno task ci` plus separate `deno task test:coverage` sequence,
      and switch GitHub CI to a split gate that runs the test suite once while
      preserving local `deno task ci`.
- [x] Update `[[dev.testing]]` to reflect the current agreed workflow: coverage
      commands, how to inspect hotspots, when to use targeted versus full runs,
      any `--parallel` / CI guidance adopted from this review, and the agreed
      security-testing workflow/tooling.
