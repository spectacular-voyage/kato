---
id: 583ef0d537b7329ad2d183b8
title: User Guide Recording
desc: ''
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

## Web Capture And Recording

The Sessions page in Kato Web can start a new capture or recording from a
discovered session. The Recordings page shows recording-output state per file,
including active outputs and stopped outputs that can be re-armed when the
saved file still exists and passes policy.

## Stopping

Use `::stop` to stop all active recordings from the chat, or
`::stop-<alias>` to stop one workspace output. In Kato Web, use stop controls
on Sessions or Recordings.

Stopping a recording does not delete the output file or the persisted session
twin.

## Output Formats

Markdown is the normal recording format. One-off exports can also use JSONL.

Markdown output can include frontmatter, participant information, Kato ids,
conversation event kinds, commentary, thinking, tool calls/results, and
decision metadata depending on shared and workspace writer settings.

## Secrets Redaction

Kato redacts common credential patterns before writing twins, recordings,
exports, or web snippets. The original provider transcript files are not
modified by Kato.
