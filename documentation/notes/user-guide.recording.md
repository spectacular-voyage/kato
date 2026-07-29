---
id: 583ef0d537b7329ad2d183b8
title: User Guide Recording
desc: ""
updated: 1781200000003
created: 1781200000003
---

## Concepts

- **Session**: a provider conversation Kato has discovered.
- **Twin**: Kato's persisted provider-agnostic event log for a session.
- **Capture**: write a full snapshot now, then keep recording future events.
- **Recording**: start writing future events from this point forward.
- **Export**: write a one-off output for a known session.

## In-Chat Commands

Put Kato control commands on their own line in a user message:

```text
::capture-<alias> [path]
::record-<alias> [path]
::export-<alias> [path]
::stop
::stop-<alias>
```

Examples:

```text
::capture-default
::record-default project-notes.md
::export-default exports/initial-snapshot.md
::stop-default
```

The alias chooses the registered workspace. The optional path chooses an output
destination relative to the workspace unless an explicit allowed path is
supported by policy.

Tell the AI assistant that lines beginning with `::` are Kato control commands
and should be ignored. Kato consumes the command; the model may still see it in
the provider chat.

## Automatic Workspace Recording

Workspace config can enable `autoRecordConversations`. When it is enabled for a registered workspace, Kato automatically starts a workspace-scoped recording for matching Claude conversations. Codex and Gemini conversations still require manual recording or capture.

By default a conversation matches when its provider working directory is inside the workspace root. Because workspace roots are usually notes vaults while conversations run at project repo roots, the workspace config can list `autoRecordRoots` — one directory per entry (absolute, `~`, or workspace-root-relative) — and a Claude conversation whose working directory is inside any listed root auto-records to that workspace. An empty or absent list keeps the workspace-root-only behavior. Matching is lexical; listed roots do not need to exist on disk.

Workspace config resolution failures no longer spam the audit log once per session per poll: each broken workspace logs once per distinct error and clears when the config is repaired. Auto-record only runs while the daemon is running in persistent mode.

## Web Capture And Recording

The Sessions page in Kato Web can start a new capture or recording from a
discovered session. The Recordings page shows recording-output state per file,
including active outputs and stopped outputs that can be re-armed when the
saved file still exists and passes policy.

When starting from Kato Web, the workspace chooser also lets you set the output title, filename snippet, and direct output tags before the file is created. The title and effective tags are written as markdown frontmatter when frontmatter is enabled. The filename snippet feeds `{snippetSlug}` in the selected workspace filename template; if the template does not use `{snippetSlug}`, the filename snippet does not affect the generated path.

Output tags can be edited later from the Recordings page. Workspace default tags remain additive; editing a recording row changes the direct per-output tags stored in session metadata, then Kato updates markdown frontmatter best-effort without rewriting the body.

## Stopping

Use `::stop` to stop all active recordings from the chat, or
`::stop-<alias>` to stop one workspace output. In Kato Web, use stop controls
on Sessions or Recordings.

Stopping a recording does not delete the output file or the persisted session
twin.

## Output Formats

Markdown is the normal recording format. One-off exports can also use JSONL.

Markdown output can include frontmatter, tags, participant information, Kato ids, conversation event kinds, commentary, thinking, tool calls/results, and decision metadata depending on shared and workspace writer settings.

## Secrets Redaction

Kato redacts common credential patterns before writing twins, recordings,
exports, or web snippets. The original provider transcript files are not
modified by Kato.
