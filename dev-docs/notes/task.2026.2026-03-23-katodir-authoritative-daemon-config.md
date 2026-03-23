---
id: a4u5l4q3r3h8u6m6v8p7s9n
title: 2026 03 23 KatoDir Authoritative Daemon Config
desc: ''
updated: 1774295685703
created: 1774295685703
---

## Goal

Make `katoDir` the authoritative persisted root in daemon config so the config
matches the real product topology, while treating `runtimeDir` as a derived
daemon-private path unless an internal/bootstrap caller explicitly needs it.

## Summary

- The current persisted daemon config over-emphasizes `runtimeDir`:
  - `kato-daemon-config.yaml` lives under `<katoDir>/daemon/`
  - the file currently requires `runtimeDir` even though that value is usually
    just `<katoDir>/daemon`
  - this makes the config partially self-referential and exposes a lower-level
    implementation detail as a first-class user setting
- The actual product model is root-oriented:
  - shared config, shared status/control, session state, workspace registry,
    web logs, and most maintenance flows are rooted at `katoDir`
  - `runtimeDir` is mainly the daemon-private area for config/bootstrap/logs
- Recommended approach:
  - make `katoDir` the authoritative persisted setting in daemon config
  - derive canonical `runtimeDir` as `<katoDir>/daemon` when it is omitted
  - stop writing `runtimeDir` into freshly initialized/default config when the
    canonical derived value is sufficient
  - continue loading legacy `runtimeDir`-only configs by deriving
    `katoDir = dirname(runtimeDir)`
  - reject configs where both fields are present but conflict
- Keep the in-memory resolved daemon config fully populated:
  - internal callers may still receive both `katoDir` and `runtimeDir`
  - the simplification is primarily about the persisted config contract, not
    about forcing every internal caller to recompute `runtimeDir`

## Discussion

### Current problem shape

Right now the daemon config contract still treats `runtimeDir` as required and
`katoDir` as optional. In practice, though:

- the daemon bootstraps from `runtimeDir`
- the config file itself already lives inside `runtimeDir`
- the daemon writes operational/audit logs under `runtimeDir/logs`
- most cross-app state and root-oriented behavior use `katoDir`

That means the persisted contract is emphasizing the wrong thing. Operators
reason about "my Kato root" much more naturally than "the daemon-private
subdirectory inside that root."

### Why `runtimeDir` should stop being the persisted authority

The current arrangement has a few concrete downsides:

- it keeps asking users to reason about two fields when the common case is one
  canonical layout
- it encourages odd dual-path configs even though most of the system wants one
  coherent root
- it makes the config file partially describe the directory it already lives in
- it leaves root-oriented helpers and daemon-private helpers harder to separate
  conceptually

After the shared operational-path cleanup, this mismatch is more obvious:
`katoDir` is now the right high-level abstraction for root-oriented behavior,
while `runtimeDir` is a lower-level implementation detail.

### Recommended contract

I recommend the following contract:

1. Persisted daemon config is `katoDir`-authoritative.
   - `katoDir` becomes the meaningful top-level root in the YAML file.
2. `runtimeDir` becomes optional in the persisted file.
   - if omitted, derive it as `join(katoDir, "daemon")`
3. The config loader accepts both legacy and new shapes.
   - `katoDir` only: derive canonical `runtimeDir`
   - `runtimeDir` only: derive `katoDir = dirname(runtimeDir)` for backward
     compatibility
   - both present and canonical: accept
   - both present and conflicting: reject with a clear error
4. Fresh init / default serialization should prefer the minimal canonical
   shape.
   - do not emit `runtimeDir` when it is just the canonical derived path
5. Internal runtime code may still work with a resolved config object that has
   both fields populated.
   - this avoids broad churn in code that legitimately needs `runtimeDir` for
     daemon-private paths such as logs

### Why this should be done now

This is a good follow-up to the shared operational-path work:

- that task made `katoDir` authoritative for root-oriented operational reads
- daemon config is the next place where the old lower-level-first model still
  leaks into a user-facing contract
- leaving persisted config centered on `runtimeDir` would preserve one of the
  last misleading path contracts in the system

This is also a bounded cleanup. We do not need a broad storage redesign to make
the config less confusing.

### Recommended strictness

I recommend fail-closed behavior for conflicting dual-field configs.

If a config says:

- `katoDir = /A`
- `runtimeDir = /B/custom-daemon`

we should not try to preserve or guess a split layout. That is exactly the sort
of non-canonical dual-root contract that keeps producing path ambiguity.

The compatibility path worth keeping is:

- legacy `runtimeDir`-only configs still load

The compatibility path not worth keeping is:

- preserving arbitrary conflicting `katoDir` + `runtimeDir` combinations as a
  supported long-term user contract

### Recommended in-memory model

To keep implementation scope reasonable, I do not recommend forcing every
internal caller to make `runtimeDir` optional immediately.

Instead:

- the file format becomes more permissive and more canonical
- the config store resolves missing `runtimeDir`
- the returned in-memory `RuntimeConfig` can still expose a concrete
  `runtimeDir`

That keeps the cleanup focused on the persisted contract while avoiding
unnecessary churn in daemon bootstrap, logging, launcher wiring, and tests.

### Likely affected code

At minimum, audit and normalize:

- `shared/src/contracts/config.ts`
- `apps/runtime/src/config/runtime_config.ts`
- `apps/daemon/src/main.ts`
- `apps/cli/src/router.ts`
- `apps/runtime/src/maintenance/clean.ts`
- `apps/cli/src/commands/workspace_shared.ts`

Also review adjacent runtime-dir derivation helpers:

- `apps/runtime/src/utils/exports_log.ts`
- `apps/runtime/src/orchestrator/launcher.ts`
- test helpers that still treat `runtimeDir` as the primary layout input

## Open Issues

- Schema versioning:
  - Recommended answer: keep the current schema version for this cleanup.
    This is a backward-compatible relaxation of the file shape plus stricter
    validation for conflicting dual-field configs, not a full incompatible
    rewrite.
- Type-model split:
  - Recommended answer: keep `RuntimeConfig` as the resolved in-memory shape
    returned by the store for now, even if the YAML surface becomes more
    permissive than the in-memory type.
- Naming cleanup:
  - `RuntimeConfig` is effectively daemon config now, but renaming it to
    `DaemonConfig` should be a separate task if we decide it is worth the
    churn.

## Decisions

- Make `katoDir` the authoritative persisted daemon-config root.
- Treat `runtimeDir` as a derived daemon-private path by default.
- Stop emitting canonical `runtimeDir` in freshly initialized/default daemon
  config.
- Keep loading legacy `runtimeDir`-only config by deriving `katoDir`.
- Reject configs where explicit `katoDir` and explicit `runtimeDir` conflict.
- Keep runtime/bootstrap env overrides such as `KATO_RUNTIME_DIR` and
  `KATO_CONFIG_PATH` as bootstrap mechanisms, not as reasons to keep
  `runtimeDir` as the main persisted authority.
- Keep the in-memory resolved config populated with both `katoDir` and
  `runtimeDir` for now to avoid unnecessary downstream churn.
- Do not expand this task into a broader rename of `RuntimeConfig` or a broader
  relocation of user/shared config files.

## Contract Changes

- Persisted daemon config becomes root-oriented:
  - `katoDir` is the primary explicit root
  - `runtimeDir` may be omitted when canonical
- Canonical runtime-dir derivation becomes explicit:
  - `runtimeDir = join(katoDir, "daemon")`
- Legacy daemon config compatibility narrows to one acceptable fallback:
  - `runtimeDir`-only config remains loadable
  - conflicting dual-field config does not remain silently supported
- Default/init-generated daemon config should reflect the canonical minimal
  shape instead of redundantly restating derived runtime paths.
- Internal code that needs daemon-private log/config/bootstrap paths may still
  consume resolved `runtimeDir` after load.

## Testing

- Add parser/serializer coverage for daemon config shapes:
  - `katoDir` only
  - `runtimeDir` only
  - both present and canonical
  - both present and conflicting
- Add default/init coverage ensuring freshly created daemon config omits
  canonical `runtimeDir`.
- Add regression coverage for helpers that should now share one canonical
  runtime-dir derivation rule.
- Update CLI/daemon tests that assume persisted config must always contain
  explicit `runtimeDir`.
- Re-run focused suites for:
  - runtime config store
  - daemon bootstrap
  - CLI runtime building / init
  - maintenance clean paths
  - launcher/runtime harnesses that read resolved config

## Non-Goals

- Renaming `RuntimeConfig` to `DaemonConfig`
- Moving `kato-user-config.yaml` or shared config to a different top-level root
- Removing `runtimeDir` from all internal runtime types immediately
- Supporting arbitrary long-term split layouts where `runtimeDir` is not the
  canonical `<katoDir>/daemon`
- Redesigning daemon env overrides such as `KATO_RUNTIME_DIR` or
  `KATO_CONFIG_PATH`

## Implementation Plan

- [ ] Add a shared canonical helper for deriving daemon `runtimeDir` from
      `katoDir` so path construction is not duplicated ad hoc.
- [ ] Update daemon-config parsing so persisted config can omit `runtimeDir`
      and still resolve a complete in-memory config.
- [ ] Keep loading legacy `runtimeDir`-only config by deriving `katoDir` from
      `dirname(runtimeDir)`.
- [ ] Reject config documents where explicit `katoDir` and explicit
      `runtimeDir` disagree.
- [ ] Update default/init serialization so freshly created daemon config omits
      canonical `runtimeDir`.
- [ ] Audit daemon/bootstrap/CLI helpers that still use `dirname(runtimeDir)`
      directly and switch them to the shared canonical derivation where
      appropriate.
- [ ] Update focused tests for runtime config, daemon startup, CLI init/runtime
      building, maintenance clean, and related helpers.
- [ ] Update [[dev.codebase-overview]] and [[dev.decision-log]] if the final
      implementation changes the documented daemon-config contract.
