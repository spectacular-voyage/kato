---
id: 20260611-session-output-metadata
title: 2026 06 11 Session And Output Metadata
desc: ''
updated: 1781191063000
created: 1781191063000
---

## Goal

- Add a reusable persisted metadata/settings layer for session-level defaults
  and per-output overrides.
- Give Kato Web a safe way to edit metadata after a session, output, or
  recording has already started.
- Provide the substrate for [[task.2026.2026-06-11-output-tagging]] and
  [[task.2026.2026-05-28-persona-support]] before those tasks add their
  domain-specific UI.
- Clarify that "per-recording" product edits map to durable workspace output
  metadata until Kato has a separate persisted Recording entity.

## Summary

- `SessionMetadataV1` already stores provider-session state and
  `workspaceOutputs[]`.
- `workspaceOutputs[]` already owns output-specific state such as destination,
  desired recording state, write cursor, workspace profile snapshots, and
  recording cycles.
- Upcoming persona, tagging, and writer-control work all need user-editable
  metadata near the persisted output state. Without a shared layer, each task
  will add its own mutation path and resolver semantics.
- Add explicit containers for:
  - session-level output defaults;
  - per-output metadata.
- A tag set on the session should translate into effective tags for
  recordings/outputs through inheritance. The effective output metadata is what
  gets written to markdown frontmatter.
- Kato currently has recording cycles as start/stop history on a workspace
  output, not a separate durable Recording object. In the first slice,
  "per-recording" means metadata attached to the workspace output that the
  recording writes to.

## Discussion

- "Session metadata" needs a narrower product meaning than the existing
  persisted session file. The session file includes ingestion cursors and
  operational state; user-editable settings should live in explicit fields so
  web mutations cannot accidentally couple to provider ingestion.
- Recommended layering:
  - session-level output defaults apply to future workspace outputs and to
    active outputs when the user chooses a session-wide edit;
  - output metadata is the authoritative source for a specific workspace
    output and the active/stopped recording represented by that output.
- A session-level tag should not be a separate frontmatter-only concept. It
  should resolve into the effective tags for each output. That keeps a
  recording, capture, or restarted output consistent even when frontmatter is
  disabled or unavailable.
- The UI can still say "recording" where that is the user-facing workflow, but
  the persisted write should target the workspace output. The current
  `recordingCycles[]` array is lifecycle history, not the product entity that
  should own tags or persona metadata.
- Metadata edits should be possible for active and stopped outputs. For active
  outputs, future appends use the new metadata. For stopped outputs, re-arm or
  restart should preserve and reuse the metadata.
- Frontmatter remains descriptive. Metadata mutation should best-effort update
  markdown frontmatter when the file exists and frontmatter is enabled, but
  persisted session metadata remains authoritative.
- Metadata mutation should use the existing session mutation lock pattern so
  web actions, ingestion, and command replay do not clobber each other.
- This task is intentionally a foundation task. It should not implement tag
  libraries, persona prefix detection, or model frontmatter changes.

## Open Issues

- What should the top-level field be called? Recommendation:
  `outputMetadataDefaults` on `SessionMetadataV1` and `outputMetadata` on each
  `SessionWorkspaceOutputStateV1`.
- Should a session-level edit immediately materialize onto every existing
  output, or remain inherited at resolution time? Recommendation: resolve
  inherited session defaults at write time, and only materialize output
  metadata when the user edits a specific output.
- Should session-level metadata apply to captures created after the edit?
  Recommendation: yes.
- Should Kato introduce a separate persisted `Recording` entity? Recommendation:
  no for this precursor task; keep the first slice aligned with the existing
  output-centric contract and revisit only if output rows cannot express the
  UX cleanly.
- Should output metadata edits update existing markdown frontmatter
  synchronously or enqueue a repair task? Recommendation: synchronous
  best-effort for markdown frontmatter fields that already have writer helpers.

## Decisions

- Introduce a shared output metadata/settings layer before persona and tagging
  implementation.
- Treat persisted session metadata as the source of truth.
- Treat markdown frontmatter as descriptive output metadata.
- Session-level tags/settings are inherited defaults for outputs, not a second
  independent frontmatter source.
- Store per-output metadata on `workspaceOutputs[]`, near destination,
  recording state, and writer snapshots.
- Do not introduce a separate persisted Recording entity for the first tagging
  or persona slices.
- Metadata edits do not rewrite historical body content.
- Metadata edits should work for active and stopped outputs.

## Contract Changes

- `SessionMetadataV1`
  - add optional session-level output defaults, for example
    `outputMetadataDefaults?: SessionOutputMetadataV1`;
  - keep operational ingestion fields unchanged.
- `SessionWorkspaceOutputStateV1`
  - add optional `outputMetadata?: SessionOutputMetadataV1`;
  - preserve the field when applying workspace profile snapshots.
- Shared metadata types
  - define a small first version that can be extended by later tasks:

```ts
export interface SessionOutputMetadataV1 {
  tags?: string[];
  personaName?: string;
  participantUsername?: string;
}
```

- Effective metadata resolver
  - merge session defaults with per-output metadata;
  - output metadata wins over session defaults for scalar fields;
  - tag arrays are additive and deduped in stable order;
  - later task-specific resolvers can add workspace defaults, user libraries,
    and persona detection.
- Metadata mutation helpers
  - load session metadata under mutation lock;
  - update session defaults or output metadata;
  - save metadata and update `updatedAt`;
  - optionally call a writer helper to update markdown frontmatter without
    appending conversation events.
- Web loaders
  - expose effective metadata for session rows and output/recording rows;
  - expose whether values are inherited from session defaults or set directly
    on the output.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| User adds a tag to a session before any workspace output exists | Yes | Not applicable | Yes | Future outputs inherit the session tag and write it as an effective output tag. |
| User adds a tag to a session with active outputs | Yes | Not applicable | Yes | Future appends use inherited effective tags; markdown frontmatter is updated best-effort. |
| User adds a tag to one output | Yes | Not applicable | Yes | Only that workspace output gets the direct output tag. |
| User removes an output-specific tag that is still inherited from the session | Yes | Not applicable | Mostly | First slice should not implement negative/suppression semantics; inherited tags still apply. |
| Output is stopped and later restarted | Yes | Not applicable | Yes | Output metadata remains on the workspace output and applies after restart. |
| Workspace profile refreshes aliases or writer defaults | Yes | Not applicable | Yes | Profile snapshot refresh must preserve output metadata. |
| Markdown frontmatter is disabled or file is unavailable | Yes | Not applicable | Yes | Persisted metadata changes still succeed; frontmatter update is skipped or reported. |
| User edits tags from a "recording" UI row | Yes | Not applicable | Yes | Persist the edit on the workspace output represented by that row. |

## Testing

- Contract tests:
  - accept metadata with and without `outputMetadataDefaults`;
  - accept workspace outputs with and without `outputMetadata`;
  - reject malformed metadata fields and non-string tag values;
  - preserve compatibility for existing metadata files.
- Output state tests:
  - preserve `outputMetadata` during `applyWorkspaceProfileSnapshot`;
  - create outputs without metadata by default;
  - resolve effective metadata from session defaults plus output metadata.
- Mutation helper tests:
  - update session-level defaults without touching ingestion cursors;
  - update a selected output under mutation lock;
  - reject unknown workspace output selectors;
  - update `updatedAt` consistently.
- Writer/frontmatter tests:
  - metadata-only frontmatter update can change tags without appending body
    content;
  - disabled or missing frontmatter does not block persisted metadata changes.
- Web loader/action tests:
  - project inherited versus direct metadata into Sessions/Recordings view
    models;
  - active and stopped output edits persist.
- Validation:
  - run focused contract and output-state tests first;
  - run `deno task check` for contract changes;
  - run `deno task ci` before PR.

## Non-Goals

- No tag library management; see [[task.2026.2026-06-11-output-tagging]].
- No persona prefix detection or model frontmatter migration; see
  [[task.2026.2026-05-28-persona-support]].
- No historical body rewrite.
- No import-from-frontmatter behavior.
- No taxonomy UI.
- No separate persisted Recording entity in the first slice.

## Implementation Plan

- [ ] Add shared metadata contract types for session defaults and per-output
      metadata.
- [ ] Extend `SessionMetadataV1` validation for optional
      `outputMetadataDefaults`.
- [ ] Extend `SessionWorkspaceOutputStateV1` validation for optional
      `outputMetadata`.
- [ ] Add effective metadata resolver tests and implementation.
- [ ] Preserve output metadata during workspace profile snapshot refresh.
- [ ] Add session metadata mutation helpers under the existing mutation lock.
- [ ] Add a writer helper for metadata-only markdown frontmatter updates where
      the current writer already supports the target field.
- [ ] Project inherited/direct metadata into Sessions and Recordings loaders.
- [ ] Add minimal web mutation plumbing for session-level and output-level
      metadata edits, even if the first visible UI only exposes tags later.
- [ ] Add focused contract, output-state, mutation, writer, and loader tests.
- [ ] Update dependent task notes as persona/tagging implementation choices
      settle.
