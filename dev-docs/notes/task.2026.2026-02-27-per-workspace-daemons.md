---
id: 3hcvyoruw53sn36me1xjvfz
title: 2026 02 27 per Workspace Daemons
desc: ''
updated: 1772256650399
created: 1772252011318
---

# Per-Workspace Daemon Instances

## Goal

Support workspace-local Kato setups by letting each workspace have its own
runtime config and its own generated recording defaults.

The main UX target is:

1. run `kato init` for a workspace-local setup
2. get a config seeded from a reusable personal template, if present
3. use `::init`, `::record`, and `::capture` with either relative paths or no
   path at all
4. have generated destinations land in the workspace’s preferred location and
   naming scheme

## What We Already Have

- Runtime config already carries recording-adjacent settings, including
  `markdownFrontmatter.includeConversationEventKinds`.
- Generated default destinations are still hard-coded in
  `/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/daemon_runtime.ts`:
  - root dir: `~/.kato/recordings`
  - filename shape: `<provider>-<shortSessionId>-<timestamp>.md`
- `kato init` currently writes only the built-in default config shape.
- In-chat explicit path arguments are still absolute-only today.

## Approach

Add the minimum config surface needed to make workspace-local setups practical:

- add config-driven generated output defaults
- allow relative explicit command paths
- add a reusable global config template that seeds new workspace configs during
  `kato init`

## Proposed Config Additions

Add two optional runtime-config fields:

- `defaultOutputPath?: string`
- `filenameTemplate?: string`

Recommended semantics:

- `defaultOutputPath` is the base directory used when Kato needs to generate a
  destination for a pathless command.
- `filenameTemplate` is the filename pattern used under that directory.
- If either field is omitted, Kato falls back to the current behavior so older
  configs remain valid.

Recommended default values (to preserve current behavior):

- `defaultOutputPath: ~/.kato/recordings`
- `filenameTemplate: "{provider}-{shortSessionId}-{YYYY}{MM}{DD}-{HH}{mm}{ss}.md"`

## Config Template For New Workspaces

Add support for a reusable config template in `~/.kato/` that is consulted only
when creating a new workspace-local config with `kato init`.

Recommended behavior:

- If a global config template file exists, `kato init` uses it as the starting
  shape for new per-workspace configs.
- If no template exists, `kato init` uses the normal built-in defaults.
- The template is a scaffold source only. It is not merged at runtime after the
  workspace config has been created.
- This lets users reuse personal defaults like:
  - `filenameTemplate`
  - `markdownFrontmatter.includeConversationEventKinds`
  - preferred `providerSessionRoots`
  - feature-flag defaults

Important path rule:

- Relative paths in the template should be copied into the new workspace config
  as relative values, not resolved against `~/.kato/` at scaffold time.
- That way a template value like `defaultOutputPath: dev-docs/notes` remains
  portable and resolves relative to each workspace config after initialization.

## Filename Template Contract

Keep templating intentionally small.

Initial token set:

- `{provider}`: sanitized provider name
- `{sessionId}`: full session id
- `{shortSessionId}`: first 8 chars of session id
- `{snippetSlug}`: slugified conversation snippet/title
- `{YYYY}`: local year
- `{MM}`: local month (`01`-`12`)
- `{DD}`: local day (`01`-`31`)
- `{HH}`: local hour (`00`-`23`)
- `{mm}`: local minute (`00`-`59`)
- `{ss}`: local second (`00`-`59`)

Rules:

- Template expansion produces a filename only, not a full path.
- The template must not be allowed to escape directories (`/`, `..`, or path
  separators introduced by token values).
- If the rendered filename is empty or invalid, fail closed and log clearly.
- Timestamp tokens use local time from the daemon host, not UTC.
- `snippetSlug` should be derived from the same snippet/title source already
  used for recording titles, then slugified and sanitized.
- Keep `.md` in the default template for now; this task does not introduce
  format-aware filename generation.

## Path Resolution Rules

- Generated paths should resolve as:
  `join(resolvedDefaultOutputDir, renderedFilename)`.
- If `defaultOutputPath` is absolute, use it directly.
- If `defaultOutputPath` is relative, resolve it against the config root
  (`katoDir` / the directory containing the runtime config), not against the
  daemon process cwd.
- Explicit relative command arguments should also resolve against that same
  config root, not against daemon cwd.
- Explicit absolute command arguments remain valid.
- The final generated path still goes through the existing write-path policy
  gate.
- `allowedWriteRoots` remains the hard security boundary.

## Scope

- [ ] Add `defaultOutputPath` and `filenameTemplate` to the runtime config
  contract.
- [ ] Add a global config-template file that `kato init` can use to seed new
  workspace configs.
- [ ] Parse, validate, clone, and serialize those fields in the runtime config
  store.
- [ ] Allow relative explicit command paths by resolving them against the
  workspace config root.
- [ ] Include the new fields in configs generated by `kato init`.
- [ ] Replace hard-coded default destination generation for pathless `::init`,
  `::record`, and `::capture`.
- [ ] Update docs to show how a workspace-local daemon can customize default
  recording output.

## Implementation Plan

### 1. Extend shared config contract

- [ ] Update
  [/home/djradon/hub/spectacular-voyage/kato/shared/src/contracts/config.ts](/home/djradon/hub/spectacular-voyage/kato/shared/src/contracts/config.ts)
  to add:
  - [ ] `defaultOutputPath?: string`
  - [ ] `filenameTemplate?: string`

### 2. Extend runtime config parsing/defaults

- [ ] Update
  [/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/config/runtime_config.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/config/runtime_config.ts)
  to:
  - [ ] validate both fields as strings when present
  - [ ] expand `~` for `defaultOutputPath` during load
  - [ ] resolve/normalize relative `defaultOutputPath` against `katoDir`
  - [ ] preserve home shorthand when generating default config (same style as
    existing path fields)
  - [ ] clone both fields correctly
  - [ ] emit default values from `createDefaultRuntimeConfig(...)`
  - [ ] keep relative values portable when copied from the global config
    template into a new workspace config

### 3. Add global config-template support for `kato init`

- [ ] Add a template lookup in `~/.kato/` for new workspace initialization.
- [ ] Parse and validate the template before using it.
- [ ] Treat the template as a partial scaffold source, not a runtime overlay.
- [ ] Define merge order for new workspace config creation as:
  - [ ] built-in defaults
  - [ ] global config template values, if present
  - [ ] workspace-specific path values written by the init flow
- [ ] Fail closed if the template is invalid, with a clear init error.

### 4. Replace hard-coded default destination generation

- [ ] Refactor
  [/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/daemon_runtime.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/daemon_runtime.ts):
  - [ ] replace `resolveDefaultRecordingRootDir()`
  - [ ] replace `makeDefaultRecordingDestinationPath(...)`
  - [ ] introduce a config-aware helper that builds the generated destination
    from `defaultOutputPath` + `filenameTemplate`
  - [ ] use that helper anywhere pathless `::init`, `::record`, or `::capture`
    currently falls back to a generated path
  - [ ] generate timestamp pieces from local time, not `toISOString()`
  - [ ] generate `snippetSlug` from the current conversation snippet/title

### 5. Support relative explicit command paths

- [ ] Update command argument resolution in
  [/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/daemon_runtime.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/daemon_runtime.ts)
  so explicit relative arguments are accepted.
- [ ] Resolve explicit relative arguments against the config root / workspace
  root.
- [ ] Keep existing normalization for markdown-link and quoted path arguments.
- [ ] Continue rejecting invalid or escaping paths after normalization.

### 6. Surface new defaults in `kato init`

- [ ] Ensure the generated config written by `kato init` includes
  `defaultOutputPath` and `filenameTemplate`.
- [ ] If the global config template exists, use it to seed the new workspace
  config before writing the file.

### 7. Tests

- [ ] Update
  [/home/djradon/hub/spectacular-voyage/kato/tests/runtime-config_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/runtime-config_test.ts):
  - [ ] accept valid values
  - [ ] reject invalid types
  - [ ] preserve backward compatibility when fields are missing
  - [ ] verify relative `defaultOutputPath` resolves against config location
  - [ ] verify `filenameTemplate` loads and clones correctly
- [ ] Update
  [/home/djradon/hub/spectacular-voyage/kato/tests/daemon-cli_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/daemon-cli_test.ts)
  to verify:
  - [ ] `kato init` writes the new defaults
  - [ ] `kato init` uses the global config template when present
  - [ ] invalid global config template fails init clearly
- [ ] Update
  [/home/djradon/hub/spectacular-voyage/kato/tests/daemon-runtime_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/daemon-runtime_test.ts):
  - [ ] bare `::init` uses config-driven default path
  - [ ] bare `::record` uses config-driven default path
  - [ ] bare `::capture` uses config-driven default path
  - [ ] explicit relative `::init` path resolves against config root
  - [ ] explicit relative `::capture` path resolves against config root
  - [ ] explicit relative `::export` path resolves against config root
  - [ ] filename template rendering uses expected tokens, including
    `snippetSlug`
  - [ ] local-time date-part tokens render correctly
  - [ ] final generated path is still denied when outside `allowedWriteRoots`

### 8. Docs

- [ ] Update
  [/home/djradon/hub/spectacular-voyage/kato/README.md](/home/djradon/hub/spectacular-voyage/kato/README.md)
  runtime-config docs and examples.
- [ ] Add one example of a workspace-local config that writes into a project
  notes directory.
- [ ] Add one example of a reusable global config template for new workspaces.

## Acceptance Criteria

- [ ] A runtime config can define `defaultOutputPath` and
  `filenameTemplate`.
- [ ] Pathless `::init`, `::record`, and `::capture` use those defaults instead
  of the current hard-coded `~/.kato/recordings/...` path.
- [ ] Explicit relative command paths are accepted and resolve against the
  workspace config root.
- [ ] Relative `defaultOutputPath` is resolved against config location, not
  daemon cwd.
- [ ] `kato init` can seed a new workspace config from a reusable template in
  `~/.kato/`, when present.
- [ ] Existing configs without the new fields keep the current generated-path
  behavior.
- [ ] Generated paths still respect `allowedWriteRoots`.
- [ ] Filename templating supports `snippetSlug` and local-time date-part
  tokens from year down to seconds.

## Risks and Mitigations

- Risk: `defaultOutputPath` is ambiguous (file path vs directory path).
  Mitigation: define it explicitly as a base directory for generated
  destinations.
- Risk: template surface grows into a mini DSL.
  Mitigation: start with a fixed token list only.
- Risk: relative default paths accidentally depend on daemon cwd.
  Mitigation: resolve against config location (`katoDir`) only.
- Risk: relative explicit command args could escape the workspace unexpectedly.
  Mitigation: normalize, resolve against config root, then run the existing
  write-path policy gate on the final path.
- Risk: a broken global config template could silently create bad workspace
  configs.
  Mitigation: validate the template before use and fail init clearly on errors.

## Open Questions

- [ ] What is the exact template filename in `~/.kato/`?
- [ ] Should the global config template be parsed as a full runtime config
  shape, or as a smaller partial schema limited to scaffoldable fields?
- [ ] Should the same filename generator also be reused for CLI `export` when
  `--output` is omitted, once that path is aligned with the documented
  behavior?
