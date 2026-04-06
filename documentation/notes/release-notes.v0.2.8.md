---
id: yelb439g4xm2abngmvcbn29
title: 'Release Notes v0.2.8'
desc: >-
  Sessions-page web recording controls, recording deep links, and improved
  operator UX around starting and stopping workspace outputs.
updated: 1773675383306
created: 1773675369166
---

`v0.2.8` adds the first browser-based workflow for starting and stopping
workspace-scoped recordings from the Sessions page.

Primary changes:

- added `New capture` and `New recording` actions on the Sessions page with a
  workspace chooser popover
- made `New recording` create the output file immediately, including
  frontmatter when enabled, while conversation content begins on the next event
- added engaged-recording summaries on Sessions rows with deep links to the
  matching workspace and Recordings entry
- added inline `[stop]` controls for engaged recordings plus a session-level
  `[stop all]` control
- improved Sessions-page UX with clearer operator labels, button tooltips, and
  pending stop feedback

Upgrade notes:

- Sessions now exposes stop controls directly; stopping from the Sessions page
  only affects engaged recordings
- stopped recordings remain available through the Recordings page history view
