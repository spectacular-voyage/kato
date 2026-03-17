---
id: r81e47fxow5rps1s86ddz7i
title: 'Distribution Phase 2'
desc: ''
updated: 1773767954991
created: 1773375447431
---

## Purpose

Capture post-Phase-1 distribution ideas that are worth keeping, but are not
part of the current binary/npm closeout tracked in
[[completed.2026.2026-03-11-binary-distributions]] and
[[task.2026.2026-03-11-npmjs-install]].

## Carry-Forward Constraints

- Keep installs user-scoped first.
- Keep program files outside `~/.kato`; keep runtime/config/state inside
  `~/.kato`.
- Even with service/autostart integration, daemon identity should stay tied to
  the runtime root and shared files under `~/.kato`.
- Uninstall should preserve `~/.kato` by default unless the user explicitly
  chooses data purge.
- Update and uninstall behavior must stay channel-aware so npm, installers,
  direct archives, and source checkouts do not fight each other.

## Candidate Tracks

### Channel-Aware Self-Update

- Add `kato self-update` only when Kato can reliably tell which install channel
  owns the current binaries.
- Introduce `~/.kato/shared/install-channel.json` as the durable source of truth
  for channel, manager, install root, scope, and installed version.
- Portable/direct installs may update in place after explicit user consent.
- npm installs should defer to `npm update -g @spectacular-voyage/kato`.
- Installer-managed installs should hand off to the installer or `winget`.
- Keep the updater explicit: show target version/channel, verify
  checksum/signature, stop and restart the daemon only when required, and leave
  a short rollback window.

### Installer Channels

- Keep GitHub release archives as the packaging substrate even if npm remains
  the preferred user-facing install path.
- Add stable shell/PowerShell installer entrypoints that detect OS/arch,
  download the matching asset, verify checksum, install into a user-local
  program directory, and write install metadata.
- Windows should likely ship both a portable `.zip` and a per-user installer.
- Prefer a signed per-user MSI if tooling friction is acceptable; otherwise use
  a signed EXE installer.
- Consider WinGet only after the direct installer/binary story is stable.
- If stable "latest download" URLs matter, publish stable-name assets and an
  update manifest intentionally; GitHub will not synthesize them.

### Per-User OS-Native Background Integration

- Stay per-user: `systemd --user`, `launchd` LaunchAgents, and a Windows
  per-user startup mechanism before any machine-wide service.
- Keep Kato state under `~/.kato`; service-manager config should only point at
  executables, runtime root, and restart policy.
- Use fixed per-user identities such as `kato-daemon.service` and
  `com.spectacularvoyage.kato.daemon` rather than encoding raw usernames in
  durable unit names.
- Treat install/uninstall of these helpers as explicit commands, not silent
  side effects of package install.

## Explicit Non-Directions For Now

- Do not re-open a Deno-required installer channel.
- Do not move runtime state into OS-specific service-manager directories.
- Do not make machine-wide privileged services the default background model.
- Do not treat JSR as part of the executable distribution roadmap unless Kato
  grows a real supported library surface.
