---
id: rqrupsu8yrshs2femj55rch
title: Feature Ideas
desc: ''
updated: 1771972680606
created: 1771724652182
---

- each project/workspace folder can have its own .kato file/folder that specified where conversations go by default and filename patterns
  - extremely useful if all conversations go to the same place and should follow the same pattern
- scan recent folders more recently, scan older folders (much) less frequency
- add scanning for .codex/.claude folders even if not initially present
- handle recording of "choices" options and chosen option
- support for gemini, kimi, etc
- add an "interlocutors" YAML field, and maybe sessionId field as well. 
- create a summary file (and/or decision log, maybe update a to-do file) on command
- "::seal" command : sign, hash, and close a file
  - tricky, because we can't write the hash into the file?
- web-based UI for status; cleaning sessions, surfacing history and logs; surfacing in-chat commands; tracking performance
- run-as-service on Windows; systemd/init.d on Linux; launchd on macOS
- thinking and tools use should use, as default, the settings in config but allow per-session overrids, maybe by adding flags to the "::" commands
- switch config to YAML
- Multi-destination recording