---
id: dpyry3rtit2myhxzfr68zbn
title: 2026 02 22 Gemini Provider
desc: ''
updated: 1771786673216
created: 1771786673216
---


**Storage locations:**

- `~/.gemini/tmp/<project>/chats/session-<datetime>-<uuid>.json` — the actual conversation files
- `~/.gemini/tmp/<project>/logs.json` — a lightweight user-message-only log
- `~/.gemini/history/<project>/` — **not conversations** — these are git-committed code snapshots of the workspace

**Project naming**: `~/.gemini/projects.json` maps workspace paths to project names. Your `stenobot` project is named `"stenobot"`. Projects without an explicit name use a SHA256 hash of the project path as the directory name — no `.project_root` file in those dirs, so workspace root is indeterminate.

**Session file format** (key differences from Claude/Codex):

```json
{
  "sessionId": "uuid",
  "projectHash": "sha256hex",
  "startTime": "ISO8601",
  "messages": [
    {
      "id": "uuid",
      "timestamp": "ISO8601",
      "type": "user" | "gemini",
      "content": [{"text": "..."}],
      "toolCalls": [...],
      "thoughts": [...],
      "model": "...",
      "tokens": {...}
    }
  ]
}
```

**Critical implication for a Gemini provider in kato**: the format is **JSON, not JSONL** — one JSON document per session file with a `messages` array. Byte-offset-based incremental parsing (as used for Claude and Codex) won't work cleanly. The provider would need to track the last processed message index or ID instead, and re-parse the whole file on each poll. The `offset` in the provider contract would map to a message array index rather than a file byte offset.

**Workspace root resolution**: read `~/.gemini/tmp/<project>/.project_root` if present. For named projects, cross-reference `~/.gemini/projects.json`. Hash-named projects without `.project_root` have no reliable workspace path.