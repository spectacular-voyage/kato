---
id: 0og27ebm7j9jr750vz0r4gr
title: 2026 03 11 Interactive Web Password
desc: ''
updated: 1773300102098
created: 1773294597093
---

## Goal

Allow `kato web init` to capture the web password interactively for a human at
the terminal, while keeping scripted/bootstrap flows stable, non-interactive,
and fail-closed.

## Summary

- `kato web init --username <username>` should prompt for the password with
  hidden input when run on an interactive terminal and no explicit password
  source is provided.
- `KATO_WEB_PASSWORD` and `--password-stdin` remain supported and should stay
  the preferred non-interactive paths for CI, release smoke, and secret-manager
  flows.
- `kato web init` should check for an existing valid web config before reading
  or prompting for any password input; if config already exists, return the
  current "already exists" result without asking for secrets.
- The interactive path must confirm the password, reject empty or mismatched
  entries, and never echo or persist plaintext beyond the in-memory hashing
  flow.
- Non-interactive invocation with no password source must still fail closed
  with clear remediation text.

## Discussion

### Problem and why now

Current `kato web init` requires either `KATO_WEB_PASSWORD` or
`--password-stdin`.

That is acceptable for CI and secret-manager piping, but it is rough for the
local first-run experience, especially for the binary/npm installation track in
[[completed.2026.2026-03-11-binary-distributions]] and
[[task.2026.2026-03-11-npmjs-install]].

The operator is already at a terminal, but the command still forces shell-env
or piped-secret ceremony just to create the first password. That is needless
friction for the common case of:

- install Kato
- run `kato web init --username <username>`
- set a password once
- run `kato web start`

This task is a CLI UX hardening slice, not an auth-model redesign. The current
web security posture remains in force per [[dev.security-baseline]]:

- explicit web bootstrap remains required
- `kato web start` remains fail-closed until config exists
- only password hashes/verifiers are persisted
- web auth remains app-wide after setup

### Recommended command behavior

`kato web init` should resolve password input in this order:

1. If a valid web config already exists, return the existing-config result
   immediately and do not request or read any password input.
2. If `--password-stdin` is supplied, read password from stdin exactly as
   today.
3. If `KATO_WEB_PASSWORD` is set to a non-empty value, use it.
4. If stdin is an interactive terminal, prompt for the password interactively.
5. Otherwise fail with clear remediation text describing the supported
   non-interactive paths.

Why this order:

- it preserves the current automation contract
- it avoids prompting when init is effectively a no-op because config already
  exists
- it keeps the interactive path as a convenient fallback for humans, not a
  surprise in scripts

### Interactive prompt contract

The interactive prompt should:

- write prompts to stderr, not stdout
- use hidden no-echo terminal input rather than visible characters or `*`
  masking
- ask twice:
  - `Web password:`
  - `Confirm web password:`
- reject empty passwords
- reject mismatched confirmation
- re-prompt until valid input is received or the operator aborts with Ctrl+C or
  EOF
- always restore terminal state/raw mode on success, mismatch, error, or abort
- never log or print the plaintext password

The prompt should only capture the password. Username remains explicit via
`--username`, which keeps command history and docs clear without adding a second
interactive questionnaire flow.

### Existing-config and invalid-config behavior

Current implementation resolves the password before it knows whether
`kato web init` will actually create anything. That is the wrong order once an
interactive prompt exists.

Required behavior:

- valid existing config:
  - return the current "already exists" message
  - do not prompt
  - do not read `KATO_WEB_PASSWORD`
  - do not read stdin
- invalid/corrupt existing config:
  - fail with a path-specific validation error
  - do not prompt
  - do not overwrite the file implicitly

This keeps `web init` aligned with the repo's fail-closed config posture and
avoids collecting a secret that the command is not going to use.

### CLI and docs surface

Help/docs should present the interactive path as the default human workflow:

- `kato web init --username <username>`

Automation alternatives should still be documented immediately after:

- `KATO_WEB_PASSWORD=<password> kato web init --username <username>`
- `secret-tool read kato/web | kato web init --username <username> --password-stdin`

This prompt belongs in explicit web bootstrap, not in package-install hooks.
`npm install` / `postinstall` must remain non-interactive.

### Scenario parity table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| ----------------------------------------- | ------------------ | ---------------------- | -------------- | ------------------------------------------------------------------------------ |
| Fresh machine, interactive terminal, no password env/stdin source | No | Yes | No | New behavior: `kato web init --username <username>` should prompt instead of failing immediately |
| Fresh machine, non-interactive shell, no password env/stdin source | No | Yes | Yes | Still fail closed; no prompt attempt without a TTY |
| Fresh machine, `--password-stdin` supplied with piped secret | No | Yes | Yes | Keep exact non-interactive bootstrap path for CI and secret-manager usage |
| Fresh machine, `KATO_WEB_PASSWORD` is set | No | Yes | Yes | Keep env-based bootstrap stable for automation and release smoke |
| Valid web config already exists | Yes | No | No | Final outcome stays "already exists", but command must stop asking for passwords first |
| Existing web config is invalid/corrupt | Yes | No | No | Final outcome remains failure, but fail before collecting secret input and do not overwrite |
| Interactive user mistypes or leaves password empty | No | Yes | No | New behavior: reject and re-prompt instead of forcing restart of the whole command |

## Open Issues

- None currently recorded. This task intentionally avoids password-reset,
  rotation, or `kato init --interactive` expansion.

## Decisions

- Add interactive password prompting to `kato web init`, not to `npm
  postinstall` or other installer hooks.
- Keep `--username` required and explicit; only the password becomes
  interactive.
- Keep the supported non-interactive password sources:
  - `--password-stdin`
  - `KATO_WEB_PASSWORD`
- Password source precedence is:
  - existing valid config short-circuit
  - `--password-stdin`
  - `KATO_WEB_PASSWORD`
  - interactive terminal prompt
  - fail-closed error
- Existing valid config remains non-overwritable by `kato web init`.
- Existing invalid/corrupt config remains a hard error; this task does not add a
  reset or migration flow.
- Interactive prompting must use hidden input plus confirmation; plaintext must
  not appear in logs, stdout, stderr, or persisted config.
- CI and release smoke should continue using the explicit non-interactive paths
  rather than trying to drive an interactive terminal prompt.

## Contract Changes

- `kato web init --username <username>` becomes a supported first-run bootstrap
  path for an operator on an interactive terminal.
- `kato web init` should no longer require a password source when:
  - stdin is a TTY
  - no valid web config exists yet
- `kato web init` should no longer read or prompt for password input when a
  valid web config already exists.
- Help text for `kato help web` should show the interactive form first, with env
  and `--password-stdin` documented as automation alternatives.
- Failure messaging for missing password input should clarify that prompting is
  only available on an interactive terminal.

## Testing

- Add unit coverage for password-source resolution order:
  - existing config short-circuit
  - `--password-stdin`
  - `KATO_WEB_PASSWORD`
  - interactive prompt fallback
  - non-interactive fail-closed error
- Add command tests proving `kato web init` does not prompt or read password
  sources when config already exists.
- Add prompt-flow tests covering:
  - hidden-input path
  - empty password rejection
  - confirmation mismatch
  - terminal-state restoration on success and error
- Add regression coverage proving plaintext passwords do not appear in:
  - stdout
  - stderr
  - audit/operational log payloads
  - persisted web config
- Keep CI/package smoke on explicit non-interactive inputs:
  - `KATO_WEB_PASSWORD=<password> kato web init --username <username>`
  - or `--password-stdin`

Testing note:

- If direct TTY simulation is awkward in unit tests, factor prompt handling
  behind a small interface/helper and unit-test the behavior there; a full PTY
  integration test is useful but not required for the first implementation.

## Non-Goals

- Prompting for username, host, or port.
- Adding password reset, password rotation, or auth reconfiguration commands.
- Adding a browser-side "change password" flow.
- Folding this behavior into plain `kato init`.
- Introducing password-complexity policy beyond the current non-empty
  requirement.
- Replacing the env/stdin bootstrap paths with a prompt-only model.

## Implementation Plan

- [x] Refactor `kato web init` so it checks for an existing valid web config
      before resolving password input.
- [x] Add a small CLI password-prompt helper that reads hidden terminal input,
      confirms it, and safely restores terminal state.
- [x] Wire password-source precedence into `runWebInitCommand`:
      existing config -> `--password-stdin` -> `KATO_WEB_PASSWORD` ->
      interactive prompt -> fail-closed error.
- [x] Update `kato help web`, README/runbook wording, and any user-facing setup
      messages so the interactive bootstrap path is documented first.
- [x] Add tests for prompt flow, existing-config short-circuit,
      non-interactive failure, and secret non-leakage.
- [x] Update README.md with kato web commands and full `kato web init` description.
- [x] Update CLI help message with succinct latest info
