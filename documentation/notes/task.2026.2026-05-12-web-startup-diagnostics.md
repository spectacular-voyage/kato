---
id: r7mkc2q8h5n4p1z6w9t3v0x
title: 2026 05 12 Web Startup Diagnostics
desc: ''
updated: 1778544000000
created: 1778544000000
---

## Goal

Make `kato web start` failures diagnosable when the detached web subprocess
exits before the CLI observes a startup acknowledgement.

## Summary

The web launcher starts a detached process, then the CLI waits for either a
status heartbeat or an HTTP response. If the detached child exits early, the CLI
currently reports only the PID-level acknowledgement failure. That hides the
actual server stderr/stdout that would explain port, build, permission, or
runtime crashes.

## Discussion

The desired hardening is diagnostic, not a lifecycle redesign. The launcher
should preserve detached web child output in stable log files under the Kato web
log directory. The CLI should include those paths, plus a small recent tail when
available, in startup acknowledgement failures.

## Open Issues

- None yet.

## Decisions

- Use separate stdout and stderr startup logs so Windows `Start-Process`
  redirection does not contend for a single file handle.
- Truncate startup logs before each launch so the failure tail is current and
  small.
- On Windows, use a `cmd.exe /d /s /c` wrapper only when startup logs are
  active. Direct `Start-Process` stdout/stderr redirection can keep the launcher
  PowerShell process alive until the web server exits.

## Contract Changes

- `WebProcessLaunchResult` may include startup stdout/stderr log paths.
- Default source and installed web launches write detached child output under
  `<katoDir>/web/logs/`.

## Testing

- Add launcher coverage for generated PowerShell/shell redirection.
- Add CLI coverage that acknowledgement failure messages include startup log
  paths and recent output.

## Non-Goals

- Changing web process supervision semantics.
- Persisting a full web process history log.

## Implementation Plan

- [x] Add default startup stdout/stderr log path helpers.
- [x] Redirect detached web subprocess stdout/stderr to startup logs.
- [x] Surface startup log paths and recent tails in ack failure messages.
- [x] Add focused launcher and CLI regression tests.
- [x] Run formatting and focused tests.
