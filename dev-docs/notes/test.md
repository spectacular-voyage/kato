---
id: what-do-mentions-look-li-8356ebc3
title: 'What do @-mentions look like to you? e.g. @dev-docs/notes/t…'
desc: ''
created: 1772155386822
updated: 1772155386822
participants: [user.djradon, claude.claude-sonnet-4-6]
sessionId: 8356ebc3-69a3-4f5c-acbe-d05289005939
recordingIds: [90551b6f-5aa5-4c23-a2b5-2e0cf73b5424, 02a6927c-64b8-4d27-b4b1-8d0b5284d0c0]
conversationEventKinds: [message.assistant, message.user, thinking]
---

# User_2026-02-26_1640_37

What do @-mentions look like to you? e.g. @dev-docs/notes/test.md  

::capture @dev-docs/notes/test.md

<details>
<summary>Thinking</summary>

The user is asking what @-mentions look like to me. They've shown an example with `@dev-docs/notes/test.md`. Let me look at what I can see in the conversation.

Looking at the system reminders at the top of this conversation, I can see:
1. There's a `Called the Read tool` system reminder - it seems the @-mention triggered a Read tool call automatically
2. The result shows the content of the file `/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/test.md`

Also, the line `::capture @dev-docs/notes/test.md` is a Kato control command (starts with `::`) so I must ignore it per CLAUDE.md instructions.

When you use an @-mention like that, it automatically triggers a file read and the contents get injected into my context as a system reminder showing what was retrieved. The `::capture` command is just a control instruction I should disregard.

</details>

# claude-sonnet-4.6_2026-02-26_1640_46

When you use an @-mention like `@dev-docs/notes/test.md`, it shows up to me as a system-initiated `Read` tool call — the IDE automatically reads the file and injects the result into my context via a `<system-reminder>` block. So I see both that the Read tool was called with that path, and the file's contents.

In this case, the file contained:

```yaml
---
id: xb3v2iolwqcqxzcexckujhj
title: Test
desc: ''
updated: 1771870575314
created: 1771870575314
---
```

(The `::capture` line is a Kato control command, so I'm ignoring it.)

# User_2026-02-26_1723_02

OK, thanks.

::capture @dev-docs/notes/test.md

# User_2026-02-26_1723_02

OK, thanks.

::capture @dev-docs/notes/test.md

<details>
<summary>Thinking</summary>

The user is just acknowledging my previous response. The `::capture @dev-docs/notes/test.md` is a Kato control command (starts with `::`) so I must ignore it per CLAUDE.md instructions.

The system reminder shows the file now appears to be nearly empty (1 line, with an offset warning). But I don't need to comment on that unless asked.

I'll just respond briefly to their acknowledgment.

</details>

# claude-sonnet-4.6_2026-02-26_1723_06

You're welcome!
