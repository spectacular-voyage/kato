---
id: 20260511-per-output-writer-controls
title: 2026 05 11 Per Output Writer Controls
desc: ''
updated: 1778545425848
created: 1778545425848
---

## Goal

Allow Kato Web users to control whether assistant commentary and assistant
thinking are rendered for each persisted workspace output, without requiring
in-chat commands or workspace-wide config changes.

## Summary

Kato already has writer flags for assistant commentary and thinking:

- `writerIncludeCommentary` controls assistant progress/commentary messages.
- `writerIncludeThinking` controls normalized provider thinking/reasoning
  events.

Those flags currently resolve from runtime/workspace config and are stored as a
workspace profile snapshot on each `workspaceOutputs[]` entry. That is not quite
the right place for user edits from the web UI, because the snapshot is meant to
represent workspace defaults and can be refreshed from the workspace profile.

Add per-output writer flag overrides to persisted session metadata. Web controls
should update those overrides on a specific workspace output. Runtime rendering
should resolve effective writer flags from current workspace defaults plus the
per-output overrides.

This task should build on [[task.2026.2026-06-11-session-output-metadata]] for shared mutation, loader, and metadata-only frontmatter update patterns. The writer override field can remain separate from `outputMetadata`, because it is render policy rather than descriptive output metadata.

Frontmatter should optionally record the effective writer policy for portability
and auditability, but frontmatter must not be the source of truth. Outputs may
have frontmatter disabled, may be JSONL, or may not be writable when the user
changes the setting.

## Discussion

### Why Per Output

A provider session can have multiple workspace outputs. The same conversation
may be recorded to a private note with commentary/thinking enabled and to a
cleaner shared note with those channels disabled. That makes this an output
policy, not a provider-session policy.

The current persisted output shape already owns output-specific state such as
destination, desired recording state, write cursor, and recording cycles. Adding
writer overrides there keeps the controls close to the thing they affect.

### Commentary Versus Thinking

Codex progress messages such as "I'll inspect..." are normalized as
`message.assistant` with `phase: commentary`. They are not `thinking` events and
will show in `conversationEventKinds` as `message.assistant`.

Provider reasoning summaries are normalized as `thinking` and map to
`assistant.thinking` in the session twin. The markdown frontmatter
`conversationEventKinds` field stores normalized `ConversationEventKind` values,
so it would say `thinking`, not `assistant.thinking`, when thinking events are
present.

This feature therefore needs at least two separate controls:

- Assistant commentary: backed by `writerIncludeCommentary`.
- Assistant thinking: backed by `writerIncludeThinking`.

### Source Of Truth

The source of truth should be persisted session metadata:

```ts
workspaceOutputs[].writerFeatureFlagOverrides?: {
  writerIncludeCommentary?: boolean;
  writerIncludeThinking?: boolean;
}
```

Missing keys mean "inherit from workspace default." Present booleans mean
"override this output." This gives the web UI a tri-state model:

- workspace default
- include
- exclude

Do not store the user's per-output choice only in markdown frontmatter. That
would fail for outputs without frontmatter, outputs that are not markdown, and
settings changes made while an output file is unavailable.

Do not mutate `workspaceOutputs[].writerFeatureFlags` for this feature. That
field is a snapshot of workspace defaults and is refreshed by workspace profile
application.

### Frontmatter Portability

When markdown frontmatter is enabled, Kato should record the effective render
policy in frontmatter. A possible shape:

```yaml
kato-writerFeatureFlags:
  writerIncludeCommentary: false
  writerIncludeThinking: true
```

This is descriptive metadata for humans and future import/export workflows. It
should not drive live Kato behavior unless a separate future import feature
explicitly chooses to read it.

For append flows, this field should update like other accretive frontmatter
metadata. Unlike `conversationEventKinds`, it is not accretive; it is a snapshot
of the current effective render policy for that output.

### Web UI

Expose controls on recording/output rows in Sessions and Recordings surfaces.
The controls should be compact and scan-friendly:

- `Commentary`: default / include / exclude
- `Thinking`: default / include / exclude

The row should show resolved state when an override differs from workspace
default, for example "Commentary excluded, overriding workspace default."

Changing a setting should affect future writes for that output. It should not
rewrite already-rendered markdown. A separate rebuild/export feature would be
needed to regenerate historical output under a new policy.

## Open Issues

- Decide whether the initial UI belongs on both Sessions and Recordings pages,
  or whether Sessions is enough for the first implementation.
- Decide the exact frontmatter key name. `kato-writerFeatureFlags` is explicit
  and aligns with existing writer flag names, but it is more developer-facing
  than a friendlier `kato-renderPolicy`.
- Decide whether stopped outputs should allow policy edits immediately. The
  likely answer is yes, because the override affects future re-arm/restart.

## Decisions

- Store per-output writer choices in persisted session metadata under each
  `workspaceOutputs[]` entry.
- Reuse the shared session/output metadata foundation for mutation locking, loader projection, and metadata-only frontmatter update patterns.
- Use override semantics rather than copying full effective flags into the
  override field.
- Keep `workspaceOutputs[].writerFeatureFlags` as the workspace-default
  snapshot, not the user-editable output policy.
- Make web UI controls tri-state: inherit workspace default, include, exclude.
- Include `writerIncludeCommentary` and `writerIncludeThinking` in the initial
  scope.
- Treat frontmatter policy as descriptive output metadata, not the authoritative
  config store.
- Do not rewrite existing output content when a per-output setting changes.

## Contract Changes

- Add optional persisted output overrides:

```ts
export interface SessionWorkspaceOutputWriterFeatureFlagOverridesV1 {
  writerIncludeCommentary?: boolean;
  writerIncludeThinking?: boolean;
}

export interface SessionWorkspaceOutputStateV1 {
  // existing fields...
  writerFeatureFlagOverrides?: SessionWorkspaceOutputWriterFeatureFlagOverridesV1;
}
```

- Effective writer flags for a workspace output resolve as:
  - current registered workspace profile flags, when the workspace still exists
  - otherwise persisted `output.writerFeatureFlags`
  - plus `output.writerFeatureFlagOverrides`
- Web mutation handlers should update `writerFeatureFlagOverrides` on the
  selected `workspaceOutputs[]` entry and save session metadata.
- Session/recording loaders should expose:
  - effective commentary/thinking values
  - override commentary/thinking values
  - workspace-default commentary/thinking values when available
- Markdown writer frontmatter may include the effective writer policy when
  frontmatter is enabled.
- Outputs without frontmatter must still honor per-output overrides from
  persisted metadata.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
|---|---|---|---|---|
| Active output override changed from Web | Yes | No | No | Persistent metadata is the source of truth. Non-persistent in-memory command state can remain workspace-default until it is retired or migrated. |
| Stopped output override changed from Web | Yes | Not applicable | Yes | The override should apply when the output is re-armed or restarted. |
| Workspace config changes after output override | Yes | No | No | Per-output override should continue to win over new workspace defaults. |
| Frontmatter disabled | Yes | Yes | Yes | Rendering behavior must not depend on frontmatter. |
| Markdown frontmatter enabled | Yes | Yes | Yes | Frontmatter records effective policy for audit, but does not drive runtime state. |
| Existing metadata without overrides | Yes | Yes | Yes | Missing overrides mean inherit workspace defaults, preserving current behavior. |

## Testing

- Add session contract tests for metadata with and without
  `writerFeatureFlagOverrides`.
- Add output state tests proving workspace profile snapshot refresh preserves
  per-output overrides.
- Add runtime tests proving active persisted appends apply overrides over
  workspace defaults.
- Add web mutation tests for setting commentary/thinking to inherit, include,
  and exclude.
- Add web loader/view-model tests exposing effective, default, and override
  values for output rows.
- Add markdown writer/frontmatter tests for the effective writer policy metadata.
- Add regression coverage showing `conversationEventKinds` remains event-kind
  metadata and is not used as render policy.
- Run focused tests first, then `deno task check --frozen`.

## Non-Goals

- No historical rewrite of already-rendered markdown.
- No provider-ingestion filtering of thinking or commentary events.
- No in-chat command flag implementation in this task.
- No sidecar config file next to each output.
- No import-from-frontmatter behavior.
- No UI for every writer flag in the first pass.

## Implementation Plan

- [ ] Land [[task.2026.2026-06-11-session-output-metadata]] or enough of its shared mutation/loader/frontmatter-update helpers to avoid duplicate plumbing.
- [ ] Add persisted contract type and validation for output writer flag overrides.
- [ ] Add helpers to resolve effective output writer flags from defaults plus overrides.
- [ ] Preserve overrides when applying workspace profile snapshots.
- [ ] Apply effective output flags in daemon persisted append/capture/restart flows.
- [ ] Apply effective output flags in web recording mutation flows.
- [ ] Add web mutation endpoint/action for per-output commentary/thinking overrides.
- [ ] Project output policy fields into Sessions and Recordings row data.
- [ ] Add compact tri-state controls to web output rows.
- [ ] Record effective writer policy in markdown frontmatter when frontmatter is enabled.
- [ ] Add focused contract, runtime, writer, loader, and web action tests.
- [ ] Update developer/user documentation after behavior is implemented.
