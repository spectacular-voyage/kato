---
id: iah2pbxa5ht6y40hj8d033s
title: 2026-02-22-factor-out-startOrRotateRecording
desc: ''
updated: 1772208566917
created: 1772208566917
---

# Rename `startOrRotateRecording` to `activateRecording` (No Aliases)

## Goal
Perform a one-shot, breaking rename of the recording activation API to remove misleading "rotate" language:

- `StartOrRotateRecordingInput` -> `ActivateRecordingInput`
- `startOrRotateRecording(...)` -> `activateRecording(...)`
- `recording.rotate` log event -> `recording.activate`

No compatibility aliases or wrapper methods.

## Scope

In scope:

- Writer pipeline API rename (interface, implementation, exported types).
- All runtime callsites and tests.
- Log key/message rename where tied to activation semantics.

Out of scope:

- Any behavioral changes to recording state transitions.
- In-chat command redesign semantics (tracked separately).

## Implementation Checklist

### 1) Pipeline API and Types

- [ ] Rename type in [recording_pipeline.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/writer/recording_pipeline.ts):
  - `StartOrRotateRecordingInput` -> `ActivateRecordingInput`.
- [ ] Rename interface method in `RecordingPipelineLike`:
  - `startOrRotateRecording(input)` -> `activateRecording(input)`.
- [ ] Rename concrete class method in `RecordingPipeline`:
  - `async startOrRotateRecording(...)` -> `async activateRecording(...)`.
- [ ] Update any internal comments/messages referencing "rotate" to "activate" where accurate.

### 2) Exports and Public Surface

- [ ] Update writer exports in [writer/mod.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/writer/mod.ts):
  - export `ActivateRecordingInput` instead of `StartOrRotateRecordingInput`.
- [ ] Update top-level daemon exports in [apps/daemon/src/mod.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/mod.ts):
  - export `ActivateRecordingInput`.
- [ ] Ensure there are no remaining symbol exports under old names.

### 3) Runtime Call Sites

- [ ] Update command handling callsites in [daemon_runtime.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/daemon_runtime.ts):
  - replace `recordingPipeline.startOrRotateRecording(...)` with `recordingPipeline.activateRecording(...)`.
- [ ] Run repo-wide search to ensure zero production callsites remain with old method/type names.

### 4) Logging Event Rename

- [ ] Rename structured event key in [recording_pipeline.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/writer/recording_pipeline.ts):
  - `"recording.rotate"` -> `"recording.activate"`.
- [ ] Update associated human-readable message:
  - "Recording stream started or rotated" -> "Recording stream activated".
- [ ] Update tests that assert the old event key/message.

### 5) Test Refactor

- [ ] Update all usages in [recording-pipeline_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/recording-pipeline_test.ts):
  - calls to `startOrRotateRecording(...)` -> `activateRecording(...)`.
- [ ] Update all daemon runtime mocks and call assertions in [daemon-runtime_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/daemon-runtime_test.ts):
  - mock method names and invocation capture fields.
  - rename helper variable names where appropriate (`rotatedTargets` -> `activatedTargets`) for readability.
- [ ] Run focused tests:
  - `tests/recording-pipeline_test.ts`
  - `tests/daemon-runtime_test.ts`

### 6) Final Safety Sweep

- [ ] Confirm no remaining references:
  - `StartOrRotateRecordingInput`
  - `startOrRotateRecording(`
  - `recording.rotate`
- [ ] Confirm no alias/wrapper was introduced.
- [ ] Confirm TypeScript build/test passes with only new names.

## Suggested Execution Order

1. Rename in pipeline implementation + interface first.
2. Fix exports.
3. Fix runtime callsites.
4. Fix tests and mocks.
5. Rename log key/assertions.
6. Run tests and final grep sweep.

## Risks

- Broad compile breakage during intermediate steps (expected until callsites are updated).
- Missed test mocks using old method names in large runtime test file.
- Event-key rename may break any tooling/tests expecting `recording.rotate`.

## Acceptance Criteria

- Build/tests compile with no old symbol references.
- `RecordingPipelineLike` exposes only `activateRecording(...)`.
- Runtime uses only `activateRecording(...)`.
- Log stream uses `recording.activate` (not `recording.rotate`).
- No aliases/wrappers for old names remain in code.
