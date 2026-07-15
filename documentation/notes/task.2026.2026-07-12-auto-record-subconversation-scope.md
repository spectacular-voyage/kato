---
id: task-2026-07-12-auto-record-subconversation-scope
title: Auto-Record Sub-Conversation Scope
desc: Make workspace auto-recording top-level-only by default with an explicit sub-conversation opt-in.
updated: 1783892284000
created: 1783892284000
---

## Goal

Keep workspace auto-recording focused on top-level conversations by default while allowing a workspace to explicitly include provider-declared sub-conversations.

## Summary

The v0.2.14 `autoRecordConversations` setting currently auto-attaches every eligible Claude session whose provider working directory is inside the workspace, including recognized Claude sub-conversations whose transcripts carry `cwd`. Add a separate `autoRecordSubconversations` workspace setting. The master setting remains opt-in; once enabled, top-level conversations are recorded by default and sub-conversations require the second explicit opt-in.

There is no adoption requiring backward compatibility. Missing `autoRecordSubconversations` values resolve directly to `false`; no legacy-mode detection, compatibility mapping, or config migration is required.

## Discussion

Sub-conversations can greatly outnumber top-level conversations and create a separate output file for every delegated agent. The default should preserve the main conversation while avoiding that fan-out. Operators who want complete agent-level history can opt into it per workspace.

Both auto-record settings remain top-level workspace behavior. `workspaceFeatureFlags` owns writer behavior after an output has been attached; automatic recording decides whether Kato creates that attachment in the first place and therefore does not belong in the writer-flag namespace.

The runtime must use the same provider-aware relationship semantics as the Sessions tree. Codex persists `parentProviderSessionId`, but Claude currently derives parentage from the exact `.../<parent>/subagents/<child>.jsonl` source layout. Checking persisted parent metadata alone would incorrectly treat Claude children as top-level conversations. A recognized child remains a child even when its parent session is unavailable.

This scope controls automatic attachment only. It must not stop, delete, or otherwise mutate an existing workspace output. Manually started recordings and previously attached outputs continue through the normal recording lifecycle.

`kato workspace init` currently prefers the shared default workspace template at `~/.kato/shared/default-kato-workspace-config.yaml` and copies it verbatim. A sparse or older shared template can therefore make newly initialized workspace configs omit newer settings even though Kato knows their resolved defaults. Treat the shared template as schema-validated overrides over Kato's current built-in defaults, then canonically serialize the fully materialized values into the new workspace config. The shared template itself and existing workspace configs remain untouched.

## Open Issues

- None. The requested product contract is top-level-only by default with an explicit additive sub-conversation opt-in.

## Decisions

- Keep `autoRecordConversations: boolean` as the master workspace opt-in, defaulting to `false`.
- Add `autoRecordSubconversations: boolean`, defaulting to `false` when absent.
- Keep `autoRecordConversations` and `autoRecordSubconversations` at the workspace-config top level; do not place orchestration settings under writer-focused `workspaceFeatureFlags`.
- Interpret `autoRecordConversations: true` plus a missing or false child setting as top-level-only automatic recording.
- Require both settings to be true before automatically attaching a recognized sub-conversation.
- Use provider-aware classification: an explicit `parentProviderSessionId`, or for Claude, the exact supported `subagents` source-path layout.
- Label the web controls `Auto-record top-level conversations` and `Also auto-record sub-conversations`.
- Keep workspace initialization opt-in: `kato workspace init` must expose both knobs as `false`, never enable automatic recording implicitly.
- Parse the shared default workspace template as a sparse override, resolve every omitted top-level and nested setting from the current schema defaults, and serialize a complete canonical workspace config for newly initialized workspaces.
- Preserve explicit shared-template values over built-in defaults, including partial `markdownFrontmatter` and `workspaceFeatureFlags` overrides.
- Do not rewrite the shared template while materializing a new workspace config.
- Keep the second setting dormant when the master setting is false; do not add migration or compatibility behavior.
- Apply scope only when deciding whether to create a new automatic workspace output. Do not auto-stop existing outputs.

## Contract Changes

- `.kato-workspace-config.yaml` accepts top-level `autoRecordSubconversations: boolean`.
- Workspace config overrides, file values, resolved values, and resolved profiles expose `autoRecordSubconversations`.
- `createWorkspaceConfigScaffold()` and newly initialized shared default workspace templates write both auto-record settings as `false`.
- `kato workspace init` no longer copies the shared template text verbatim. It creates a complete canonical workspace config by overlaying parsed shared-template overrides on current resolved defaults, then adds the workspace id through the normal initialization path.
- Newly generated configs materialize omitted scalar, list, `markdownFrontmatter`, and `workspaceFeatureFlags` defaults while preserving explicitly configured template values.
- Kato Web loads, renders, submits, and canonically serializes the new setting.
- Automatic attachment treats provider-declared children as ineligible unless the workspace's resolved `autoRecordSubconversations` value is true.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| Both settings false or absent | Yes | N/A | N/A | No session is automatically attached. |
| Master true, child setting false or absent, top-level Claude session matches workspace | Yes | N/A | N/A | The top-level session is automatically attached. |
| Master true, child setting false or absent, Claude child matches workspace | Yes | N/A | N/A | The child is skipped even when it has a matching `cwd`. |
| Both settings true, Claude child matches workspace | Yes | N/A | N/A | The child receives its own automatic workspace output. |
| Child setting true while master is false | Yes | N/A | N/A | The child setting is dormant and nothing is attached. |
| Shared template omits current settings | Yes | N/A | N/A | A newly initialized workspace materializes the current defaults plus all explicit template overrides; the shared template is unchanged. |
| Recognized child has no available parent row | Yes | N/A | Yes | Provider-declared child status still controls eligibility. |
| Child already has an active or stopped workspace output | Yes | N/A | Yes | Scope changes do not stop, delete, or re-arm existing outputs. |
| Codex or Gemini session | Yes | N/A | Yes | Provider eligibility remains Claude-only in this feature slice. |

## Testing

- Cover config parsing, type validation, canonical serialization, resolved defaults, cloning, scaffold output, and workspace mutation for `autoRecordSubconversations`.
- Cover fresh `kato init` shared-template creation and `kato workspace init` output, proving both settings are present and false.
- Cover a sparse shared template with explicit scalar, list, partial `markdownFrontmatter`, and partial `workspaceFeatureFlags` overrides; prove the generated workspace config combines those overrides with every current default and leaves the source template unchanged.
- Prove invalid or unsupported shared-template values still fail closed rather than being silently discarded.
- Prove an existing workspace config remains byte-for-byte unchanged when `kato workspace init` is rerun.
- Cover Kato Web loader and POST round trips plus server-rendered checkbox labels and checked state.
- Prove a matching top-level Claude conversation still auto-records with only the master setting enabled.
- Prove a matching Claude sub-conversation with `cwd` is skipped by default and included when both settings are enabled.
- Cover POSIX and Windows Claude child path classification or reuse an already-tested shared classifier without duplicating heuristics.
- Prove explicit parent metadata classifies a child even when its parent row is unavailable.
- Prove disabling child auto-attachment does not stop or mutate an existing child workspace output.
- Keep non-Claude exclusion, missing `cwd`, outside-workspace, empty-event, and existing-output behavior covered.
- Run focused config/web/runtime tests, `deno task ci`, and the production web build.

## Non-Goals

- Do not add backward compatibility, legacy config inference, migration tooling, or downgrade support.
- Do not rewrite existing shared default workspace templates or existing workspace configs to insert missing keys.
- Do not preserve shared-template comments or hand formatting in the newly generated workspace config; generation uses the schema-owned canonical serializer while leaving the source template untouched.
- Do not enable Codex or Gemini auto-recording.
- Do not combine child events into a parent's output file.
- Do not stop or delete existing recordings when settings change.
- Do not infer child status from snippets, names, timestamps, or provider-session id prefixes.

## Implementation Plan

- [ ] Add the `autoRecordSubconversations` top-level workspace config contract, false default, scaffold values, resolver projection, and mutation support.
- [ ] Materialize complete canonical workspace configs from sparse shared-template overrides during `kato workspace init`, without rewriting the template or existing configs.
- [ ] Add web editor loading, submission, canonical serialization, labels, and focused tests.
- [ ] Add a provider-aware auto-record eligibility predicate shared with existing relationship semantics.
- [ ] Gate new child auto-attachments behind both workspace settings without changing existing-output behavior.
- [ ] Add parent-only, child-opt-in, unlinked-child, transition, and provider regression tests.
- [ ] Update user, developer, decision, testing, feature, and release documentation.
- [ ] Run focused validation, the full CI gate, and the production web build.
