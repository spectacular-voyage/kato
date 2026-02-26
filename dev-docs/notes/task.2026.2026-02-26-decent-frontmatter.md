---
id: ru04o3780vg0ell7chui1e5
title: 2026 02 26 Decent Frontmatter
desc: ''
updated: 1772124160537
created: 1772122600275
---

## User Story

As a Dendron user, I would like Kato to be able to generate better-than-Dendron frontmatter when creating output markdown files from scratch

## Requirements

- Existing Dendron fields are generated compatibly:
---
id: ru04o3780vg0ell7chui1e5
title: 2026 02 26 Decent Frontmatter
desc: ''
updated: 1772122670438
created: 1772122600275
---

  - for IDs, I'd like to use the slugified-conversation-snippet-<session short ID> if possible
  - For title, the conversation snippet
  - we can leave desc blank
  - obviously, updated=created on creation
- we'll add:
  - participants: in <provider.model> format for assistants, and best effort at a username
    - use config if specified
    - otherwise infer from home folder? Or maybe
  - sessionId:
  - recordingIds: single-line array, in case where multiple recordings go to one file 
  - tags, as a single-line array, can include ConversationKinds that are included 
- config changes:
  - includeFrontmatterInMarkdownRecordings boolean
  - addParticipantUsernameToFrontmatter boolean (default false)
  - defaultParticipantUsername string
  - includeConversationKinds boolean


