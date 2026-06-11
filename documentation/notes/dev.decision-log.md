---
id: lemvnlo09cw54zczwbgyhvw
title: Decision Log
desc: ""
updated: 1771985134546
created: 1771779490894
---

## Decision Log Template

- Decision:
- Owner:
- Date:
- Why:
- Tradeoffs:
- Follow-up tasks:

## Decisions (Locked for MVP)

### Secrets Redaction Is Default-On at the Parse Boundary

- Decision:
  - Scan and redact secrets from canonical `ConversationEvent`s at the two
    parse boundaries (live ingestion in `provider_ingestion.ts`, full-history
    replay in `provider_source_replay.ts`) so twins, recordings, snapshots,
    snippets, and `status.json` are all covered by one choke point.
  - Detection is a built-in Deno-native ruleset (vendor patterns adapted from
    gitleaks' MIT ruleset, PEM/JWT structural rules, keyword-proximity rules
    with entropy/placeholder/digit guards) in `apps/runtime/src/policy/`.
  - `secretsPolicy` lives in `~/.kato/shared/kato-shared-config.yaml` with
    modes `off | detect | redact`; absent config means `redact` (fail
    closed); unknown keys/invalid values are rejected at load.
  - Matched spans become deterministic `[REDACTED:<rule-id>]` placeholders;
    transform failures drop the event rather than passing it through; every
    batch emits a `secrets.redacted`/`secrets.detected` security-audit event
    carrying rule ids and counts only.
- Owner: Kato engineering
- Date: 2026-06-11
- Why:
  - Recordings/exports are workspace files that get committed and shared;
    leaked credentials there are unrecoverable, while over-redaction is
    always recoverable from the provider's own transcript file.
  - A single upstream transform cannot drift out of sync the way per-sink
    enforcement (twin append + writer + snippets) would.
  - External scanners (gitleaks/trufflehog) would add subprocess permissions
    forbidden by the security baseline plus cross-platform packaging burden.
- Tradeoffs:
  - Twins store redacted content; the provider source file is the only raw
    record. Rule updates change redacted output, which can re-append a few
    events as new on anchor replay (bounded by existing dedupe).
  - Generic rules accept some false-positive risk by design; the escape
    hatches are `disabledRules`, `allowlist`, and `mode: detect`.
  - Measured overhead ~3-4 µs/KB (see the
    [[ka.completed.2026.2026-05-26-secrets-suppression]] note for the recorded
    `deno task bench` baseline).
- Follow-up tasks:
  - Periodically re-sync ported rules against upstream gitleaks releases.

### Kato Web Startup Selects an Available Local Port

- Decision:
  - Treat `kato-web-config.yaml` port as the preferred startup port, not a
    guarantee.
  - At `kato web start`, probe the configured port and then successive higher
    ports until an available port is found.
  - Use a local bind probe for the current OS namespace.
  - When running under WSL on Linux and targeting localhost-style hosts, also
    perform a best-effort Windows listener probe via `powershell.exe` so a
    Windows-owned browser-visible localhost port is skipped.
  - Do not rewrite the saved web config when a fallback port is selected.
  - While Kato Web is running or stale, status surfaces report the actual
    heartbeat/status endpoint rather than the configured preferred endpoint.
- Owner: Kato engineering
- Date: 2026-05-11
- Why:
  - Windows and WSL2 Kato Web instances can otherwise both believe they are
    using `http://127.0.0.1:5173/`, while the browser-visible URL resolves to
    the Windows process.
  - Startup-time selection preserves a stable preferred config while adapting
    to whichever local service is already running.
- Tradeoffs:
  - The Windows-side WSL probe is best-effort; if PowerShell interop is absent
    or blocked, Kato falls back to the local bind probe instead of failing.
  - Operators may see a running URL that differs from the configured preferred
    port.
- Follow-up tasks:
  - Revisit exposing a configurable scan limit only if operators need more
    than the default bounded upward scan.

### Workspace Markdown Output Relativizes Absolute Local Inline Links

- Decision:
  - Add `workspaceFeatureFlags.writerRelativizeLocalLinks` to workspace config.
  - Treat the feature as default-on for workspace-scoped markdown rendering:
    new workspace scaffolds emit it explicitly as `true`, and older workspaces
    or persisted workspace-output state that omit the key resolve as enabled.
  - Apply sanitization only when rendering markdown output for
    record/capture/export flows; do not rewrite twins, provider source history,
    or already-written markdown files on disk.
  - Only rewrite explicit inline markdown link/image destinations, and only
    when the destination path is absolute and local. Already-relative links,
    external URLs, fragment-only links, reference-style links, literal
    autolinks, and plain bare URLs stay untouched in this slice.
  - When both writer flags are enabled, local `.md` note links still collapse
    to Dendron wikilinks while other absolute local assets relativize against
    the final output file location.
- Owner: Kato engineering
- Date: 2026-04-04
- Why:
  - Workspace recordings should not leak absolute filesystem paths into
    portable markdown output.
  - This is a render-shape concern, not a source-of-truth migration concern, so
    the change belongs at writer render time instead of in twins or provider
    history.
- Tradeoffs:
  - Existing workspaces change behavior for future renders even if they do not
    add the new key explicitly.
  - The first pass intentionally keeps markdown parsing narrow instead of
    trying to sanitize every possible link-like syntax.
- Follow-up tasks:
  - Revisit reference-style links or literal autolinks only if real output
    shows they matter.
  - Revisit cross-surface parity if shared/global export defaults later need
    the same sanitization control outside workspace-scoped rendering.

### Workspace Markdown Links Can Collapse to Dendron Wikilinks

- Decision:
  - Add `workspaceFeatureFlags.writerUseDendronStyleWikilinks` to workspace
    config, default `false`.
  - When enabled, workspace-scoped markdown output rewrites only eligible
    local `.md` inline links to Dendron wikilinks using the target note
    filename without the `.md` extension.
  - Eligibility is derived at render time from the final `outputPath`:
    walk upward for `dendron.yml`, resolve `workspace.vaults[].fsPath`
    relative to that config, derive note roots as `<fsPath>/notes` for
    `selfContained: true` and `<fsPath>` otherwise, and keep the first config
    whose roots contain the output file.
  - If no matching Dendron config is found, fall back to same-directory-only
    rewriting for local `.md` targets resolved against `dirname(outputPath)`.
  - Preserve `#fragment` suffixes as `[[note#fragment]]`; leave `.md` links
    outside the derived roots as standard markdown links; and leave external
    URLs, fragment-only links, query-bearing links, and non-markdown assets
    unchanged by the wikilink rewrite.
  - When a Dendron-enabled recording appends to an existing markdown file,
    normalize the preexisting body through the same rewrite pass so legacy
    markdown note links converge to wikilinks instead of staying mixed
    indefinitely.
  - Expose the matched `dendron.yml` path and derived
    `wikilinkifiableRoots` on the Workspaces page as read-only diagnostics for
    the workspace default output location.
- Owner: Kato engineering
- Date: 2026-04-05
- Why:
  - Workspace recordings for Dendron vaults should not spill absolute
    filesystem paths into captured markdown.
  - The concern is render-shape policy, so workspace-local control is the right
    scope.
  - Broad "any local `.md`" rewriting was incorrect for repo files such as
    `README.md` that live outside the actual Dendron note tree.
- Tradeoffs:
  - Custom markdown link labels collapse to the canonical note identity in this
    first pass.
  - Cross-vault note-name collisions remain unresolved because eligibility is
    root-aware but emitted syntax is still plain `[[note]]`.
  - Shared/global CLI export defaults do not yet expose the same toggle.
- Follow-up tasks:
  - Revisit Dendron alias-style output later if preserving custom labels turns
    out to matter.
  - Revisit collision-aware or x-vault-qualified syntax if cross-vault
    basenames become a real problem.
  - Revisit whether shared export defaults should gain parity once the
    workspace-local behavior has baked in.

### Root Test Parallelism Uses a Split Serial Env Slice

- Decision:
  - Split the root test workflow into `test:parallel-safe` and `test:env`.
  - Keep `test` and `test:coverage` as composed entry points that run those
    two slices sequentially via `scripts/run-root-test-slices.ts`.
  - Retire the shared `.test-tmp/.env-lock`; remaining env-boundary tests use
    `withIsolatedEnvironment(...)` to snapshot and restore the bounded
    allowlisted env keys in the serial slice.
- Owner: Kato engineering
- Date: 2026-03-18
- Why:
  - Broad module-parallel execution was blocked less by product behavior than
    by process-env mutation and lock starvation.
  - A small explicit serial env slice keeps the default-env contracts covered
    without forcing the broader suite to give up `--parallel`.
  - Removing the filesystem lock eliminates stale-lock cleanup and lock-wait
    false timeouts from the main suite.
- Tradeoffs:
  - Whole-repo `deno test --parallel tests` remains intentionally unsupported.
  - The serial env slice still needs explicit ownership in task wiring and
    docs.
- Follow-up tasks:
  - Re-measure full `test:parallel-safe` and `test:coverage` timings on the
    split flow, especially on Windows.
  - Keep shrinking the serial env slice when additive seams are low-risk and
    do not weaken contract coverage.

### Workspace Default Output Containment

- Decision:
  - Keep workspace-generated output as the current split model:
    `defaultOutputDir` + `filenameTemplate`.
  - Template tokens remain supported in `defaultOutputDir`.
  - Generated defaults derived from `defaultOutputDir` must resolve within the
    workspace root after template expansion.
  - Explicit path arguments may still target locations outside the workspace
    root, subject to write-path policy.
- Owner: Kato engineering
- Date: 2026-03-10
- Why:
  - Keeps the existing command model and bare-filename behavior intact.
  - Preserves templated subfolder support where it already exists.
  - Makes workspace-generated defaults fail closed instead of relying on broader
    allowed-write-root policy to catch escaped default paths later.
- Tradeoffs:
  - A workspace config with an escaping `defaultOutputDir` becomes unusable for
    generated defaults until corrected.
- Follow-up tasks:
  - Keep README and workspace-path tests aligned with the containment rule.
  - Revisit only if Kato later grows a true multi-profile output model.

### Alias-Scoped Workspace Outputs

- Decision:
  - The canonical in-chat command surface is alias-scoped:
    `::init-<alias>`, `::record-<alias>`, `::capture-<alias>`,
    `::export-<alias>`, plus `::stop` and `::stop-<alias>`.
  - Persistent session state stores only workspace-scoped output state in
    `workspaceOutputs`; the old single-session `recordings`,
    `workspaceAttachment`, and `primaryRecordingDestination` model is removed.
  - Status/reporting surfaces expose multiple active recordings per session
    instead of collapsing to one "primary" destination.
- Owner: Kato engineering
- Date: 2026-03-02
- Why:
  - The workspace registry is now a first-class routing model, so command
    targets need to be explicit about which workspace they address.
  - Removing the single-session pointer model avoids ambiguous retargeting and
    keeps state aligned with the actual per-workspace recording lifecycle.
  - One session can legitimately have multiple active workspace outputs, so the
    status model must represent that directly.
- Tradeoffs:
  - Users must register a workspace alias before alias-scoped commands resolve.
  - Alias/root/config-path edits on existing registrations remain restart-bound
    for the running daemon.
- Follow-up tasks:
  - Keep removing remaining compatibility-only vestiges (legacy workspace
    config filename reads, legacy frontmatter keys).
  - Add more live-refresh coverage around register/unregister and config reload
    behavior.

### Workspace Display Labels Stay Out of Workspace Config

- Decision:
  - Keep operator-facing workspace `displayName` values in shared workspace
    registry metadata rather than in `.kato-workspace-config.yaml`.
  - Keep preferred per-workspace participant usernames in user config even when
    the web UI edits them from the Workspaces page.
  - Continue using alias as the command selector and workspace-filter identity;
    UI labels render as `<alias> (<displayName>)` only when a meaningful
    display name exists.
- Owner: Kato engineering
- Date: 2026-03-17
- Why:
  - `displayName` is presentation-only and should not affect runtime profile
    resolution, workspace-config validation, or command routing semantics.
  - Username overrides are user-scoped preferences, not shared workspace state.
  - Keeping alias as the stable selector avoids restart-sensitive alias-mutation
    work for the simpler first web-management slice.
- Tradeoffs:
  - Workspace identity is now split across registry metadata, workspace config,
    and user config depending on the concern.
  - A raw alias still appears in persisted recording snapshots and command
    surfaces even when the UI prefers the richer label.
- Follow-up tasks:
  - Keep CLI and web workspace-registration entry points aligned with the
    registry-backed `displayName` contract.
  - Revisit whether more workspace-local config should become editable from the
    web UI in phase 3.
  - Decide whether stopped-recording `Re-start` and future per-session twin
    controls should surface the richer workspace label everywhere.

### Recordings Page Tracks Output Files, Not Cycle History

- Decision:
  - Treat the `/recordings` page as a latest-state-per-output-file surface
    rather than a full recording-cycle history view.
  - `Re-start` reopens the exact saved output file on the same workspace output
    entry; it does not create a new destination or reinterpret the stopped row
    under refreshed workspace settings.
  - Only one active recording may target a given file at a time. Starting or
    `Re-start`ing a recording first stops any other engaged output already
    writing to that file.
  - Capture keeps fresh-file semantics and must not reuse or overwrite an
    existing output file.
- Owner: Kato engineering
- Date: 2026-03-18
- Why:
  - Per-file rows make Recordings-page actions honest and legible; showing
    every historical cycle would make `Re-start` ambiguous.
  - Same-path `Re-start` matches the operator expectation of “resume this file”
    rather than “make a nearby new file.”
  - Single-writer-per-file behavior avoids two sessions appending to the same
    markdown target at once.
- Tradeoffs:
  - Old recording cycles remain persisted but are no longer individually
    visible on the main Recordings page.
  - `Re-start` intentionally fails when the saved file is gone or policy no
    longer allows it, instead of trying to repair or recreate the path.
- Follow-up tasks:
  - Revisit whether deeper per-cycle history needs a separate view later.
  - Keep Sessions and Recordings copy aligned around “recording outputs” vs
    deeper historical cycles.
  - Revisit manual per-session twin suppression separately from the recording
    lifecycle controls.

### CLI Framework

- Decision: Use Deno standard-library argument parsing (`@std/cli`) with a small
  in-repo command router for `start`, `stop`, `status`, `clean`, and `export`.
  Do not add Cliffy in MVP.
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - Command surface is small and stable for MVP.
  - Keeps dependency/supply-chain risk low and aligned with
    `dev.security-baseline` non-stdlib justification rules.
  - Supports strict command grammar defaults without framework indirection.
- Tradeoffs:
  - No autogenerated command help/completions from a full CLI framework.
  - We own basic usage text, validation, and command dispatch wiring.
- Follow-up tasks:
  - Add `apps/daemon/src/cli/` with parser + command router and tests.
  - Enforce fail-closed behavior for unknown commands/flags.
  - Re-evaluate Cliffy only if command surface/UX needs outgrow in-repo routing.
- MVP defaults:
  - Unknown command or unknown flag is a hard error.
  - No permissive alias behavior unless explicitly added.
  - Strict grammar remains default (legacy permissive parsing stays opt-in
    only).

### Logging Baseline

- Decision: Use an in-repo structured logger facade for MVP (no third-party
  logging package), with JSONL output and separate operational vs security-audit
  sinks.
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - Aligns with `dev.security-baseline` requirement to separate security audit
    logs from operational logs.
  - Minimizes external dependencies while behavior is still being shaped.
  - Keeps local-first/no-network behavior simple and deterministic.
- Tradeoffs:
  - We forego advanced transport/rotation features from mature logging
    libraries.
  - We own a small amount of formatting/sink plumbing in daemon code.
- Follow-up tasks:
  - Add `apps/daemon/src/observability/logger.ts` and
    `apps/daemon/src/observability/audit_logger.ts`.
  - Define an event schema/version for log records.
  - Add redaction tests for sensitive fields and audit-completeness tests for
    allow/deny decisions.
- MVP defaults:
  - Format: JSONL.
  - Operational level: `info` (with `debug` opt-in).
  - Security audit events always write to dedicated audit log sink.
  - Operational and audit records remain separated by sink and schema.

### File Watching

- Decision: Use native `Deno.watchFs` with an in-repo debounce/settle utility.
  Do not use `chokidar`.
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - `chokidar` is a heavy dependency with deep node-gyp/fsevents roots.
  - Deno's native watcher is sufficient for the MVP scope (local text files).
- Tradeoffs:
  - We must implement our own "write settling" logic (debounce) to handle
    editors that write via temp-rename or multiple flush events.
- Follow-up tasks:
  - Add `apps/daemon/src/core/watcher.ts` with debounce logic.

### Configuration & Parsing

- Decision:
  - Config: Use inline type guards at boundary surfaces (runtime config,
    control-plane payloads, and state parsing). No `zod` in MVP.
  - Keep environment handling Deno-native; no `dotenv` package (use
    `deno --env`).
  - Streams: Use `@std/streams` (`TextLineStream`) for all file processing.
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - Leverages Web Standards (Streams) and Deno native features.
  - Inline guards provide fail-closed runtime validation with minimal dependency
    surface.
- Tradeoffs:
  - More manual validation boilerplate than schema-library-driven parsing.
- Follow-up tasks:
  - Re-evaluate `zod` post-MVP if boundary complexity grows substantially.

### Service Mode

- Decision: Defer OS service-manager integration to post-MVP (`systemd`,
  launchd, Windows Service).
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - Current development/testing environment is WSL2 and does not provide a
    reliable systemd-capable test target.
  - Service wiring does not block the core MVP capture/export architecture.
- Tradeoffs:
  - Daemon lifecycle remains CLI-managed in MVP rather than OS-native service
    managed.
- Follow-up tasks:
  - Revisit service-manager integration after core daemon interfaces are stable
    and Linux-native test coverage is available.

### OpenFeature

- Decision: Include OpenFeature in MVP from the start.
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - Establishes a stable feature-evaluation contract early, avoiding a second
    rollout later.
  - Aligns with future centralized config and cross-app policy control.
- Tradeoffs:
  - Adds up-front integration effort and a small amount of initial abstraction
    overhead.
- Follow-up tasks:
  - Define feature flag contract in `shared/src/contracts/config.ts`.
  - Add a local/offline provider default for MVP and keep network dependency
    optional.
  - Add tests for deterministic fallback behavior when remote flag providers are
    unavailable.

### Step 4 Config/OpenFeature Baseline

- Decision:
  - Add typed `featureFlags` to runtime config contract.
  - Validate runtime config with fail-closed behavior, including rejection of
    unknown feature flag keys.
  - Keep OpenFeature MVP provider local/in-memory only (no network dependency).
- Owner: Kato engineering
- Date: 2026-02-23
- Why:
  - Locks a stable feature-evaluation contract early for daemon/web/cloud
    evolution.
  - Prevents permissive startup behavior on malformed or unrecognized config.
  - Keeps local-first reliability and deterministic behavior for MVP.
- Tradeoffs:
  - Older daemon builds will refuse newer configs with unknown flags until
    versions align.
  - Minimal local provider lacks targeting/rollout features (intentionally
    deferred).
- Follow-up tasks:
  - Add explicit versioning/migration strategy for feature flags beyond MVP.
  - Revisit remote/centralized flag provider once cloud control-plane is active.

### Step 4 Daemon Startup Hardening

- Decision:
  - Introduce fail-closed subprocess startup path that loads runtime config
    before entering runtime loop.
  - Runtime subprocess exits non-zero on config load/validation failure.
- Owner: Kato engineering
- Date: 2026-02-23
- Why:
  - Prevents daemon from running with implicit defaults when config is
    missing/corrupt.
  - Aligns startup semantics with security baseline and documented fail-closed
    policy.
- Tradeoffs:
  - Startup will fail for recoverable config mistakes until user runs explicit
    correction/init flow.
- Follow-up tasks:
  - Add CLI diagnostic tooling for config validation (`kato config validate`)
    post-MVP.
  - Add schema migration helpers when config schema evolves.

### Step 4 Export Loader Contract

- Decision:
  - Add provider-aware loader hook (`loadSessionSnapshot`) to runtime export
    handling, returning `{provider, events}`.
  - Legacy `loadSessionMessages` hook removed in event-native refactor.
- Owner: Kato engineering
- Date: 2026-02-23 (revised 2026-02-24)
- Why:
  - Provider identity flows cleanly into export/audit paths.
  - Event-native payload is the canonical snapshot format (schema v2).
- Tradeoffs:
  - Breaking change from message-centric to event-centric; no migration for in-flight v1 data (none persisted).
- Follow-up tasks:
  - Ensure provider/session source-of-truth is documented for runtime and audit consumers.

### Event-Native Conversation Schema (v2)

- Decision:
  - Replace `Message[]` with `ConversationEvent[]` as canonical runtime session
    state. No backward compatibility with message-only schema required.
  - Events are typed discriminated unions (`message.user`, `message.assistant`,
    `tool.call`, `tool.result`, `thinking`, `decision`, `provider.info`, etc.).
  - `conversationSchemaVersion: 2` stamped on every `RuntimeSessionSnapshot`.
  - Event dedupe signature includes `kind` to prevent cross-kind collisions.
  - Markdown rendering is a projection from events, not from canonical storage.
  - JSONL export (one event JSON per line) added alongside markdown default.
  - `captureIncludeSystemEvents` feature flag gates `message.system` and
    `provider.info` visibility in export/render (default: false).
- Owner: Kato engineering
- Date: 2026-02-24
- Why:
  - Message-centric model could not represent tool calls, thinking, decisions,
    or provider metadata without lossy embedding in content strings.
  - First-class events enable structured export, decision tracking, and
    per-event metadata without hacks.
  - Gemini provider can be built directly on this schema without migration.
- Tradeoffs:
  - All parsers and ingestion wiring required simultaneous refactor.
  - CLI and tests required comprehensive updates.
  - `request_user_input` questionnaire synthesis is approximated (format not
    fully documented; tested with inference).
- Follow-up tasks:
  - Add `request_user_input` fixture under `tests/fixtures/` for explicit
    questionnaire→decision test coverage.
  - Add explicit cross-kind collision test.
  - Add schema fail-closed check for persisted snapshot files (once persistence
    is added).
  - Build Gemini provider runner using this event model directly.

### Gemini Text Source Precedence

- Decision:
  - For Gemini `message.user`, prefer `displayContent` and preserve missing
    command-like lines from raw `content`.
  - For Gemini `message.assistant`, prefer raw `content` and fall back to
    `displayContent` only when `content` is absent.
- Owner: Kato engineering
- Date: 2026-02-25
- Why:
  - User `displayContent` better matches what operators see in Gemini UI and
    avoids raw payload noise.
  - Assistant raw `content` is the authoritative/full text; `displayContent`
    can omit narration/action lines that are relevant for faithful capture.
  - Preserving command-like lines from raw user `content` keeps `::record` and
    `::capture` detection reliable.
- Tradeoffs:
  - Different precedence rules for user vs assistant messages add parser
    complexity.
  - Raw assistant `content` may include text that UI-softened `displayContent`
    would not show.
- Follow-up tasks:
  - Keep regression fixtures/tests for both mismatch cases:
    - user command line present only in raw `content`
    - assistant narration present only in raw `content`
  - Revisit this mapping if upstream Gemini schema semantics change.

### LogLayer Adoption (Phase 1 Parity)

- Decision:
  - Keep `StructuredLogger` / `AuditLogger` contracts and JSONL record schema
    unchanged.
  - Route logger internals through a LogLayer adapter seam.
  - If npm LogLayer is unavailable/incompatible at runtime, fall back to
    parity JSONL emission without dropping logs.
- Owner: Kato engineering
- Date: 2026-02-25
- Why:
  - Enables incremental LogLayer adoption without destabilizing existing sinks,
    tests, or downstream log consumers.
  - Keeps local/offline behavior deterministic in restricted environments.
- Tradeoffs:
  - Adapter adds dynamic import and compatibility handling complexity.
  - Full LogLayer transport/plugin feature set is not yet guaranteed in all
    runtime environments.
- Follow-up tasks:
  - Add explicit OpenTelemetry plugin wiring and transport configuration once
    environment/network constraints are settled.
  - Add compatibility tests for fallback-vs-native LogLayer execution paths.

### Claude Questionnaire Capture Projection

- Decision:
  - Treat Claude `AskUserQuestion` interactions as first-class canonical events
    by synthesizing `decision` events and a user answer summary message from
    `toolUseResult.answers`.
  - Keep raw `tool.call`/`tool.result` events as-is; decision/message synthesis
    is additive.
- Owner: Kato engineering
- Date: 2026-02-25
- Why:
  - Default markdown rendering excludes tool calls; questionnaire prompts and
    user choices were otherwise effectively invisible in recordings.
  - Decision-native projection keeps MCQ interactions queryable/exportable even
    when tool rendering is disabled.
- Tradeoffs:
  - Synthesized summaries are a projection, not a byte-for-byte provider
    transcript.
  - Mapping depends on current Claude payload shape (`toolUseResult`).
- Follow-up tasks:
  - Keep fixture-backed regression coverage for question + answer synthesis.
  - Add similar decision projection tests for Codex questionnaire flows.

### Runtime Config Bootstrap

- Decision: Add explicit runtime config bootstrap via `kato init`, with optional
  auto-bootstrap on `kato start` controlled by `KATO_AUTO_INIT_ON_START`
  (default `true`).
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - Preserves `stenobot`-style first-run ergonomics while keeping explicit
    config materialized on disk.
  - Keeps startup behavior deterministic for CLI, daemon launch paths, and
    path-policy configuration.
- Tradeoffs:
  - Adds one additional CLI command and config lifecycle surface.
  - Auto-bootstrap behavior can mask missing manual setup unless disabled.
- Follow-up tasks:
  - Expand runtime config contract in Step 4 with OpenFeature/provider settings.
  - Add boundary validation hardening for config overrides and invalid schema
    migration paths.

### Writer Identity And Command Semantics

- Decision:
  - Use generated `recordingId` per recording stream (not provider `sessionId`),
    so one session can drive multiple recordings.
  - Preserve `::record` and `::capture` as distinct behaviors:
    - `::record`: ongoing stream append target.
    - `::capture`: one-shot snapshot export that does not replace active
      recording stream.
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - `stenobot` behavior depends on `record` vs `capture` distinction.
  - Session IDs are provider identities and should not collapse multiple
    destination streams.
- Tradeoffs:
  - Adds routing/state complexity in writer orchestration (stream identity +
    session identity).
  - Requires explicit tests to avoid accidental conflation.
- Follow-up tasks:
  - Add writer routing contract for
    `(provider, sessionId) -> active recording streams`.
  - Add tests for multiple recording streams per session and
    capture-without-rotation behavior.

### Frontmatter ID Format

- Decision: Use compact frontmatter IDs for user-facing note files:
  `<slug>-<randomSuffix>` using an in-repo utility (no extra dependency).
- Owner: Kato engineering
- Date: 2026-02-22
- Why:
  - Better readability in note-centric workflows than full UUIDs.
  - Keeps dependency surface minimal while satisfying uniqueness/readability
    needs.
- Tradeoffs:
  - ID slug may drift from filename after renames; accepted for MVP.
  - Compact suffix has higher (still low) collision risk vs UUID; must size
    suffix accordingly.
- Follow-up tasks:
  - Implement local slug+suffix ID utility and collision tests.
  - Keep runtime/internal IDs on `crypto.randomUUID()` unless explicitly
    user-facing.

### Rich Session Status Model

- Decision:
  - Extend `DaemonStatusSnapshot` with `sessions?: DaemonSessionStatus[]`,
    replacing provider-aggregate-only status for `kato status` output.
  - `DaemonSessionStatus` fields: `provider`, `sessionId`, `snippet?`,
    `updatedAt`, `lastMessageAt?`, `stale`, `recording?`.
  - `DaemonRecordingStatus` fields: `outputPath`, `startedAt`, `lastWriteAt`.
  - Add `kato status --all` (show stale sessions) and `kato status --live`
    (periodic refresh-loop display, TTY-only, 2s interval, 5-session cap).
  - Text and JSON output have full parity: same fields in both modes.
  - Shared projection logic in `shared/src/status_projection.ts` reused by
    daemon, CLI, and web.
- Owner: Kato engineering
- Date: 2026-02-24
- Why:
  - Previous status output only showed aggregate counts; operators could not see
    which sessions were recording or where output was going.
  - `Kato Web` and CLI share identical filtering/sorting logic by
    using shared helpers instead of duplicating staleness thresholds.
- Tradeoffs:
  - `sessions` is additive/optional on snapshot; old status files remain valid.
  - `DaemonStatusSnapshot.providers` aggregate kept for backward compatibility.
- Follow-up tasks:
  - Remove legacy `providers` aggregate when all consumers use `sessions`.
  - Add `--interval` and `--count` flags for live mode if needed.

### File Mtime as Primary Staleness Signal

- Decision:
  - Use `fileModifiedAtMs` (OS-level file mtime from `Deno.stat()`) as the
    primary staleness signal for session status, preferred over `lastEventAt`.
  - `lastEventAt` is a fallback. If neither is available, session is stale.
  - Do not use `updatedAt` for staleness: it resets to `now()` on every daemon
    restart, making all sessions appear fresh after a restart.
  - Stale threshold: `DEFAULT_STATUS_STALE_AFTER_MS = 5 * 60_000` (5 min),
    defined in `shared/src/status_projection.ts`.
- Owner: Kato engineering
- Date: 2026-02-24
- Why:
  - `lastEventAt` is unreliable for Codex sessions because the Codex parser
    stamps all events with ingestion time, not actual message time.
  - File mtime is provider-agnostic and reflects true last-write time at the OS
    level.
- Tradeoffs:
  - `fileModifiedAtMs` is absent for sessions ingested before this change; those
    fall back to `lastEventAt`.
  - A session with no `lastEventAt` and no `fileModifiedAtMs` is treated as
    stale (fail-safe).
- Follow-up tasks:
  - Fix Codex parser to use actual message timestamps where available.

### Snippet Caching in Snapshot Metadata

- Decision:
  - Compute and cache `snippet` (first non-blank user message, newlines
    stripped, truncated to 60 chars) in `SessionSnapshotStatusMetadata` during
    `upsert()`.
  - Status projection reads `metadata.snippet` directly; events are not accessed
    in the heartbeat or polling hot paths.
- Owner: Kato engineering
- Date: 2026-02-24
- Why:
  - Events are expensive to clone (`structuredClone` on all events per session).
    Caching the snippet eliminates the only reason status projection needed events.
  - With snippet in metadata, `toProviderStatuses` and `toSessionStatuses`
    require only metadata — enabling `listMetadataOnly()` in all hot paths.
- Tradeoffs:
  - Snippet is computed once at ingest, not dynamically re-derived. If the first
    user message changes (edge case: file truncation and re-ingest), snippet
    updates on next upsert.
- Follow-up tasks:
  - None.

### listMetadataOnly() as Hot-Path Replacement for list()

- Decision:
  - Add `listMetadataOnly(): SessionSnapshotMetadataEntry[]` to
    `SessionSnapshotStore` interface (optional method for backward compatibility).
  - `listMetadataOnly()` returns `{ provider, sessionId, metadata }` tuples
    without cloning the events array — O(n sessions) shallow copy only.
  - `processInChatRecordingUpdates` uses `listMetadataOnly()` + mtime comparison
    to skip sessions whose file hasn't changed; fetches full snapshot via `get()`
    only for changed sessions.
  - Heartbeat `toProviderStatuses` and `toSessionStatuses` accept
    `SessionSnapshotMetadataEntry[]` and use `listMetadataOnly()`.
  - `list()` (deep clone) is reserved for shutdown and test harnesses.
- Owner: Kato engineering
- Date: 2026-02-24
- Why:
  - `list()` was calling `structuredClone(snapshot)` for every session every
    1–5 seconds, causing steady `heapUsed` growth (~7 MB/min observed with 53
    sessions / 15,500 events).
  - With snippet cached in metadata, no hot path needs events from `list()`.
- Tradeoffs:
  - `listMetadataOnly()` is optional on the interface; callers must fall back to
    `list()` when it is absent (test harnesses without the method).
  - Events for changed sessions are still cloned once via `get()` in the polling
    path; this is acceptable (only changed sessions, typically 0–1 per poll).
- Follow-up tasks:
  - Track remaining heap growth after these fixes; if still present, profile to
    identify next allocation source.
  - Consider adding idle-time eviction of stale session snapshots to bound total
    snapshot memory (currently deferred per memory-management task).

### Runtime Read Scope From Config

- Decision:
  - Add `providerSessionRoots` to runtime config (`claude`, `codex`).
  - Launch detached daemon with scoped `--allow-read=<roots>` instead of broad
    `--allow-read`.
  - Derive read roots from provider session roots plus
    runtime/control/config/status and allowed write roots.
- Owner: Kato engineering
- Date: 2026-02-23
- Why:
  - Aligns runtime permissions with `dev.security-baseline` read-scope
    requirements for provider parsing.
  - Removes broad read permissions from long-running daemon process.
  - Keeps ingestion root selection explicit and versioned in runtime config.
- Tradeoffs:
  - Config contract gained another required nested field (with legacy backfill
    behavior for old configs).
  - Permission/root mismatches now fail by omission rather than permissive
    fallback.
- Follow-up tasks:
  - Add CLI UX for editing/listing provider session roots.
  - Add a dedicated permission-boundary integration test for read-denied
    provider roots.

### Kato Web as a Local Fresh Operator Console

- Decision:
  - Build `apps/web` as a local Fresh-based operator console, not as a
    read-only placeholder or a generic JSON API shell.
  - Keep web lifecycle separate from daemon lifecycle: `kato start` remains
    daemon-only, while `kato web ...` owns explicit web bootstrap/status/start
    behavior.
  - Let `apps/web` own a small set of guided local operator workflows
    (workspaces, settings, maintenance), while keeping reusable business rules
    in shared runtime/shared modules instead of route handlers.
  - Require configured auth for all web access after setup, with same-origin
    and CSRF protections on mutating routes.
- Owner: Kato engineering
- Date: 2026-03-10
- Why:
  - The product need is a browser operator surface that mirrors
    `kato status --live` and exposes the same local operational data without
    requiring CLI fluency.
  - Fresh fits the current Deno-first architecture better than introducing a
    separate server/router plus a second UI stack for SSR pages, static assets,
    and small islands.
  - Guided write workflows are useful, but the validation and mutation rules
    must stay shared with CLI so web does not become a parallel policy surface.
- Tradeoffs:
  - Fresh 2 brings Vite/npm tooling into `apps/web`, so the web app now has a
    `node_modules` footprint even though Kato remains Deno-first overall.
  - Separate web config/status/log files add another local lifecycle surface to
    document and support.
  - Local browser auth/session handling adds complexity compared with a
    localhost-only unauthenticated dashboard, but protects conversation and
    operational data appropriately.
- Follow-up tasks:
  - Continue moving reusable status view-model logic into `shared/src` where it
    materially reduces CLI/web duplication.
  - Add the remaining shell/docs polish work, including logo/wordmark wiring
    and a codebase-overview refresh when the next major web slice lands.

### Distinguish Live Ingestion from Twin Persistence

- Decision:
  - Keep provider ingestion into the in-memory snapshot store independent from
    persisted twin creation.
  - Rename runtime config persistence controls from
    `globalAutoGenerateSnapshots` / `providerAutoGenerateSnapshots` to
    `globalAutoGenerateTwins` / `providerAutoGenerateTwins`, and fail fast if
    the old keys are present.
  - Persist durable session metadata across restarts even when twin persistence
    is disabled.
  - Persist twins only when the provider auto-twin policy allows it or the user
    explicitly requests `create twin` / `update twin`.
  - Remove durable `snippet` storage from session metadata; derive snippets from
    live snapshots or twin/source replay when needed.
  - Replace the top-level web `/ingestion` surface with `/twins`, and treat
    `/sessions` as the primary live session inventory.
- Owner: Kato engineering
- Date: 2026-03-11
- Why:
  - The old model conflated live parsing, durable metadata, and durable
    conversation history, which made transcript persistence happen as an
    implicit side effect of discovery.
  - Separating those concerns keeps command detection and restart continuity
    working without forcing transcript retention for every provider session.
  - The web app needed a cleaner distinction between live session state and
    persisted twin state; `/ingestion` no longer reflected the actual product
    concept.
- Tradeoffs:
  - Non-auto-twin sessions now rely on provider-source replay for some
    full-history `capture` / `export` flows after restart, which can reduce
    historical timestamp fidelity for Codex compared with live/auto-twin paths.
  - Web loaders and routes now carry two distinct inventories (`/sessions` and
    `/twins`) instead of overloading one page for both concerns.
- Follow-up tasks:
  - Document the Codex replay timestamp caveat anywhere operator-facing replay
    behavior is described.
  - Clarify shutdown cleanup docs so privacy does not rely on twin-file
    deletion semantics.

### Move Twin Management Into Maintenance

- Decision:
  - Remove the top-level web `/twins` route/tab and move persisted twin
    inspection plus cleanup into `Maintenance`.
  - Derive maintenance twin state from actual twin availability plus source
    freshness, instead of reusing Sessions-page twin visibility heuristics.
  - Keep Sessions focused on live activity/recordings and use explicit
    `show snippet` affordances for missing snippets.
  - Resolve snippets on demand from live snapshot, twin replay, or explicit
    source replay, then cache revealed snippets in the browser so they can
    appear across web surfaces for that operator after first reveal.
  - Delete twins inline from Maintenance and immediately rewrite metadata to
    canonical no-twin state while preserving non-twin session continuity.
- Owner: Kato engineering
- Date: 2026-03-11
- Why:
  - The separate `/twins` page made a troubleshooting/cleanup concern look like
    a primary navigation concept.
  - Reusing Sessions-page twin heuristics produced contradictory UI states such
    as `current` plus `create twin`.
  - On-demand snippet reveal preserves default privacy for old sessions without
    requiring startup-time snippet backfill.
- Tradeoffs:
  - Revealed snippets are cached per browser/operator rather than persisted in
    durable session metadata, so cross-browser visibility still requires a new
    reveal.
  - Maintenance now owns a denser mixed surface (cleanup plus twin
    troubleshooting), which increases that page's complexity slightly.
- Follow-up tasks:
  - Add browser-level UI coverage for the revealed-snippet cache behavior if
    we later expand frontend test infrastructure.
  - Revisit whether any Maintenance filter state should be preserved across the
    other cleanup forms.

### Shared Session/Output Metadata Layer And Per-Output Writer Controls

- Decision:
  - Add a shared user-editable metadata layer to persisted session state: `SessionMetadataV1.outputMetadataDefaults` (session-level inherited defaults) and `workspaceOutputs[].outputMetadata` (per-output values), both shaped as `SessionOutputMetadataV1` (`displayTitle`, `tags`, `personaName`, `participantUsername`).
  - Treat user-facing "recordings" as durable workspace outputs; do not introduce a separate persisted Recording entity, and keep `recordingCycles[]` as lifecycle history only.
  - Resolve effective output metadata at read/write time: output scalar values win over session defaults; tag arrays merge additively with stable dedupe (`resolveEffectiveOutputMetadata` in `shared/src/output_metadata.ts`).
  - Add `workspaceOutputs[].writerFeatureFlagOverrides` (`writerIncludeCommentary`, `writerIncludeThinking`) as per-output render policy; missing keys inherit workspace defaults, and `workspaceOutputs[].writerFeatureFlags` remains a refreshable snapshot of workspace defaults that profile application may overwrite.
  - Resolve effective writer flags as current registered workspace profile flags (falling back to the persisted snapshot) plus per-output overrides (`resolveEffectiveWriterFeatureFlags`); the daemon persisted append loop and persistent `::record`/`::capture` continuation writes honor the overrides.
  - Persisted session metadata is the source of truth; markdown frontmatter stays descriptive. Metadata-only frontmatter updates (`title`, accretive `tags`, `kato-writerFeatureFlags` effective-policy snapshot) are synchronous best-effort and never rewrite body content or rename files.
  - Web mutations run under the existing session mutation locks (`runSessionOutputMetadataUpdateAction`, `runSessionWriterOverridesAction` in `apps/web/src/session_metadata_actions.ts`); Sessions/Recordings loaders project inherited vs direct metadata plus default/override/effective writer policy, and the Recordings page exposes compact tri-state (default/include/exclude) controls per output row.
- Owner: Kato engineering
- Date: 2026-06-11
- Why:
  - Persona, tagging, and writer-control tasks all need user-editable state near persisted output state; without a shared layer each task would add its own mutation path and resolver semantics.
  - Storing per-output render choices in the workspace-default snapshot would lose them on profile refresh, and storing them only in frontmatter would fail for JSONL outputs, disabled frontmatter, or unavailable files.
- Tradeoffs:
  - The non-persistent in-memory command state path intentionally keeps workspace-default rendering until it is retired or migrated, so persistent and non-persistent flows can briefly diverge for overridden outputs.
  - The `kato-writerFeatureFlags` frontmatter snapshot is only written for outputs that actually carry overrides, keeping default outputs byte-stable but meaning unoverridden files do not advertise their render policy.
  - Sessions rows carry writer-policy/metadata projections but the first tri-state UI lives only on the Recordings page rows.
- Follow-up tasks:
  - Build tag library/output tagging UI on this layer ([[task.2026.2026-06-11-output-tagging]]).
  - Build persona selection/detection on `personaName`/`participantUsername` ([[task.2026.2026-05-28-persona-support]]).
  - Decide whether Sessions rows should also expose the tri-state controls once the Recordings-page UI has soaked.
