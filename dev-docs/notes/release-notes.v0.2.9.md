---
id: 4qcaj6qz75kzllz2x7bx9vem
title: 'Release Notes v0.2.9'
desc: >-
  Workspace display labels, Workspaces-page naming/username editing, and
  Recordings-page per-file controls with persisted recency.
updated: 1773853614689
created: 1773853614689
---

`v0.2.9` expands the browser-side operator workflow in two directions: richer
workspace labeling and a more durable, easier-to-scan Recordings page.

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
- persisted the last successful write time for each recording cycle so
  Recordings recency survives daemon restarts and stale/live gaps instead of
  depending entirely on live daemon state
- added inline `[stop]` controls for engaged recording rows and `[re-arm]`
  controls for stopped rows on the Recordings page
- polished Recordings rows so file, timestamps, workspace, and session metadata
  render on separate lines with the filename de-emphasized
- made Recordings session titles clickable alongside the short id and renamed
  idle engaged rows to `armed for recording` with `[disarm]` actions
- sorted Recordings rows by most recent write, stop, or start activity instead
  of grouping them by state first
- made fresh web-created captures show as `recording` immediately after the
  initial snapshot write, even before daemon live-session state catches up
- fixed a daemon/web metadata race that could make a freshly created capture
  disappear from Sessions/Recordings until the next metadata reconciliation
- made Recordings-page `Re-arm` reuse the exact saved file, fail fast if the
  file is missing, and preserve write-policy denial as a distinct error
- enforced single-writer-per-file behavior when starting or restarting a
  recording, so an already-engaged writer on the same path is stopped first

Upgrade notes:

- the Recordings page is now a per-file status/control surface rather than a
  cycle-history view; older cycles remain persisted but are not each rendered
  as their own row
- Recordings recency no longer depends on matching live daemon status; last
  successful write times now keep per-file ordering stable across restarts
- `Re-arm` is intentionally conservative: it reopens the exact saved file and
  refuses to continue if that file no longer exists or no longer passes policy
- capture behavior remains fresh-file-only and does not reuse existing output
  files
