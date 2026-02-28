---
id: rqrupsu8yrshs2femj55rch
title: Feature Ideas
desc: ''
updated: 1772301830137
created: 1771724652182
---

- thinking and tools use should use, as default, the settings in config (defaults/general/workspace) but allow per-session overrids, maybe by adding flags to the "::" commands
- scan recent folders more recently, scan older folders (much) less frequency
- add scanning for .codex/.claude folders even if not initially present
- support for kimi, etc
- multiple recordings to one file 
- create a summary file (and/or decision log, maybe update a to-do file) on command
  - dangerous because AI/network
- "::seal" command : sign, hash, and close a file
  - tricky, because we can't write the hash into the file?
- web-based UI for status; surfacing history and logs; surfacing in-chat commands; tracking performance
- run-as-service on Windows; systemd/init.d on Linux; launchd on macOS
- Multi-destination recording
- support flag in in-chat comments, e.g. to start including thinking or tool use
- folder-based session-state and twin files (maybe just by year? or probably year-month)
- instead of "User_unknown-time" headings, we could number sequentially, or use the event IDs
- explicit support for running the daemon from multiple locations:
  - still should be able to keep status (and control?) the same
  - need to add a config item for where the sessions/twins are stored so they can be re-used
  - dangerous that if a common status/control is not used in the workspace config, multiple katos could overwrite each other :(, but maybe we can work around by daemon awareness somehow