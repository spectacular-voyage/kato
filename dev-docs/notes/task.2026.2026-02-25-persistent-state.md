---
id: bkg5cxg6xtnaxn6d0mjc7j5
title: 2026 02 25 Persistent State
desc: ''
updated: 1772078700892
created: 1772036537917
---

## Goal

Persist daemon control state and per-session twin state across daemon restarts, without replay-driven timestamp corruption.

## Why This Exists

1. Restart/reload currently reprocesses provider logs too aggressively.
2. Codex backprocessing can assign false timestamps when `now()` fallback is used.
3. We need durable state for multi-recording workflows per session.

## Resolved Decisions

### Persistent Artifacts

1. **Daemon control index**: `~/.kato/daemon-control.json`
   - Lightweight index of known sessions and pointers to per-session metadata.
   - No global config snapshot persisted here.

2. **Session metadata**: `~/.kato/sessions/{session-key}.meta.json`
   - Exists once kato knows about the session.
   - `session-key` uses `{provider}:{providerSessionId}`.
   - Stores source identity, ingest cursor, last observed mtime, and recording metadata.

3. **Session twin log (optional)**: `~/.kato/sessions/{session-key}.twin.jsonl`
   - Kato-native intermediary representation.
   - Stores normalized events and optional timestamps.
   - Deleted on shutdown if `cleanSessionStatesOnShutdown=true`.

### Session And Recording Model

- A session has many recordings.
- A recording belongs to exactly one session.
- Recording state is `on`/`off` plus per-recording cursor.

### Recording Identifiers

- Each recording gets a UUID (`recordingId`).
- Human-facing status should show a short prefix alias (for example `7d14af8e`) and full UUID.
- Commands may target destination path or recording ID (full UUID or unambiguous prefix).

### In-Chat Command Semantics

- `::start`: create a new recording for the session in the default destination.
- `::stop`: stop all active recordings for the session.
- `::stop <destination-or-recording-id>`: stop the matching recording(s) by destination or recording UUID/prefix.
- `::stop id:<recording-id-or-prefix>` and `::stop dest:<destination>` are explicit forms.
- For bare `::stop <arg>`, if both destination and recording-id-prefix resolution match: stop both matches and log an ambiguity warning.

### Cursors

Two cursors only:

1. **Ingest cursor** (per session): source-provider position.
2. **Recording cursor** (per recording): position in session twin log.

No separate snapshot cursor.

### Provider-Specific Ingest Cursor Rules

- Claude/Codex ingest cursor: byte-offset.
- Gemini ingest cursor: item-index with a lightweight anchor guard (`messageId` if present, otherwise hash of normalized message payload).
- On resume mismatch (source rewrite/reorder): attempt anchor re-sync; if not found, replay from start into the existing twin log with dedupe suppression (no destructive twin truncation/rebuild in v1).

### Write Ordering And Crash Semantics (v1)

Processing order for one session update batch:

1. Read provider source from persisted ingest cursor.
2. Translate to `SessionTwinEventV1[]`.
3. Append translated events to `.twin.jsonl`.
4. Persist session metadata with updated ingest cursor/anchor.
5. Append translated events to each active recording destination from that recording's `writeCursor`.
6. Persist session metadata with updated per-recording `writeCursor`.
7. Update daemon control index last (cache only).

Rules:

- Session metadata writes are atomic (`tmp` + `fsync` + rename), never in-place overwrite.
- Daemon control index is rebuildable cache; per-session metadata is authoritative.
- v1 favors avoiding data loss over avoiding duplicate tails: recording cursor advances only after successful output write.
- Crash between steps may replay a tail segment; replay must remain safe via twin dedupe and recording cursor checks.

### Session And Recording IDs (CLI/Status Contract v1)

- `sessionId`: kato-generated UUID for session identity in status/CLI.
- `sessionShortId`: first 8 characters of `sessionId` (human shorthand).
- `recordingId`: kato-generated UUID for recording identity in status/CLI.
- `recordingShortId`: first 8 characters of `recordingId` (human shorthand).
- `providerSessionId`: provider-native session identifier, retained separately.
- Internal session key remains `{provider}:{providerSessionId}` for storage/index paths.

Prefix resolution behavior:

- Prefix matching is type-specific (`sessionId` prefixes only against sessions, `recordingId` prefixes only against recordings).
- No match: return not-found error.
- Multiple matches: return ambiguity error with candidate short IDs and destinations; require a longer prefix or full UUID.

### Default Destination Policy (v1)

- Working-directory inference from provider metadata is deferred.
- If `::start` or `::capture` has no destination argument, use `~/.kato/recordings/`.
- Runtime generates destination filename under that directory (provider + short IDs + timestamp), ensuring no accidental overwrite.

### Twin Growth Policy (v1)

- Session twin logs are unbounded in v1 (no rotation/compaction/retention policy yet).
- Growth controls are deferred to future cleanup/maintenance work.

### Event Identity And Dedupe

- Primary identity key for translated events:
  - session key
  - source cursor (`kind` + `value`)
  - `emitIndex`
  - canonical kind
  - source provider event metadata (`providerEventType`, `providerEventId` when present)
- Fallback dedupe key when source identity is unstable/missing:
  - hash of normalized canonical payload (excluding timestamps, seq, cursors)
- Translation append path should keep a bounded recent-fingerprint set per session to suppress duplicates during replay/re-sync.

### Timestamp Policy

- Live ingestion: record kato receive time (`capturedAt`).
- Provider timestamp may be included when trustworthy.
- Backprocessing (notably Codex): omit timestamps if uncertain.
- Never synthesize with `now()` fallback.

### Twin Gating

- `autoGenerateSnapshots=true`: update twin log on watcher-detected source changes.
- `autoGenerateSnapshots=false`: update twin log only while a recording is `on`.
- Export/capture with no twin state: build on demand from source.
- For Codex on-demand backprocessing: omit uncertain timestamps.

### On-Demand Twin Persistence

- On-demand twin generation should persist to `.twin.jsonl` by default.
- Rationale: avoids repeated full re-translation and provides stable cursor base for subsequent recording/export actions.
- If `cleanSessionStatesOnShutdown=true`, persisted twin log is still removed at daemon shutdown.

### Translation Cleanup Policy ("Junk")

Strip transport/UI artifacts, not semantic conversation content:

- Remove IDE preambles/wrappers and other known scaffolding blocks.
- Strip ANSI escape sequences.
- Drop empty text payloads.
- Keep decision/tool/message semantics intact.
- Unknown provider artifacts should be preserved as `provider.raw` (not silently dropped) unless explicitly denylisted.

### Security

- `cleanSessionStatesOnShutdown`: delete twin logs on shutdown, keep metadata/control index.
- Future secure mode (deferred): in-memory-only twin state.

### Config Additions

- `globalAutoGenerateSnapshots: boolean` (default `false`)
- per-provider-root `autoGenerateSnapshots?: boolean`
- `cleanSessionStatesOnShutdown?: boolean`

## Session Twin Schema (Draft v1)

```ts
type SessionTwinKind =
  | "user.message"
  | "user.kato-command"
  | "assistant.message"
  | "assistant.thinking"
  | "assistant.decision.prompt"
  | "user.decision.response"
  | "assistant.tool.call"
  | "assistant.tool.result"
  | "system.message"
  | "provider.info"
  | "provider.raw";

type SourceCursor =
  | { kind: "byte-offset"; value: number }
  | { kind: "item-index"; value: number }
  | { kind: "opaque"; value: string };

interface SessionTwinEventV1 {
  schemaVersion: 1;
  session: { provider: string; providerSessionId: string; sessionId: string };
  seq: number;
  kind: SessionTwinKind;
  source: {
    providerEventType: string;
    providerEventId?: string;
    cursor: SourceCursor;
    emitIndex: number;
  };
  time?: {
    providerTimestamp?: string;
    capturedAt?: string;
  };
  turnId?: string;
  model?: string;
  payload: Record<string, unknown>;
}
```

`user.kato-command` payload draft:

```ts
{
  command: "start" | "stop" | "capture" | "record" | "export";
  rawArgument?: string;
  target?:
    | { kind: "all" }
    | { kind: "destination"; value: string }
    | { kind: "recording-id"; value: string; match: "exact" | "prefix" };
}
```

Session metadata recording entry draft:

```ts
{
  recordingId: string;       // UUID
  destination: string;
  desiredState: "on" | "off";
  writeCursor: number;       // current position in twin JSONL
  createdAt?: string;        // when the recording object was first created
  periods: Array<{
    startedCursor: number;   // writeCursor at explicit ::start
    stoppedCursor?: number;  // writeCursor at explicit ::stop
    startedAt?: string;      // optional wall-clock metadata
    stoppedAt?: string;      // optional wall-clock metadata
    startedBySeq?: number;   // seq of user.kato-command that started this period
    stoppedBySeq?: number;   // seq of user.kato-command that stopped this period
  }>;
}
```

`periods` tracks explicit user-intent runs only:

- Append a new period on explicit `::start`.
- Set `stoppedCursor` (and optionally `stoppedAt`) on explicit `::stop`.
- Daemon restarts do not create new periods and do not close/open periods automatically.
- The currently active period has no `stoppedCursor`.

Correlation rule: decision prompts/responses and tool calls/results must use
explicit identifiers (for example `decisionId`, `providerQuestionId`,
`toolCallId`) rather than relying only on file ordering.

### Recording ID Prefix Rules

- Minimum accepted prefix length: 8 characters.
- Prefix must resolve to exactly one active recording in session scope.
- If 0 matches: return "recording not found".
- If >1 matches: return ambiguity error with candidate short IDs and destinations.

### Compatibility/Migration Strategy

- No backwards migration required for previously exported markdown/JSONL artifacts.
- Runtime migration approach:
  1. Keep provider parsers producing current `ConversationEvent`.
  2. Add deterministic `ConversationEvent -> SessionTwinEventV1` mapping layer.
  3. Persist SessionTwin as new durable intermediary state.
  4. Shift recording/export pipeline to read from SessionTwin.
- If persisted session metadata/twin schema version is unsupported, fail closed for that session and require rebuild from source.

## Open Issues (Resolved)

- [x] Final naming: use **SessionTwin** for the intermediary event model and `.twin.jsonl` artifact.
- [x] Final `session-key` path strategy: use `{provider}:{providerSessionId}` composite key.
- [x] Provider-specific ingest cursor under rewrites: byte-offset for Claude/Codex; item-index + anchor guard for Gemini.
- [x] Dedupe fallback: normalized canonical payload hash when source identity is unstable.
- [x] Twin "junk" policy: strip transport artifacts, preserve semantics, keep unknowns as `provider.raw`.
- [x] On-demand twin persistence: persist by default.
- [x] `::stop <arg>` precedence: ambiguity on bare arg stops both destination and recording-id-prefix matches; explicit `id:` / `dest:` still recommended.
- [x] Recording ID prefix policy: min length 8, must be unambiguous.
- [x] Compatibility/migration approach: adapter-layer transition from `ConversationEvent` to SessionTwin.
- [x] Write-order atomicity/crash semantics: twin append -> metadata ingest cursor -> recording append -> metadata recording cursor; daemon index last.
- [x] Gemini re-sync policy: anchor re-sync first, then replay-from-start with dedupe into existing twin log.
- [x] CLI/status identity contract: kato UUIDs for session/recording plus short IDs; provider session ID kept as source identity.
- [x] Default destination fallback: empty `::start`/`::capture` writes under `~/.kato/recordings/`.
- [x] Twin growth policy: explicitly unbounded for v1.

## Implementation Plan (Phased Checklist)

### Phase 0: Foundations (contracts + paths + schema)

- [ ] Add shared contracts for SessionTwin and session metadata schemas (v1), with strict runtime validators.
  - `shared/src/contracts/session_twin.ts` (new)
  - `shared/src/contracts/session_state.ts` (new)
  - Export from `shared/src/mod.ts`
- [ ] Add schema version constants and helpers for state files.
  - `DAEMON_CONTROL_SCHEMA_VERSION = 1`
  - `SESSION_METADATA_SCHEMA_VERSION = 1`
  - `SESSION_TWIN_SCHEMA_VERSION = 1`
- [ ] Add canonical path helpers for persistent artifacts.
  - `apps/daemon/src/orchestrator/control_plane.ts` (or new `state_paths.ts`)
  - Include `~/.kato/sessions/{provider}:{providerSessionId}.meta.json`
  - Include `~/.kato/sessions/{provider}:{providerSessionId}.twin.jsonl`
- [ ] Add session/recording short-id helpers (8-char prefixes, ambiguity checks).

Exit criteria:
- New schema files compile and validate happy-path fixtures.
- Path helpers resolve deterministically for all providers.

### Phase 1: Persistent State Stores

- [ ] Implement daemon control index store with atomic read/write.
  - Track known sessions and metadata file pointers only (cache semantics).
- [ ] Implement per-session metadata store with atomic write (`tmp` + rename).
  - Fields: source identity, ingest cursor/anchor, recording entries, write cursors.
- [ ] Implement SessionTwin append/read helpers.
  - Append-only writer for `.twin.jsonl`
  - Incremental read from `writeCursor`
  - Bounded recent fingerprint cache for dedupe suppression
- [ ] Add bootstrap/rebuild path:
  - If daemon control index missing/corrupt, rebuild from session metadata files.

Exit criteria:
- State survives daemon restart in local integration tests.
- Corrupt daemon index does not break startup (rebuild works).

### Phase 2: Event Mapping To SessionTwin

- [ ] Add deterministic mapper: `ConversationEvent -> SessionTwinEventV1`.
  - Preserve `source.cursor` + `emitIndex`
  - Map provider/tool/decision kinds per `dev.event-kinds.md`
  - Emit `user.kato-command` derived events from user text commands
- [ ] Implement timestamp policy in mapper/runtime:
  - `capturedAt` on live ingestion path
  - `providerTimestamp` only when trustworthy
  - No `now()` fallback for uncertain timestamps
- [ ] Add golden tests per provider (Claude/Codex/Gemini fixtures).

Exit criteria:
- Stable mapping snapshots for fixture corpus.
- No synthetic timestamps in backprocessing scenarios.

### Phase 3: Ingestion Runtime Integration

- [ ] Wire metadata ingest cursor load/save into provider ingestion startup/loop.
  - `apps/daemon/src/orchestrator/provider_ingestion.ts`
  - `apps/daemon/src/orchestrator/ingestion_runtime.ts`
- [ ] Implement Gemini anchor guard re-sync:
  - Try anchor re-align first
  - Fallback replay-from-start into existing twin log with dedupe suppression
- [ ] Write ordering implementation:
  1. Read source from ingest cursor
  2. Map to SessionTwin
  3. Append to twin log
  4. Persist ingest cursor/anchor
  5. Feed active recordings from recording cursors
  6. Persist recording cursors
  7. Update daemon index last
- [ ] Add crash/restart tests for replay safety and cursor recovery.

Exit criteria:
- Restart resumes from persisted cursor for Claude/Codex/Gemini.
- Anchor mismatch fallback does not duplicate emitted outputs.

### Phase 4: Recording Pipeline Migration To SessionTwin

- [ ] Add recording append path that consumes SessionTwin events by `writeCursor`.
  - `apps/daemon/src/writer/recording_pipeline.ts`
  - Keep markdown/jsonl writer outputs unchanged initially.
- [ ] Replace direct append-from-new-events path with twin-cursor-driven append.
- [ ] Support multi-recording per session with independent `writeCursor`.
- [ ] Keep `::capture` behavior: one-shot snapshot + start/rotate behavior per current semantics.

Exit criteria:
- Multiple recordings per session progress independently without interference.
- Existing recording output format remains backward-compatible.

### Phase 5: In-Chat Commands And ID UX

- [ ] Update in-chat command target resolution for `::stop`.
  - `::stop` => stop all session recordings
  - `::stop id:<prefix>` and `::stop dest:<path>` explicit targeting
  - Bare ambiguous arg => stop both matches, log warning
- [ ] Introduce kato UUIDs + short IDs in runtime state for sessions/recordings.
- [ ] Keep provider-native `providerSessionId` alongside kato `sessionId`.
- [ ] Default destination behavior for empty `::start`/`::capture` => `~/.kato/recordings/` generated filename.

Exit criteria:
- Prefix collisions handled deterministically.
- Status and logs expose both full UUID and short ID.

### Phase 6: Status/CLI Surfacing

- [ ] Extend daemon status snapshot contract with SessionTwin-aware identifiers/cursors.
  - `shared/src/contracts/status.ts`
  - `apps/daemon/src/orchestrator/daemon_runtime.ts`
- [ ] Update CLI status output (`--json`, plain, `--live`) to include:
  - `sessionId`, `sessionShortId`, `providerSessionId`
  - `recordingId`, `recordingShortId`, destination, desiredState
  - ambiguity/not-found command diagnostics in logs/status fields
- [ ] Ensure no `clean --sessions` behavior changes in this task (explicitly deferred).

Exit criteria:
- `kato status` is sufficient to target `::stop id:<prefix>` reliably.
- JSON status consumers get stable fields.

### Phase 7: Hardening, Migration, Rollout

- [ ] Startup migration behavior:
  - No legacy artifact migration required
  - Build twin on-demand when missing
  - Fail closed on unsupported schema version and request rebuild
- [ ] Add end-to-end tests:
  - restart persistence
  - Gemini rewrite/resync
  - multi-recording cursor independence
  - ambiguous stop behavior
  - default destination behavior
- [ ] Add metrics/logging:
  - cursor resume source
  - replay + dedupe suppression counts
  - anchor mismatch events
- [ ] Rollout guard:
  - runtime config gate (temporary) for SessionTwin path until stable
  - remove gate after soak

Exit criteria:
- Full daemon restart scenario passes on fixture-backed integration tests.
- Twin path is default and stable.

### Suggested PR Sequence

- [ ] PR1: Contracts + schema validators + path helpers.
- [ ] PR2: Persistent stores (daemon index/session metadata/twin I/O).
- [ ] PR3: Event mapper + timestamp policy + provider fixture tests.
- [ ] PR4: Ingestion runtime cursor persistence + Gemini re-sync fallback.
- [ ] PR5: Recording pipeline migration to twin cursors + multi-recording support.
- [ ] PR6: Command resolution + status/CLI identifier surfacing.
- [ ] PR7: E2E hardening + rollout gate removal.

## Out Of Scope (For Now)

- Manual session bootstrap CLI (`kato session-state create`)
- Backwards compatibility with previously generated incorrect timestamps
- In-memory-only secure mode implementation (tracked as future hardening)
- `clean --sessions` semantics (including single-session targeting and daemon-running coordination)

## Discussion Summary (Cleaned)

- We converged on one daemon artifact plus two per-session artifacts.
- We agreed timestamps must be omitted when uncertain (especially Codex backprocessing).
- We agreed session updates are gated by `recording=on` or `autoGenerateSnapshots=true`.
- We agreed export/capture can build state on demand when missing.
- We introduced a kato-native SessionTwin schema as an intermediary source of truth.
- We now explicitly support recording-level control and human-friendly short UUID references for sessions and recordings
