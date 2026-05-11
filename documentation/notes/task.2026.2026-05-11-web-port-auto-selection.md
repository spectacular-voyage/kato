---
id: 20260511-web-port-auto-selection
title: 2026 05 11 Web Port Auto Selection
desc: ""
updated: 1778505600000
created: 1778505600000
---

## Goal

Allow Kato Web startup to avoid a configured localhost port that is already in
use, including the common WSL2 case where Windows owns the browser-visible
`127.0.0.1` port.

## Summary

Kato Web currently launches on the configured web port, defaulting to 5173. A
Windows Kato Web instance and a WSL2 Kato Web instance can both believe they are
using `http://127.0.0.1:5173/`, while the Windows browser-visible URL resolves
to the Windows service.

Select the effective port at `kato web start` time. If the configured port is
occupied, try the next port upward and launch with the first available port.

## Discussion

The local bind probe catches listeners in the current OS namespace. That is not
enough for WSL2 because a Windows listener can own the browser-visible
`127.0.0.1` port while a Linux bind probe still succeeds inside WSL.

For Linux under WSL, add a best-effort Windows listener probe via
`powershell.exe`. If Windows interop is unavailable or blocked, fall back to the
local bind probe rather than failing startup.

## Open Issues

No product blockers.

## Decisions

- Select the effective port during `kato web start`, not during `kato web init`.
- Do not rewrite the saved web config when falling back to another port.
- While the web service is running or stale, status should report the port from
  the web heartbeat/status file rather than the configured default.
- Keep the Windows listener check best-effort so WSL installs without
  PowerShell interop still start normally.

## Contract Changes

- `kato web start` may launch on the first available port at or above the
  configured web port.
- The persisted web config remains the user's preferred port.
- `kato web status` and aggregate `kato status` report the actual running or
  stale Kato Web URL when it differs from config.

## Testing

- Add runtime tests for preferred-port selection, local bind collision fallback,
  and WSL Windows-host listener fallback.
- Add CLI lifecycle coverage proving startup uses the selected port and status
  reports it.
- Update aggregate status coverage so it fails if configured port is preferred
  over a live status port.

## Non-Goals

- No new CLI flag for a port scan range.
- No rewrite of existing web config files.
- No attempt to identify whether the process owning the port is specifically
  Kato Web.

## Implementation Plan

- [x] Add runtime port-selection helpers with local bind and WSL Windows-host probes.
- [x] Wire `kato web start` through the selected effective port.
- [x] Report running/stale status from the persisted heartbeat port.
- [x] Add focused tests and run the relevant suites.
