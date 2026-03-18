---
id: 4qcaj6qz75kzllz2x7bx9vem
title: 'Release Notes v0.2.9'
desc: >-
  Workspace display labels, Workspaces-page naming/username editing, and
  Recordings-page stop / same-path restart controls.
updated: 1773853614689
created: 1773853614689
---

`v0.2.9` expands the browser-side operator workflow in two directions: richer
workspace labeling and direct Recordings-page lifecycle controls.

Primary changes:

- added optional workspace display labels that render as
  `<alias> (<displayName>)` across the web UI when a meaningful label is set
- added display-label entry during workspace registration from both the CLI and
  the Workspaces page
- added Workspaces-page editing for display labels plus per-workspace preferred
  usernames, while keeping username persistence in `kato-user-config.yaml`
- reformatted `kato workspace list` to show clearer per-workspace blocks and
  include display-label information
- changed the Recordings page to show the latest state per output file instead
  of expanding every recording cycle
- added inline `[stop]` controls for engaged recording rows and `[re-start]`
  controls for stopped rows on the Recordings page
- polished Recordings rows so file, timestamps, workspace, and session metadata
  render on separate lines with the filename de-emphasized
- made Recordings session titles clickable alongside the short id and renamed
  idle engaged rows to `armed for recording` with `[disarm]` actions
- made Recordings-page `Re-start` reuse the exact saved file, fail fast if the
  file is missing, and preserve write-policy denial as a distinct error
- enforced single-writer-per-file behavior when starting or restarting a
  recording, so an already-engaged writer on the same path is stopped first

Upgrade notes:

- the Recordings page is now a per-file status/control surface rather than a
  cycle-history view; older cycles remain persisted but are not each rendered
  as their own row
- `Re-start` is intentionally conservative: it reopens the exact saved file and
  refuses to continue if that file no longer exists or no longer passes policy
- capture behavior remains fresh-file-only and does not reuse existing output
  files
